# Chord Whale Flow

Follows tokens that several large wallets are net buying, from Chord's trade tape.

An example agent built on [Chord](https://getchord.xyz), the trading API and on-chain data index for agents. Paper by default. Not financial advice.

## Run it

Node 20.12 or newer. Nothing to install and no key for paper mode.

```bash
git clone https://github.com/tuantqse90/chord-whale-flow
cd chord-whale-flow
node index.js                    # one cycle on base
node index.js --chain arbitrum   # another chain
node index.js --loop             # every 10 min (--interval <seconds> to change)
```

The report prints to the terminal and is saved to `state/report.md`.

## What it does each cycle

1. Reads the chain's 24h token board and keeps the 20 most traded tokens (anchors, stablecoins and tokens Chord's scam screen hides are skipped).
2. Reads each token's trade tape and keeps trades of `MIN_TRADE_USD` or more in the last `WINDOW_HOURS`. On busy tokens the tape is read three pages deep, and the report says how many hours that covered.
3. Sums buys and sells per wallet. A token is a follow when whales are net buying at least `MIN_NET_BUY_USD`, at least two of them, and no single wallet is net selling more than $25k. Wallets that buy and sell about the same amount are counted as churners, not conviction.
4. Sells a holding when whales turn net sellers, runs take-profit / stop-loss / trailing / time exits, then buys the top one or two follows.

## Sample run (16 October 2026, paper)

```text
# Whale Flow on Base, 2026-10-16T14:25:25.732Z
Trades of $5.0k or more in the last 2h on the 20 most traded tokens. Follow = whales net buying ≥ $50.0k, at least 2 of them, no single dump above $25.0k.
Busy tokens trade more than three pages of prints in the window, so "Hours read" says how far back the tape was actually read.

| Token | Hours read | Whale trades | Whale net | Buyers | Sellers | Biggest dump | Churners | Top buyer | Follow |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cbBTC | 0.1 | 14 | $66.1k | 11 | 2 | $5.8k | 0 | 0x4640…9152 $12.1k | YES |
| AMZNc | 2.0 | 78 | $39.1k | 17 | 14 | $88.5k | 6 | 0x344f…3212 $57.2k |  |
| MSTRc | 0.5 | 20 | $34.0k | 10 | 4 | $10.1k | 1 | 0x7692…28b9 $8.6k |  |
| SOL | 0.3 | 4 | $23.7k | 4 | 0 | $0 | 0 | 0xb326…b89a $6.9k |  |
| MSFTc | 1.9 | 7 | $16.9k | 3 | 2 | $5.9k | 1 | 0xcc76…8b82 $12.2k |  |
| NVDAc | 0.3 | 6 | $14.0k | 3 | 1 | $5.6k | 0 | 0x7815…0572 $7.2k |  |

Book: PAPER · open 1 · unrealized $0 · realized $0 · equity $1.0k
```

## Chains

Ethereum, Base, Arbitrum, BNB Chain, Avalanche, Monad, Robinhood and Arc (keys `ethereum`, `base`, `arbitrum`, `bnb`, `avalanche`, `monad`, `robinhood`, `arc`). Pick one with `CHAIN=` in `.env` or `--chain`.

## Settings

Copy `.env.example` to `.env`. Every setting is optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `CHAIN` | `base` | Chain key or id. |
| `TOKENS_SCANNED` | `20` | How many of the most traded tokens to read. |
| `MIN_TRADE_USD` | `5000` | Smallest trade counted as a whale trade. |
| `WINDOW_HOURS` | `2` | Look-back window. |
| `MIN_NET_BUY_USD` | `50000` | Whale net buying needed to follow. |
| `LIVE` | `0` | 1 = sign and send real transactions with your key. Anything else = paper. |
| `PRIVATE_KEY` | — | Live only. A fresh hot wallet with small funds; the key never leaves this machine. |
| `RPC_URL` | — | Live only. Your RPC endpoint for the chain; transactions are dry-run and sent through it. |
| `MAX_TRADE_USD` | `25` | Largest single entry. |
| `MAX_OPEN_POSITIONS` | `5` | Entries are refused above this. |
| `MAX_SLIPPAGE_BPS` | `100` | Slippage sent with every quote (100 = 1%). |
| `MAX_PRICE_IMPACT_PCT` | `1.5` | Quotes with more price impact are refused. |
| `DAILY_LOSS_LIMIT_USD` | `50` | No new entries for the rest of the UTC day once realized losses reach this. |
| `PAPER_BANKROLL_USD` | `1000` | Starting cash of the paper book. |
| `CHORD_API` | `https://api.getchord.xyz/v1` | Chord API base URL. |
| `CHORD_API_KEY` | — | Optional. Not needed for anything this agent calls. |
| `CHORD_RPM` | `50` | Client-side request cap per minute (anonymous callers get 60 per IP). |

## Paper and live

**Paper (default).** Every quote is a real route from Chord's router; the fill is simulated at the quoted output, after Chord's fee. The book lives in `state/`.

**Live.** Set `LIVE=1`, `PRIVATE_KEY` and `RPC_URL`, then `npm install` (adds `viem`). Each trade goes: Chord quote → unsigned transaction from Chord (`POST /v1/swap`) → approval of Chord's router if needed → dry run on your RPC → your key signs → send → measure the tokens that actually arrived. Chord never takes custody of keys or funds.

Every entry passes the same risk gate: `MAX_TRADE_USD`, `MAX_OPEN_POSITIONS`, `MAX_PRICE_IMPACT_PCT` and `DAILY_LOSS_LIMIT_USD`. Use a fresh wallet with small funds: the cash leg is the chain's main dollar stablecoin, plus a little native coin for gas.

## Built on Chord

Chord calls this agent makes:

- `GET /v1/chains` (paths and anchors for every chain)
- the chain's token board (`/v1/chains/{chain}/tokens`, `/v1/rh/tokens`, …)
- the token's trade tape (`/v1/chains/{chain}/token/{address}/trades`, `/v1/tokens/trades/{address}`)
- `GET /v1/quote` and, in live mode, `POST /v1/swap`

No key is needed: anonymous callers get 60 requests a minute per IP, and the client in `lib/chord.js` stays under that, caches reads briefly and backs off on 429.

- Docs and OpenAPI: https://getchord.xyz/docs
- Hosted MCP server for LLM agents (quotes, unsigned swaps, token boards, trades, wallet PnL; no key): `https://api.getchord.xyz/v1/mcp`. In Claude Code: `claude mcp add --transport http chord https://api.getchord.xyz/v1/mcp`
- More templates: https://github.com/tuantqse90/chord-agent-templates

## Files

```text
index.js          the agent
lib/chord.js      Chord client: rate limit, cache, chain paths from GET /v1/chains
lib/portfolio.js  paper / live book, risk gate, exits
lib/wallet.js     your key and RPC (live mode only)
lib/config.js     settings from .env
lib/util.js       formatting, --loop runner
.actor/, actor.js the same agent packaged as an Apify Actor
```

## Disclaimer

Example code, not financial advice. Backtests and paper results do not predict real results. In live mode this program signs real transactions with your key and can lose money.

## License

MIT
