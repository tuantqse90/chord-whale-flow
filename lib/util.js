import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, CONFIG } from './config.js';

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const safe = (x, d = 0) => (Number.isFinite(Number(x)) && x !== null ? Number(x) : d);
export const pct = (x, digits = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%` : '—');
export const usd = (x) => {
  if (!Number.isFinite(Number(x)) || x === null) return '—';
  x = Number(x);
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(x / 1e3).toFixed(1)}k`;
  if (a >= 1) return `$${x.toFixed(2)}`;
  if (a === 0) return '$0';
  return `$${x.toPrecision(3)}`;
};
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

export function table(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

// Writes ./state/<name> (the last report), so a scheduler or a bot can pick it up.
export function writeReport(name, markdown) {
  const dir = path.join(ROOT, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), markdown);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

// Runs fn once, or forever with --loop [--interval seconds]. --chain overrides CHAIN.
export async function runAgent(name, fn, defaultIntervalSec = 300, { readOnly = false } = {}) {
  const args = parseArgs();
  if (args.chain) CONFIG.chain = String(args.chain);
  const interval = Number(args.interval || defaultIntervalSec) * 1000;
  console.log(`[${name}] ${readOnly ? 'read-only: this agent never trades' : CONFIG.live ? 'LIVE: signing with your key' : 'paper mode: real Chord quotes, simulated fills'}`);
  do {
    const t0 = Date.now();
    try {
      await fn(args);
    } catch (err) {
      console.error(`[${name}] cycle failed:`, err.message);
      if (!args.loop) process.exitCode = 1;
    }
    if (args.loop) {
      const wait = Math.max(5000, interval - (Date.now() - t0));
      console.log(`[${name}] next cycle in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  } while (args.loop);
}
