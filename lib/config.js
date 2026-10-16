// Settings for this agent. Reads ./.env when it exists (Node >= 20.12), then the process environment.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
export const AGENT = String(pkg.name || 'agent').replace(/^chord-/, '');

export const CONFIG = {
  api: (process.env.CHORD_API || 'https://api.getchord.xyz/v1').replace(/\/$/, ''),
  apiKey: process.env.CHORD_API_KEY || '',
  chain: process.env.CHAIN || '',
  live: process.env.LIVE === '1',
  privateKey: process.env.PRIVATE_KEY || '',
  rpcUrl: process.env.RPC_URL || '',
  maxTradeUsd: num('MAX_TRADE_USD', 25),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 5),
  maxSlippageBps: num('MAX_SLIPPAGE_BPS', 100),
  maxPriceImpactPct: num('MAX_PRICE_IMPACT_PCT', 1.5),
  dailyLossLimitUsd: num('DAILY_LOSS_LIMIT_USD', 50),
  paperBankrollUsd: num('PAPER_BANKROLL_USD', 1000),
  requestsPerMinute: num('CHORD_RPM', 50),
};

export const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'USDT0', 'USDG', 'DAI', 'USDE', 'PYUSD', 'USD1', 'FDUSD', 'BUSD', 'USDC.E', 'USDT.E', 'USDBC', 'AUSD', 'MUSD']);
