// Thin client for the Chord API (https://getchord.xyz/docs). No key needed: anonymous callers get 60 requests a
// minute per IP, so the client keeps under that, caches GETs briefly and backs off on 429 / 5xx.
// Every chain-specific path comes from GET /v1/chains, so the same code runs on every chain Chord serves.
import { CONFIG, AGENT } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = `chord-template/${AGENT}`;

// ---- client-side rate limit (sliding one-minute window)
const stamps = [];
async function acquire() {
  for (;;) {
    const t = Date.now();
    while (stamps.length && t - stamps[0] > 60_000) stamps.shift();
    if (stamps.length < CONFIG.requestsPerMinute) { stamps.push(t); return; }
    await sleep(60_000 - (t - stamps[0]) + 50);
  }
}

// ---- in-memory GET cache
const cache = new Map();
const TTL = [[/^\/(quote|swap)/, 0], [/^\/chains$/, 3600_000], [/^\/lp\/plan|^\/lp\/simulate/, 600_000], [/trades/, 20_000], [/./, 45_000]];
const ttlFor = (p) => TTL.find(([re]) => re.test(p))[1];

export async function request(method, path, { query, body, retries = 4 } = {}) {
  const url = new URL(CONFIG.api + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const ttl = method === 'GET' ? ttlFor(path) : 0;
  const hit = ttl ? cache.get(url.href) : undefined;
  if (hit && Date.now() - hit.at <= ttl) return hit.body;

  const headers = { accept: 'application/json', 'user-agent': UA };
  if (CONFIG.apiKey) headers['x-api-key'] = CONFIG.apiKey;
  if (body) headers['content-type'] = 'application/json';

  for (let attempt = 0; ; attempt++) {
    await acquire();
    let res;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (attempt >= retries) throw new Error(`chord ${method} ${path}: ${err.message}`);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const json = await res.json();
      if (ttl) cache.set(url.href, { at: Date.now(), body: json });
      return json;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      let wait = 700 * 2 ** attempt;
      if (res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        wait = reset ? reset * 1000 - Date.now() + 250 : 60_000 - (Date.now() % 60_000) + 250;
        console.warn(`[chord] rate limited on ${path}, waiting ${Math.ceil(wait / 1000)}s`);
      }
      await sleep(Math.min(Math.max(wait, 1000), 65_000));
      continue;
    }
    let payload = {};
    try { payload = await res.json(); } catch { /* not json */ }
    const err = new Error(`chord ${method} ${path} -> ${res.status} ${payload.error || ''} ${payload.message || ''}`.trim());
    err.status = res.status;
    err.code = payload.error;
    throw err;
  }
}

export const get = (path, query) => request('GET', path, { query });

// ---- chains

let chainList;
export async function chains() {
  chainList ??= (await get('/chains')).chains;
  return chainList;
}

// Accepts a key ("base"), an id ("8453") or a name ("Base"). EVM chains only: the agents trade through Chord's router.
export async function resolveChain(selector) {
  const all = (await chains()).filter((c) => c.addressFormat === 'evm');
  const s = String(selector).trim().toLowerCase();
  const c = all.find((x) => x.key === s || String(x.id) === s || x.name.toLowerCase() === s || String(x.short).toLowerCase() === s);
  if (!c) throw new Error(`unknown chain "${selector}". Chains: ${all.map((x) => x.key).join(', ')}`);
  const anchors = c.anchors.map((a) => ({ ...a, address: a.address.toLowerCase() }));
  const stable = anchors.find((a) => a.stableUsd === 1);
  const wrapped = anchors.find((a) => a.address === c.wrappedNative.toLowerCase()) || { address: c.wrappedNative.toLowerCase(), symbol: `W${c.native.symbol}`, decimals: 18 };
  return {
    ...c, anchors, stable, wrapped,
    label: c.key === 'robinhood' ? 'Robinhood' : c.name,
    anchorSet: new Set(anchors.map((a) => a.address)),
    has: (cap) => Boolean(c.capabilities[cap]),
  };
}

// Calls one capability of a chain as GET /v1/chains describes it, filling {address} / {wallet} in the path.
export function cap(chain, name, params = {}, query = {}) {
  const spec = chain.capabilities[name];
  if (!spec) throw new Error(`${name} is not served on ${chain.name}`);
  const path = spec.path.replace(/^\/v1/, '').replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params[k] ?? ''));
  return request(spec.method, path, { query: { chain: chain.id, ...(spec.query || {}), ...query } });
}

// ---- data helpers that read the same on every chain

// 24h token board, most traded first. Rows: address, symbol, decimals, priceUsd, change24hPct, volume24h,
// buyVolume24h / sellVolume24h (when the chain has them), trades24h, traders (some chains), liquidityUsd (some chains).
export async function board(chain, { limit = 200, sort = 'volume' } = {}) {
  const r = await cap(chain, 'tokens', {}, { limit, sort });
  return (r.tokens || []).map((t) => ({ ...t, address: t.address.toLowerCase() }));
}

