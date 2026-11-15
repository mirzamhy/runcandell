/**
 * Backtest runner. Pure: bars in, trades and equity out.
 *
 * Timing (no lookahead):
 *   1. signal(i) is read after strategy bar i has closed;
 *   2. it is acted on at the OPEN of bar i + 1 (buy at Ask + slippage, sell at Bid - slippage);
 *   3. SL/TP are then checked on the M1 candles inside each strategy bar, so the order in which
 *      levels were touched is known to the minute (same-minute ties still count as SL).
 */
import type { Bar } from '../data.ts'
import { Account, TradeError, type Candle, type ClosedTrade, type Side } from '../engine/account.ts'
import type { Signal, SignalFn, StrategySpec } from './strategy.ts'
import { instrument } from '../instruments.ts'

export interface BtTrade extends ClosedTrade {
  /** USD lost if the initial SL is hit (null without SL) */
  risk: number | null
  /** pnl / risk */
  r: number | null
  /** strategy bars held */
  bars: number
}

export interface RunInput {
  spec: StrategySpec
  /** instrument name, for contract size and quote currency */
  symbol?: string
  /** strategy timeframe bars, including warm-up history before the test start */
  bars: Bar[]
  tfSec: number
  /** M1 bars covering the test range, or null to execute on the strategy bars themselves */
  m1: Bar[] | null
  signal: SignalFn
  /** ATR(14) on the strategy bars, for ATR-based SL/TP */
  atr: ArrayLike<number>
  /** first strategy bar to trade (bars before it only warm up indicators) */
  start: number
  /** stop before the bar opening at or after this time */
  end: number
  /** hour of day (0–23) in the chosen zone, for the entry-hours filter */
  hourOf: (t: number) => number
}

export interface RunResult {
  trades: BtTrade[]
  /** equity at each strategy bar close */
  eqTime: number[]
  eqValue: number[]
  /** signals that could not be traded, by reason */
  skipped: Record<string, number>
  bars: number
  from: number
  to: number
}

const LOT_STEP = 0.01

