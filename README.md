# btc-race-bot-makefun

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/samidyt/btc-race-bot-makefun/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/samidyt/btc-race-bot-makefun/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A dip-and-trend BTC trading bot for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It trades Coinbase Wrapped BTC (CBBTC) against USDC, minute by minute, in a replay of its on-chain Orca prices — paper money only, nothing traded for real.

## Strategy

A round trip costs about 30 bps (4 bps fee + 2 bps modelled slippage + price impact each way), while a typical 1-minute bar moves only ~4 bps. So the bot trades only on high-conviction setups and sits in cash the rest of the time:

1. **Dip-buy.** After a sharp 30-bar drop (>150 bps) it buys the V-reversal, a pattern that shows up repeatedly in BTC microstructure: crashes bounce. It exits on a +100 bps rebound, a 100 bps trailing stop, or a 120-bar timeout.
2. **Trend.** When EMA(60) crosses above EMA(240) while EMA(240) is rising over 60 bars and the close is above it, it rides the multi-hour trend. It exits on a +100 bps take-profit, the cross back, or a 200 bps trailing stop. The take-profit matters because the cross back is slow: on the dev window the trend trade peaked at +$13.66 of open profit and gave most of it back before the cross fired; locking in +100 bps beats riding it down.
3. **Discipline.** A 60-bar cooldown after any exit keeps it out of chop, and no new entries are taken in the last 30 minutes of the 24h window, when a trade has no time to play out before the forced flatten.

On the published dev window (a -2.8% day) this made 2 round trips for +$14.44 net on $1,000 starting capital, max drawdown 0.64%. Buy-and-hold lost $31.63 on the same window and the kit's EMA-cross baseline lost $148.16.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout) via the kit's TypeScript SDK shim, vendored byte-for-byte under `vendor/`. Standard library only (Node 22, type stripping). Every decision is a pure function of the bar stream: no clock, no environment, no randomness, so two runs produce byte-identical action logs.

## Grade it locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=svtazsn5&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
