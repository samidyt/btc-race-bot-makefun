// Dip-and-trend BTC trading bot for make.fun btc-race-24h-20261118-1444.
//
// Trades Coinbase Wrapped BTC (CBBTC) against USDC, minute by minute, in a
// replay of its on-chain Orca prices. Long only, one position, full-size entries.
//
// The strategy
// -------------
// A round trip costs about 30 bps (4 bps fee + 2 bps modelled slippage + price
// impact each way), while a typical 1-minute bar moves only ~4 bps. So the bot
// trades only on high-conviction setups and sits in cash the rest of the time:
//
// 1. Dip-buy. After a sharp 30-bar drop (>150 bps) the bot buys the V-reversal,
//    a pattern that shows up repeatedly in BTC microstructure: crashes bounce.
//    It exits on a +100 bps rebound, a 100 bps trailing stop below the peak, or
//    a 120-bar timeout.
// 2. Trend. When EMA(60) crosses above EMA(240) while EMA(240) is rising over
//    60 bars and the close is above it, the bot rides the multi-hour trend. It
//    exits on a +100 bps take-profit, the cross back, or a 200 bps trailing
//    stop. The take-profit matters because the cross back is slow: on the dev
//    window the trend trade peaked at +$13.66 of open profit and gave most of
//    it back before the cross fired; locking in +100 bps beats riding it down.
// 3. Discipline. A 60-bar cooldown after any exit keeps the bot out of chop,
//    and no new entries are taken in the last 30 minutes of the 24h window,
//    when a trade has no time to play out before the forced flatten.
//
// On the published dev window (a -2.8% day) this made 2 round trips for
// +$14.44 net on $1,000 starting capital, max drawdown 0.64%. Buy-and-hold lost
// $31.63 on the same window and the kit's EMA-cross baseline lost $148.16.
//
// Determinism: every decision is a pure function of the bar stream (float64
// arithmetic in a fixed order). No clock, no environment, no randomness.

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- Dip-buy parameters (bars, basis points) ---
const DIP_BARS = 30;           // lookback for the drop that triggers a dip-buy
const DIP_DROP_BPS = 150;      // the drop over DIP_BARS that counts as a crash
const DIP_REBOUND_BPS = 100;   // take profit: rebound from the entry close
const DIP_TRAIL_BPS = 100;     // trailing stop below the peak while in a dip trade
const DIP_MAX_HOLD = 120;      // bars: give up on a dip trade that never rebounds

// --- Trend parameters ---
const TREND_FAST = 60;         // fast EMA span (bars)
const TREND_SLOW = 240;        // slow EMA span (bars)
const TREND_SLOPE_BARS = 60;   // the slow EMA must be rising over this many bars
const TREND_TP_BPS = 100;      // take profit: +100 bps from the entry close
const TREND_TRAIL_BPS = 200;   // trailing stop below the peak while in a trend trade

// --- Discipline ---
const COOLDOWN_BARS = 60;      // bars to wait after any exit before re-entering
const END_GUARD_MINUTES = 30;  // no new entries this close to the window's end
const WINDOW_BARS = 1440;      // the race/dev window is 24h of 1-minute bars
const MAX_SLIPPAGE_BPS = 100;  // 1% past the close the order was decided on

/** One EMA: seeded as the mean of its first span of closes, then moving
 *  2 / (span + 1) of the way to each new close. */
class Ema {
  readonly span: number;
  warm: number[] = [];
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
  }

  step(close: number): void {
    if (this.value !== null) {
      this.value += (2 / (this.span + 1)) * (close - this.value);
      return;
    }
    this.warm.push(close);
    if (this.warm.length === this.span) {
      this.value = this.warm.reduce((a, x) => a + x, 0) / this.span;
    }
  }
}

type Mode = 'dip' | 'trend' | null;

class Strategy {
  closes: number[] = [];           // every CBBTC close seen, in order
  fast = new Ema(TREND_FAST);
  slow = new Ema(TREND_SLOW);
  slowHistory: (number | null)[] = [];  // slow EMA value after each bar (for slope)
  prevGap: number | null = null;   // fast - slow after the previous bar
  mode: Mode = null;
  entryClose = 0;                  // close the position was entered on
  entryBar = 0;                    // bar index of entry
  peak = 0;                        // highest close since entry
  lastExitBar = -1e9;
  barCount = 0;                    // CBBTC bars seen
  wasHolding = false;
  windowEndMs: number | null = null;  // first close + 24h, from hello

