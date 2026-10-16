// Book + execution.
//  Paper (default): quotes are real Chord routes, fills are simulated at the quoted output. No key, no wallet.
//  Live (LIVE=1 + PRIVATE_KEY + RPC_URL): Chord quote -> unsigned tx from Chord -> dry run on your RPC -> your key
//  signs -> send -> measure what actually arrived. Chord never takes custody of keys or funds.
// Every entry passes the same risk gate: size cap, max open positions, price-impact cap, daily loss stop.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CONFIG, ROOT } from './config.js';
import { quote, buildSwap } from './chord.js';
import { usd, pct } from './util.js';

const today = () => new Date().toISOString().slice(0, 10);

export class Portfolio {
  // chain = resolveChain(...) result; the chain's first $1 anchor is the cash leg.
  constructor(chain, { name = 'book' } = {}) {
    this.chain = chain;
    this.cash = chain.stable;
    if (!this.cash) throw new Error(`${chain.name} has no $1 anchor to trade from`);
    this.file = path.join(ROOT, 'state', `${name}-${chain.key}.json`);
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.state = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, 'utf8'))
      : { mode: CONFIG.live ? 'live' : 'paper', cashUsd: CONFIG.paperBankrollUsd, positions: {}, closed: [], realizedPnlUsd: 0, daily: { date: today(), realizedUsd: 0 } };
    if (this.state.daily.date !== today()) this.state.daily = { date: today(), realizedUsd: 0 };
  }

  save() { writeFileSync(this.file, JSON.stringify(this.state, null, 2)); }
  get positions() { return Object.values(this.state.positions); }
  has(token) { return Boolean(this.state.positions[token.toLowerCase()]); }
  note(msg) { console.log(`[${this.chain.key}] ${msg}`); }

  blockReason(token, sizeUsd) {
    if (token.toLowerCase() === this.cash.address) return 'that is the cash token';
    if (this.has(token)) return 'already holding';
    if (this.positions.length >= CONFIG.maxOpenPositions) return `max ${CONFIG.maxOpenPositions} open positions`;
    if (-this.state.daily.realizedUsd >= CONFIG.dailyLossLimitUsd) return `daily loss limit ${usd(CONFIG.dailyLossLimitUsd)} hit`;
    if (!CONFIG.live && this.state.cashUsd < sizeUsd) return `paper cash ${usd(this.state.cashUsd)} < ${usd(sizeUsd)}`;
    return null;
  }

  async buy({ token, symbol, decimals = 18, sizeUsd, meta = {} }) {
    sizeUsd = Math.min(sizeUsd, CONFIG.maxTradeUsd);
    const blocked = this.blockReason(token, sizeUsd);
    if (blocked) { this.note(`skip BUY ${symbol}: ${blocked}`); return null; }
    const amountIn = BigInt(Math.floor(sizeUsd * 10 ** Math.min(this.cash.decimals, 9))) * 10n ** BigInt(Math.max(0, this.cash.decimals - 9));
    const q = await quote(this.chain, { inputMint: this.cash.address, outputMint: token, amount: amountIn });
    const check = checkQuote(q);
    if (check) { this.note(`skip BUY ${symbol}: ${check}`); return null; }

    let qtyRaw = netOutput(q);
    let tx = null;
    if (CONFIG.live) ({ received: qtyRaw, hash: tx } = await executeLive(this.chain, q, this.cash.address, token));
    else this.state.cashUsd -= sizeUsd;
    const qty = Number(qtyRaw) / 10 ** decimals;
    const entryPrice = sizeUsd / qty;
    this.state.positions[token.toLowerCase()] = { token, symbol, decimals, qtyRaw: qtyRaw.toString(), costUsd: sizeUsd, entryPrice, peakPrice: entryPrice, openedAt: Date.now(), route: routeLabel(q), tx, meta };
    this.note(`BUY ${symbol} ${usd(sizeUsd)} @ ${usd(entryPrice)} via ${routeLabel(q)}, impact ${q.priceImpactPct}%${tx ? ` tx ${tx}` : ' (paper)'}`);
    this.save();
    return this.state.positions[token.toLowerCase()];
  }

  // What the position would sell for through the router right now (falls back to a mark price).
  async exitValueUsd(pos, fallbackPrice) {
    try {
      const q = await quote(this.chain, { inputMint: pos.token, outputMint: this.cash.address, amount: pos.qtyRaw });
      if (q.routePlan?.length) return Number(netOutput(q)) / 10 ** this.cash.decimals;
    } catch { /* fall through */ }
    return fallbackPrice ? (Number(pos.qtyRaw) / 10 ** pos.decimals) * fallbackPrice : NaN;
  }

  async sell(token, reason) {
    const pos = this.state.positions[token.toLowerCase()];
    if (!pos) return null;
    const q = await quote(this.chain, { inputMint: pos.token, outputMint: this.cash.address, amount: pos.qtyRaw });
    if (!q.routePlan?.length) { this.note(`cannot SELL ${pos.symbol}: no route (${q.noRouteReason || 'unknown'})`); return null; }
    let outRaw = netOutput(q);
    let tx = null;
    if (CONFIG.live) ({ received: outRaw, hash: tx } = await executeLive(this.chain, q, pos.token, this.cash.address));
    const proceeds = Number(outRaw) / 10 ** this.cash.decimals;
    const pnl = proceeds - pos.costUsd;
    if (!CONFIG.live) this.state.cashUsd += proceeds;
    this.state.realizedPnlUsd += pnl;
    this.state.daily.realizedUsd += pnl;
    delete this.state.positions[token.toLowerCase()];
    this.state.closed = [...this.state.closed.slice(-199), { ...pos, closedAt: Date.now(), proceeds, pnl, reason, exitTx: tx }];
    this.note(`SELL ${pos.symbol} -> ${usd(proceeds)}, PnL ${usd(pnl)} (${pct((pnl / pos.costUsd) * 100)}), ${reason}${tx ? ` tx ${tx}` : ' (paper)'}`);
    this.save();
    return { proceeds, pnl };
  }

  // Take-profit, stop-loss, trailing stop, time stop. Returns the positions still open with their value.
  async manageExits({ tp = 0.2, sl = 0.08, trail = 0.1, maxHoldHours = 48, prices = {} } = {}) {
    const open = [];
    for (const pos of this.positions) {
      const value = await this.exitValueUsd(pos, prices[pos.token.toLowerCase()]);
      if (!Number.isFinite(value)) { open.push({ ...pos, value: NaN, ret: NaN }); continue; }
      const price = value / (Number(pos.qtyRaw) / 10 ** pos.decimals);
      pos.peakPrice = Math.max(pos.peakPrice || pos.entryPrice, price);
      const ret = value / pos.costUsd - 1;
      const fromPeak = price / pos.peakPrice - 1;
      const ageH = (Date.now() - pos.openedAt) / 3600_000;
      let reason = null;
      if (ret >= tp) reason = `take-profit ${pct(ret * 100)}`;
      else if (ret <= -sl) reason = `stop-loss ${pct(ret * 100)}`;
      else if (ret > 0.03 && fromPeak <= -trail) reason = `trailing stop ${pct(fromPeak * 100)} from peak`;
      else if (ageH >= maxHoldHours) reason = `time stop ${ageH.toFixed(1)}h`;
      if (reason) await this.sell(pos.token, reason);
      else open.push({ ...pos, value, ret });
    }
    this.save();
    return open;
  }

  summary(marks = []) {
    const marked = new Map(marks.filter((m) => Number.isFinite(m.value)).map((m) => [m.token.toLowerCase(), m.value]));
    const openValue = this.positions.reduce((s, p) => s + (marked.get(p.token.toLowerCase()) ?? p.costUsd), 0);
    const openCost = this.positions.reduce((s, p) => s + p.costUsd, 0);
    return {
      mode: CONFIG.live ? 'LIVE' : 'PAPER',
      cashUsd: this.state.cashUsd,
      openPositions: this.positions.length,
      unrealizedPnlUsd: openValue - openCost,
      realizedPnlUsd: this.state.realizedPnlUsd,
      equityUsd: CONFIG.live ? null : this.state.cashUsd + openValue,
      trades: this.state.closed.length,
    };
  }

  line(marks = []) {
    const s = this.summary(marks);
    const m = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
    return `${s.mode} · open ${s.openPositions} · unrealized ${m(s.unrealizedPnlUsd)} · realized ${m(s.realizedPnlUsd)}${s.equityUsd != null ? ` · equity ${m(s.equityUsd)}` : ''}`;
  }
}

