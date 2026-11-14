/**
 * Duel rules shared by the server (authoritative) and the browser.
 * Pure functions; the server imports this file directly, so keep it erasable TypeScript
 * (no enums / parameter properties) and use `.ts` import paths.
 *
 * A round: a cut point in the M1 data. Players see every timeframe up to the cut (the forming
 * higher-timeframe candle is rebuilt from M1, so no future high/low leaks), with prices rebased
 * `p' = (p - anchor) * k + 1000` and dates moved by whole weeks (weekday and hour survive, the real
 * date does not). They buy or sell at the cut with a mandatory stop, or skip. The next
 * `runMinutes` M1 candles decide the result in R (multiples of the initial risk).
 */
import type { Bar, TF } from '../types.ts'
import { atr } from '../indicators/calc.ts'
import { Account, type CloseReason } from './account.ts'

export const DUEL_TFS: TF[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']
/** same as TF_SECONDS in data.ts (not imported: data.ts needs Vite at runtime) */
export const TF_SEC: Record<TF, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 }
export const SNAPSHOT_COUNT: Record<TF, number> = { M1: 600, M5: 500, M15: 400, M30: 300, H1: 300, H4: 300, D1: 250 }

/** Last index with bars[i].time <= t, or -1. */
export function floorIdx(bars: Bar[], t: number): number {
  let lo = 0
  let hi = bars.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].time <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** One candle from consecutive M1 candles. */
export function aggregate(parts: Bar[], time: number): Bar {
  const out: Bar = { ...parts[0], time }
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i]
    if (b.high > out.high) out.high = b.high
    if (b.low < out.low) out.low = b.low
    out.close = b.close
    out.volume += b.volume
    out.spread = b.spread
  }
  return out
}

/**
 * Bars of one timeframe as seen at the close of M1 candle `cut`: finished candles from the
 * pyramid, plus the forming candle rebuilt from M1 up to the cut.
 */
export function snapshotTF(tfBars: Bar[], m1: Bar[], cut: number, count: number, isM1: boolean): Bar[] {
  if (isM1) {
    const i = floorIdx(m1, cut)
    return m1.slice(Math.max(0, i - count + 1), i + 1)
  }
  const k = floorIdx(tfBars, cut)
  if (k < 0) return []
  const start = tfBars[k].time
  const parts = m1.filter((b) => b.time >= start && b.time <= cut)
  const done = tfBars.slice(Math.max(0, k - count + 1), k)
  return parts.length ? [...done, aggregate(parts, start)] : done
}

// ---------- normalisation ----------

export interface Norm {
  anchor: number
  k: number
  /** seconds subtracted from every time (whole weeks) */
  shift: number
}

const WEEK = 7 * 86400
/** Monday 2000-01-03 00:00 UTC: shifted times land near here */
const REF = 946857600

