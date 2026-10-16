// Whale Flow: follows tokens that several large wallets are net buying.
// Reads the trade tape of the most traded tokens on a chain through Chord, keeps trades of at least MIN_TRADE_USD,
// sums them per wallet over the last few hours and flags tokens where two or more whales are net buying and no
// single whale is dumping. In paper mode it buys the strongest one or two and manages exits.
import { CONFIG, STABLE_SYMBOLS } from './lib/config.js';
import { resolveChain, board, trades, mapLimit } from './lib/chord.js';
import { Portfolio } from './lib/portfolio.js';
import { safe, usd, short, table, writeReport, runAgent } from './lib/util.js';

const P = {
  tokens: Number(process.env.TOKENS_SCANNED || 20),
  minTradeUsd: Number(process.env.MIN_TRADE_USD || 5_000),
  windowHours: Number(process.env.WINDOW_HOURS || 2),
  minNetBuyUsd: Number(process.env.MIN_NET_BUY_USD || 50_000),
  minWhales: 2,             // distinct wallets net buying
  dumpUsd: 25_000,          // one wallet net selling more than this vetoes the entry
  exits: { tp: 0.15, sl: 0.07, trail: 0.07, maxHoldHours: 48 },
};

export function aggregate(rows, minTradeUsd = P.minTradeUsd) {
  const wallets = new Map();
  for (const t of rows) {
    if (!t.wallet) continue;
    const w = wallets.get(t.wallet) || { wallet: t.wallet, buyUsd: 0, sellUsd: 0, trades: 0 };
    w[t.side === 'buy' ? 'buyUsd' : 'sellUsd'] += safe(t.usd);
    w.trades++;
    wallets.set(t.wallet, w);
  }
  const ws = [...wallets.values()].map((w) => ({ ...w, net: w.buyUsd - w.sellUsd })).sort((a, b) => b.net - a.net);
  const buyers = ws.filter((w) => w.net > minTradeUsd);
  const sellers = ws.filter((w) => w.net < -minTradeUsd);
  return {
    net: ws.reduce((a, w) => a + w.net, 0),
    buyers: buyers.length,
    sellers: sellers.length,
    biggestDump: sellers.length ? -sellers[sellers.length - 1].net : 0,
    topBuyers: buyers.slice(0, 3),
    // a wallet that buys and sells about the same amount is market making or wash, not conviction
    churners: ws.filter((w) => w.buyUsd > 0 && w.sellUsd > 0 && Math.abs(w.net) < 0.2 * (w.buyUsd + w.sellUsd)).length,
  };
}

async function cycle() {
  const chain = await resolveChain(CONFIG.chain || 'base');
  const pf = new Portfolio(chain, { name: 'whale-flow' });
  const tokens = await board(chain, { limit: 100 });
  const top = tokens
    .filter((t) => !chain.anchorSet.has(t.address) && !STABLE_SYMBOLS.has(String(t.symbol).toUpperCase()) && !t.screen)
    .slice(0, P.tokens);

  const since = Math.floor(Date.now() / 1000) - P.windowHours * 3600;
  const tapes = await mapLimit(top, 3, (t) => trades(chain, t.address, { minUsd: P.minTradeUsd, sinceTs: since, maxRows: 600, maxPages: 3 }));
  const nowS = Date.now() / 1000;
  const rows = top.map((t, i) => (tapes[i]?.__error ? null : { t, n: tapes[i].length, hours: (nowS - tapes[i].scannedFrom) / 3600, ...aggregate(tapes[i]) }))
    .filter(Boolean)
    .sort((a, b) => b.net - a.net);
  const follow = rows.filter((r) => r.net >= P.minNetBuyUsd && r.buyers >= P.minWhales && r.biggestDump < P.dumpUsd && r.buyers > r.sellers);

  // Exit early if whales flipped to net selling on something we hold.
  for (const pos of pf.positions) {
    const r = rows.find((x) => x.t.address === pos.token.toLowerCase());
    if (r && r.net < -P.minNetBuyUsd / 2) await pf.sell(pos.token, `whales net selling ${usd(r.net)}`);
  }
  const prices = Object.fromEntries(tokens.map((t) => [t.address, t.priceUsd]));
  const marks = await pf.manageExits({ ...P.exits, prices });
  for (const r of follow.slice(0, 2)) {
    await pf.buy({ token: r.t.address, symbol: r.t.symbol, decimals: r.t.decimals, sizeUsd: CONFIG.maxTradeUsd, meta: { whaleNet: r.net, whales: r.buyers } });
  }

  const md = [
    `# Whale Flow on ${chain.label}, ${new Date().toISOString()}`,
    `Trades of ${usd(P.minTradeUsd)} or more in the last ${P.windowHours}h on the ${top.length} most traded tokens. Follow = whales net buying ≥ ${usd(P.minNetBuyUsd)}, at least ${P.minWhales} of them, no single dump above ${usd(P.dumpUsd)}.`,
    'Busy tokens trade more than three pages of prints in the window, so "Hours read" says how far back the tape was actually read.',
    '',
    table(['Token', 'Hours read', 'Whale trades', 'Whale net', 'Buyers', 'Sellers', 'Biggest dump', 'Churners', 'Top buyer', 'Follow'],
      rows.slice(0, 15).map((r) => [r.t.symbol, r.hours.toFixed(1), r.n, usd(r.net), r.buyers, r.sellers, usd(r.biggestDump), r.churners,
        r.topBuyers[0] ? `${short(r.topBuyers[0].wallet)} ${usd(r.topBuyers[0].net)}` : '—', follow.includes(r) ? 'YES' : ''])),
    '',
    `Book: ${pf.line(marks)}`,
  ].join('\n');
  writeReport('report.md', md);
  console.log(md);
  return { report: md, rows: rows.map((r) => ({ chain: chain.key, token: r.t.address, symbol: r.t.symbol, hoursRead: Number(r.hours.toFixed(2)), whaleTrades: r.n, whaleNetUsd: Math.round(r.net), buyers: r.buyers, sellers: r.sellers, biggestDumpUsd: Math.round(r.biggestDump), churners: r.churners, follow: follow.includes(r) })) };
}

export { cycle };

if (import.meta.url === `file://${process.argv[1]}`) runAgent('whale-flow', cycle, 600);