// Output after Chord's fee when the fee is taken in the output token.
export function netOutput(q) {
  const out = BigInt(q.outputAmount || 0);
  const fee = q.feeMint && q.feeMint.toLowerCase() === String(q.outputMint).toLowerCase() ? BigInt(q.feeAmount || 0) : 0n;
  return out > fee ? out - fee : 0n;
}

export function checkQuote(q) {
  if (!q.routePlan?.length || q.outputAmount === '0') return `no route (${q.noRouteReason || 'unknown'})`;
  const impact = Math.abs(Number(q.priceImpactPct));
  if (impact > CONFIG.maxPriceImpactPct) return `price impact ${impact.toFixed(2)}% > ${CONFIG.maxPriceImpactPct}%`;
  return null;
}

export const routeLabel = (q) => (q.routePlan || []).map((r) => `${r.swapInfo?.dex}(${r.percent}%)`).join('+') || 'none';

// Live: unsigned tx from Chord, approve the router if needed, dry run, sign with your key, send, measure.
export async function executeLive(chain, q, tokenIn, tokenOut) {
  const w = await import('./wallet.js');
  const me = w.address(chain);
  const built = await buildSwap(chain, q, me);
  const tx = built.transaction || built.tx || built;
  await w.ensureAllowance(chain, tokenIn, tx.to, q.inputAmount);
  try {
    await w.publicClient(chain).call({ account: me, to: tx.to, data: tx.data, value: BigInt(tx.value || 0) });
  } catch (err) {
    throw new Error(`simulation reverted: ${err.shortMessage || err.message}`);
  }
  const before = await w.balanceOf(chain, tokenOut, me);
  const { hash } = await w.sendTx(chain, tx);
  const after = await w.balanceOf(chain, tokenOut, me);
  return { hash, received: after - before };
}