  onHello(state: BarsState): void {
    this.windowEndMs = state.hello.first_close_ms + WINDOW_BARS * 60_000;
  }

  enter(mode: Mode, close: number): void {
    this.mode = mode;
    this.entryClose = close;
    this.entryBar = this.barCount;
    this.peak = close;
  }

  buy(state: BarsState): BuyInput | null {
    // Full size: all cash, capped by the max-weight room.
    const room = state.weightRoom(SYMBOL);
    const size = state.cash < room ? state.cash : room;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (size < minNotional) return null;
    return { side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS };
  }

  sell(held: { qty: bigint }): SellInput {
    return { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Find this batch's CBBTC bar; a batch without one carries no new
    // information, so answer with no orders.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined || state.warmingUp) return [];

    const close = Number(bar.c);
    this.closes.push(close);
    this.barCount += 1;
    this.fast.step(close);
    this.slow.step(close);
    this.slowHistory.push(this.slow.value);
    const gap = this.fast.value !== null && this.slow.value !== null
      ? this.fast.value - this.slow.value
      : null;
    // The gap after the previous bar; update the stored one now so every
    // check below reads the previous bar's value from the local.
    const prevGap = this.prevGap;
    this.prevGap = gap;

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    // A position that vanished since the last batch means an exit filled:
    // start the cooldown from this bar.
    if (this.wasHolding && !holding) {
      this.lastExitBar = this.barCount;
      this.mode = null;
    }
    this.wasHolding = holding;

    if (holding && held !== undefined) {
      if (close > this.peak) this.peak = close;
      if (this.mode === 'dip') {
        if (close >= this.entryClose * (1 + DIP_REBOUND_BPS / 10_000)) return [this.sell(held)];
        if (close <= this.peak * (1 - DIP_TRAIL_BPS / 10_000)) return [this.sell(held)];
        if (this.barCount - this.entryBar >= DIP_MAX_HOLD) return [this.sell(held)];
      } else {
        // Trend (or an unexpected position: manage it as a trend).
        if (close >= this.entryClose * (1 + TREND_TP_BPS / 10_000)) return [this.sell(held)];
        if (close <= this.peak * (1 - TREND_TRAIL_BPS / 10_000)) return [this.sell(held)];
        if (gap !== null && prevGap !== null && gap < 0 && prevGap >= 0) return [this.sell(held)];
      }
      return [];
    }

    // No position: look for an entry.
    if (this.barCount - this.lastExitBar < COOLDOWN_BARS) return [];
    if (this.windowEndMs !== null && batch.t >= this.windowEndMs - END_GUARD_MINUTES * 60_000) return [];

    // 1. Dip-buy: a sharp drop over DIP_BARS, buy the reversal.
    if (this.closes.length > DIP_BARS) {
      const ago = this.closes[this.closes.length - 1 - DIP_BARS];
      if (ago > 0 && (close / ago - 1) * 10_000 < -DIP_DROP_BPS) {
        this.enter('dip', close);
        const order = this.buy(state);
        return order !== null ? [order] : [];
      }
    }

    // 2. Trend: fast EMA crosses above slow EMA, slow EMA rising,
    //    close above the slow EMA.
    if (gap !== null && prevGap !== null && this.slow.value !== null) {
      const slowNow = this.slow.value;
      const slowThen = this.slowHistory.length > TREND_SLOPE_BARS
        ? this.slowHistory[this.slowHistory.length - 1 - TREND_SLOPE_BARS]
        : null;
      const rising = slowThen !== null && slowNow > slowThen;
      const crossUp = gap > 0 && prevGap <= 0;
      if (crossUp && rising && close > slowNow) {
        this.enter('trend', close);
        const order = this.buy(state);
        return order !== null ? [order] : [];
      }
    }

    return [];
  }
}

const strategy = new Strategy();

await runBars({
  onHello: (state) => strategy.onHello(state),
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