export function runBacktest(inp: RunInput): RunResult {
  const { spec, bars, m1, signal, atr } = inp
  const inst = instrument(inp.symbol ?? 'XAUUSD')
  const contract = inst.contract
  const jpy = inst.quote === 'JPY'
  const acc = new Account({
    quoteJpy: jpy,
    balance: spec.balance,
    leverage: spec.leverage,
    contractSize: contract,
    commissionPerLot: spec.commission,
    stopOutLevel: 0.5,
  })
  acc.recordEquity = false

  const trades: BtTrade[] = []
  const meta = new Map<number, { bar: number; risk: number | null }>()
  const skipped: Record<string, number> = {}
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1)
  let k = inp.start
  acc.onEvent = (e) => {
    if (e.kind !== 'close') return
    const m = meta.get(e.trade.id)
    const risk = m?.risk ?? null
    trades.push({ ...e.trade, risk, r: risk ? e.trade.pnl / risk : null, bars: m ? k - m.bar : 0 })
  }

  /** Make the account's "now" price the open of a bar (optionally shifted by slippage). */
  const quoteAt = (b: Bar, shift = 0) => {
    const px = b.open + shift
    acc.last = { time: b.time, open: px, high: px, low: px, close: px, spread: b.spread }
  }

  const inHours = (t: number) => {
    if (!spec.hours.on) return true
    const h = inp.hourOf(t)
    const { from, to } = spec.hours
    return from <= to ? h >= from && h < to : h >= from || h < to
  }

  const enter = (sig: NonNullable<Signal['enter']>, b: Bar, a: number) => {
    const side: Side = sig.side
    if (!inHours(b.time)) return skip('outside entry hours')
    const slip = side === 'buy' ? spec.slippage : -spec.slippage
    const entry = side === 'buy' ? b.open + b.spread + slip : b.open + slip
    const dir = side === 'buy' ? 1 : -1

    let sl: number | null = sig.sl ?? null
    if (sl === null && spec.sl.kind !== 'none') {
      const dist = spec.sl.kind === 'atr' ? a * spec.sl.value : spec.sl.value
      if (!(dist > 0)) return skip('ATR not ready')
      sl = entry - dir * dist
    }
    let tp: number | null = sig.tp ?? null
    if (tp === null && spec.tp.kind !== 'none') {
      const dist =
        spec.tp.kind === 'atr' ? a * spec.tp.value : spec.tp.kind === 'rr' ? (sl === null ? NaN : Math.abs(entry - sl) * spec.tp.value) : spec.tp.value
      if (!(dist > 0)) return skip(spec.tp.kind === 'rr' ? 'R:R TP needs an SL' : 'ATR not ready')
      tp = entry + dir * dist
    }

    let lots = spec.sizing.value
    const risk1 = sl === null ? null : (Math.abs(entry - sl) * contract) / (jpy ? entry : 1) // USD per 1 lot
    if (spec.sizing.kind === 'risk') {
      if (!risk1) return skip('risk % needs an SL')
      lots = Math.floor((acc.balance * spec.sizing.value) / 100 / risk1 / LOT_STEP + 1e-9) * LOT_STEP
      if (lots < LOT_STEP) return skip('lots below 0.01')
    }
    lots = Math.min(100, Math.round(lots / LOT_STEP) * LOT_STEP)

    quoteAt(b, slip)
    try {
      const p = acc.market(side, lots, sl, tp)
      meta.set(p.id, { bar: k, risk: risk1 === null ? null : risk1 * lots })
    } catch (e) {
      if (e instanceof TradeError) skip(e.message)
      else throw e
    }
  }

  const eqTime: number[] = []
  const eqValue: number[] = []
  let pending: Signal | null = null
  let pendingAtr = NaN
  let mi = 0
  let tested = 0
  let lastBar: Candle | null = null

  for (; k < bars.length; k++) {
    const b = bars[k]
    if (b.time >= inp.end) break
    const next = k + 1 < bars.length ? bars[k + 1].time : b.time + inp.tfSec
    tested++
    quoteAt(b)

    if (spec.maxBars > 0)
      for (const p of [...acc.positions]) if (k - (meta.get(p.id)?.bar ?? k) >= spec.maxBars) acc.closePosition(p.id, 'time')

    if (pending) {
      const pos = acc.positions[0]
      const x = pending.exit
      if (x && pos && (x === 'all' || (x === 'long') === (pos.side === 'buy'))) acc.closePosition(pos.id, 'signal')
      const en = pending.enter
      if (en) {
        const cur = acc.positions[0]
        if (!cur) enter(en, b, pendingAtr)
        else if (cur.side !== en.side && spec.reverse) {
          quoteAt(b)
          acc.closePosition(cur.id, 'signal')
          enter(en, b, pendingAtr)
        }
      }
      pending = null
    }

    // walk the minute candles inside this bar
    let walked = 0
    if (m1) {
      while (mi < m1.length && m1[mi].time < b.time) mi++
      while (mi < m1.length && m1[mi].time < next) {
        acc.onBar(m1[mi])
        lastBar = m1[mi]
        mi++
        walked++
      }
    }
    if (!walked) {
      acc.onBar(b)
      lastBar = b
    }

    eqTime.push(b.time)
    eqValue.push(acc.equity())
    pending = signal(k)
    pendingAtr = atr[k]
  }

  if (lastBar) {
    acc.last = lastBar
    acc.closeAll('end')
    if (eqValue.length) eqValue[eqValue.length - 1] = acc.balance
  }

  return {
    trades,
    eqTime,
    eqValue,
    skipped,
    bars: tested,
    from: bars[inp.start]?.time ?? 0,
    to: eqTime[eqTime.length - 1] ?? 0,
  }
}