export function makeNorm(cutBar: Bar, k: number): Norm {
  return { anchor: cutBar.close, k, shift: Math.floor((cutBar.time - REF) / WEEK) * WEEK }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000
export const normPrice = (n: Norm, p: number) => r3((p - n.anchor) * n.k + 1000)
export const realPrice = (n: Norm, p: number) => (p - 1000) / n.k + n.anchor
export const normTime = (n: Norm, t: number) => t - n.shift

export function normBar(n: Norm, b: Bar): Bar {
  return {
    time: b.time - n.shift,
    open: normPrice(n, b.open),
    high: normPrice(n, b.high),
    low: normPrice(n, b.low),
    close: normPrice(n, b.close),
    volume: b.volume,
    spread: r3(b.spread * n.k),
  }
}

// ---------- decisions ----------

/** Smallest allowed stop distance (real price): 0.5 × ATR(14) on M1 or 3 × spread. */
export function minStop(m1UpToCut: Bar[]): number {
  const tail = m1UpToCut.slice(-200)
  const a = atr(
    tail.map((b) => b.high),
    tail.map((b) => b.low),
    tail.map((b) => b.close),
    14,
  )
  const last = tail[tail.length - 1]
  const v = a[a.length - 1]
  return Math.max(Number.isFinite(v) ? 0.5 * v : 0, 3 * last.spread)
}

export type DuelSide = 'buy' | 'sell' | 'skip'

export type DuelOrderType = 'market' | 'limit' | 'stop'

export interface Decision {
  side: DuelSide
  /** market fills at the cut; limit/stop wait at `price` until the run reaches it */
  type?: DuelOrderType
  price?: number | null
  sl?: number | null
  tp?: number | null
}

export interface Outcome {
  side: DuelSide
  type?: DuelOrderType
  /** order price for limit/stop */
  price?: number | null
  r: number
  /** unfilled: the limit/stop price was never reached, 0R */
  reason: CloseReason | 'skip' | 'timeout' | 'unfilled'
  entry: number | null
  exit: number | null
  exitTime: number | null
  sl: number | null
  tp: number | null
}

/** Entry prices at the cut: buy at Ask, sell at Bid. */
export const entryOf = (cut: Bar, side: 'buy' | 'sell') => (side === 'buy' ? cut.close + cut.spread : cut.close)

/** The pending type that fits a price: below the market a buy is a limit, above it a stop (sells mirrored). */
export function pendingTypeFor(cut: Bar, side: 'buy' | 'sell', price: number): 'limit' | 'stop' {
  return (price < entryOf(cut, side)) === (side === 'buy') ? 'limit' : 'stop'
}

/** Validation message (Indonesian) or null. Prices are real (not normalised). */
export function checkDecision(d: Decision, cut: Bar, stopMin: number, fmt: (dist: number) => string = (x) => x.toFixed(2)): string | null {
  if (d.side === 'skip') return null
  if (d.side !== 'buy' && d.side !== 'sell') return 'Pilih buy, sell, atau skip.'
  const type = d.type ?? 'market'
  if (type !== 'market' && type !== 'limit' && type !== 'stop') return 'Jenis order tidak dikenal.'
  if (typeof d.sl !== 'number' || !Number.isFinite(d.sl)) return 'SL wajib diisi.'
  const dir = d.side === 'buy' ? 1 : -1
  let entry = entryOf(cut, d.side)
  if (type === 'market') {
    // the SL must be on the far side of the price the position closes at (Bid for buys, Ask for sells)
    const closeAt = d.side === 'buy' ? cut.close : cut.close + cut.spread
    if ((closeAt - d.sl) * dir <= 0) return d.side === 'buy' ? 'SL buy harus di bawah harga.' : 'SL sell harus di atas harga.'
  } else {
    if (typeof d.price !== 'number' || !Number.isFinite(d.price) || d.price <= 0) return 'Harga order wajib diisi.'
    if (Math.abs(d.price - entry) < 1e-9 || pendingTypeFor(cut, d.side, d.price) !== type) {
      const where = (type === 'limit') === (d.side === 'buy') ? 'di bawah' : 'di atas'
      return `${d.side === 'buy' ? 'Buy' : 'Sell'} ${type} harus ${where} harga ${d.side === 'buy' ? 'Ask' : 'Bid'}.`
    }
    entry = d.price
    if ((entry - d.sl) * dir <= 0) return d.side === 'buy' ? 'SL buy harus di bawah harga order.' : 'SL sell harus di atas harga order.'
  }
  if (Math.abs(entry - d.sl) < stopMin - 1e-9) return `SL terlalu dekat. Jarak minimal ${fmt(stopMin)}.`
  if (d.tp !== null && d.tp !== undefined) {
    if (!Number.isFinite(d.tp)) return 'TP tidak valid.'
    if ((d.tp - entry) * dir <= 0) return d.side === 'buy' ? 'TP buy harus di atas harga entry.' : 'TP sell harus di bawah harga entry.'
  }
  return null
}

/** Play a decision through the candles after the cut. Exits at SL, TP, or the last close. */
export function runDecision(cut: Bar, future: Bar[], d: Decision): Outcome {
  if (d.side === 'skip') return { side: 'skip', r: 0, reason: 'skip', entry: null, exit: null, exitTime: null, sl: null, tp: null }
  const type = d.type ?? 'market'
  const acc = new Account({ balance: 1e12, leverage: 1000, contractSize: 100, commissionPerLot: 0, stopOutLevel: 0 })
  acc.recordEquity = false
  acc.onBar({ time: cut.time, open: cut.close, high: cut.close, low: cut.close, close: cut.close, spread: cut.spread })
  // 1R = planned distance: entry at the cut (market) or the order price (limit/stop); slippage shows in R
  let planned: number
  if (type === 'market') planned = acc.market(d.side, 1, d.sl ?? null, d.tp ?? null).entry
  else {
    acc.pending(d.side, type, 1, d.price as number, d.sl ?? null, d.tp ?? null)
    planned = d.price as number
  }
  const base = { side: d.side, type, price: type === 'market' ? null : (d.price as number) }
  for (const b of future) {
    acc.onBar(b)
    if (!acc.positions.length && !acc.orders.length) break
  }
  if (!acc.history.length && !acc.positions.length) return { ...base, r: 0, reason: 'unfilled', entry: null, exit: null, exitTime: null, sl: d.sl ?? null, tp: d.tp ?? null }
  if (acc.positions.length) acc.closeAll('time')
  const t = acc.history[0]
  // R from prices, not money: P&L is rounded to cents, which is coarse for small prices (EURUSD)
  const move = d.side === 'buy' ? t.exit - t.entry : t.entry - t.exit
  const risk = Math.abs(planned - (d.sl as number))
  return { ...base, r: Math.round((move / risk) * 100) / 100 || 0, reason: t.reason === 'manual' ? 'time' : t.reason, entry: t.entry, exit: t.exit, exitTime: t.closeTime, sl: t.sl, tp: t.tp }
}

/**
 * A usable cut inside `m1`: needs `runMinutes` candles after it without a long market break
 * (weekend, daily close), so the round never "runs" across a gap.
 */
export function findCut(m1: Bar[], startIndex: number, runMinutes: number): number {
  for (let i = Math.max(1, startIndex); i + runMinutes < m1.length; i++) {
    if (m1[i + runMinutes].time - m1[i].time <= runMinutes * 60 * 1.25) return i
  }
  return -1
}