// Newest trades of one token, normalised to { ts, wallet, side, usd, priceUsd, dex }.
// minUsd filters on the server where the route supports it, otherwise here. Stops at `sinceTs`, `maxRows` or
// `maxPages`. The returned array carries `scannedFrom`: the oldest trade time it actually read.
export async function trades(chain, address, { minUsd = 0, sinceTs = 0, maxRows = 400, maxPages = 3 } = {}) {
  const spec = chain.capabilities.trades;
  if (!spec) throw new Error(`trades are not served on ${chain.name}`);
  const out = [];
  let scannedFrom = Infinity;
  const norm = (t) => ({ ts: Number(t.ts ?? t.t), wallet: String(t.wallet || t.trader || '').toLowerCase(), side: t.side, usd: Number(t.usd ?? t.amountUsd ?? 0), priceUsd: Number(t.priceUsd ?? 0), dex: t.dex });
  const serverMin = spec.path.startsWith('/v1/tokens/trades');
  const pageSize = serverMin ? 100 : 200;
  let before;
  for (let page = 1; page <= maxPages && out.length < maxRows; page++) {
    const query = serverMin ? { min: minUsd || undefined, limit: pageSize, page } : { limit: pageSize, before };
    const r = await cap(chain, 'trades', { address }, query);
    const rows = (r.trades || []).map(norm);
    if (rows.length) scannedFrom = Math.min(scannedFrom, rows[rows.length - 1].ts);
    out.push(...rows.filter((t) => t.ts >= sinceTs && t.usd >= minUsd));
    if (rows.length < pageSize || rows[rows.length - 1].ts < sinceTs) { scannedFrom = Math.min(scannedFrom, sinceTs); break; }
    if (!serverMin) {
      if (!r.nextBefore) break; // the Arc route has no cursor
      before = r.nextBefore;
    }
  }
  out.scannedFrom = Number.isFinite(scannedFrom) ? Math.max(scannedFrom, sinceTs) : sinceTs;
  return out;
}

// Turns a list of symbols or 0x addresses into { address, symbol, decimals } rows using the chain's board, the
// Robinhood stock list and token search. Unknown entries come back in `missing`.
export async function findTokens(chain, list, { extraRows = [] } = {}) {
  const rows = [...extraRows, ...(await board(chain, { limit: 200 }))];
  if (chain.key === 'robinhood') {
    try { rows.push(...((await get('/rh/stocks')).stocks || []).map((t) => ({ ...t, address: t.address.toLowerCase() }))); } catch { /* optional */ }
  }
  const found = [], missing = [];
  for (const raw of list) {
    const want = String(raw).trim();
    if (!want) continue;
    const isAddr = /^0x[0-9a-fA-F]{40}$/.test(want);
    let hit = rows.filter((t) => (isAddr ? t.address === want.toLowerCase() : String(t.symbol).toUpperCase() === want.toUpperCase()))
      .sort((a, b) => Number(b.volume24h || 0) - Number(a.volume24h || 0))[0];
    if (!hit && chain.has('search')) {
      try {
        const r = await cap(chain, 'search', {}, { q: want });
        hit = (r.tokens || []).map((t) => ({ ...t, address: t.address.toLowerCase() }))
          .find((t) => (isAddr ? t.address === want.toLowerCase() : String(t.symbol).toUpperCase() === want.toUpperCase()));
      } catch { /* not found */ }
    }
    if (!hit && !isAddr) {
      const a = chain.anchors.find((x) => x.symbol.toUpperCase() === want.toUpperCase());
      if (a) hit = { address: a.address, symbol: a.symbol, decimals: a.decimals };
    }
    if (hit) found.push(hit); else missing.push(want);
  }
  return { found, missing };
}

// Hourly (or other tf) candles: [{ t, o, h, l, c, v }], oldest first.
export async function candles(chain, address, { tf = '1h', limit = 200 } = {}) {
  const r = await cap(chain, 'candles', {}, { token: address, tf, limit });
  return [...(r.candles || [])].sort((a, b) => a.t - b.t);
}

// ---- Chord's router: quote -> unsigned transaction

export const quote = (chain, { inputMint, outputMint, amount, slippageBps = CONFIG.maxSlippageBps }) =>
  request('GET', '/quote', { query: { chain: chain.id, inputMint, outputMint, amount: String(amount), slippageBps } });

export const buildSwap = (chain, quoteResponse, userPublicKey) =>
  request('POST', '/swap', { body: { quoteResponse, userPublicKey, chain: chain.id, slippageBps: quoteResponse.slippageBps } });

// Runs fn over items with bounded concurrency; a failed item becomes { __error }.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (err) { out[idx] = { __error: err.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}
