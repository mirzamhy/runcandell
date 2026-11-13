/** Backtest statistics. Pure functions over trades and the bar-close equity curve. */
import type { BtTrade } from './run.ts'

export interface Metrics {
  start: number
  final: number
  net: number
  netPct: number
  trades: number
  wins: number
  winRate: number
  grossWin: number
  grossLoss: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  largestWin: number
  largestLoss: number
  /** average USD per trade */
  expectancy: number
  /** average R over trades that had a stop */
  avgR: number
  maxDd: number
  maxDdPct: number
  /** annualised, from daily equity returns */
  sharpe: number
  maxLossStreak: number
  avgBars: number
  long: { trades: number; net: number; winRate: number }
  short: { trades: number; net: number; winRate: number }
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0)
const r2 = (n: number) => Math.round(n * 100) / 100

function side(trades: BtTrade[]) {
  return {
    trades: trades.length,
    net: r2(sum(trades.map((t) => t.pnl))),
    winRate: trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : 0,
  }
}

export function metrics(trades: BtTrade[], eqTime: number[], eqValue: number[], start: number): Metrics {
  const pnl = trades.map((t) => t.pnl)
  const wins = pnl.filter((x) => x > 0)
  const losses = pnl.filter((x) => x < 0)
  const grossWin = sum(wins)
  const grossLoss = -sum(losses)
  const net = r2(sum(pnl))

  // drawdown on the equity curve (includes floating P/L at bar closes)
  let peak = start
  let maxDd = 0
  let maxDdPct = 0
  for (const v of eqValue) {
    if (v > peak) peak = v
    if (peak - v > maxDd) maxDd = peak - v
    if (peak > 0 && (peak - v) / peak > maxDdPct) maxDdPct = (peak - v) / peak
  }

  // Sharpe from daily returns (last equity of each UTC day)
  const daily: number[] = []
  let day = -1
  for (let i = 0; i < eqTime.length; i++) {
    const d = Math.floor(eqTime[i] / 86400)
    if (d !== day) {
      daily.push(eqValue[i])
      day = d
    } else daily[daily.length - 1] = eqValue[i]
  }
  const rets: number[] = []
  let prev = start
  for (const v of daily) {
    rets.push(prev > 0 ? v / prev - 1 : 0)
    prev = v
  }
  let sharpe = NaN
  if (rets.length >= 2) {
    const mean = sum(rets) / rets.length
    const sd = Math.sqrt(sum(rets.map((x) => (x - mean) ** 2)) / (rets.length - 1))
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : NaN
  }

  let streak = 0
  let maxLossStreak = 0
  for (const x of pnl) {
    streak = x < 0 ? streak + 1 : 0
    maxLossStreak = Math.max(maxLossStreak, streak)
  }

  const withR = trades.filter((t) => t.r !== null)
  return {
    start,
    final: r2(start + net),
    net,
    netPct: start > 0 ? net / start : 0,
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    grossWin: r2(grossWin),
    grossLoss: r2(grossLoss),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    largestWin: wins.length ? Math.max(...wins) : 0,
    largestLoss: losses.length ? Math.min(...losses) : 0,
    expectancy: trades.length ? net / trades.length : 0,
    avgR: withR.length ? sum(withR.map((t) => t.r!)) / withR.length : NaN,
    maxDd: r2(maxDd),
    maxDdPct,
    sharpe,
    maxLossStreak,
    avgBars: trades.length ? sum(trades.map((t) => t.bars)) / trades.length : 0,
    long: side(trades.filter((t) => t.side === 'buy')),
    short: side(trades.filter((t) => t.side === 'sell')),
  }
}

/** Curve for drawing: at most `max` points, keeping each bucket's lowest point so drawdowns stay visible. */
export function downsample(t: number[], v: number[], max = 1200): { t: number[]; v: number[] } {
  if (v.length <= max) return { t: [...t], v: [...v] }
  const size = v.length / max
  const ot: number[] = []
  const ov: number[] = []
  for (let b = 0; b < max; b++) {
    const lo = Math.floor(b * size)
    const hi = Math.min(v.length, Math.floor((b + 1) * size))
    let j = lo
    for (let i = lo; i < hi; i++) if (v[i] < v[j]) j = i
    // the last bucket ends exactly on the final value
    if (b === max - 1) j = v.length - 1
    ot.push(t[j])
    ov.push(v[j])
  }
  return { t: ot, v: ov }
}

export interface BreakdownRow {
  key: string
  trades: number
  winRate: number
  net: number
}

/** Group trades by a key of their entry time (hour, weekday, session). */
export function breakdown(trades: BtTrade[], keys: string[], keyOf: (t: BtTrade) => string): BreakdownRow[] {
  const rows = new Map(keys.map((k) => [k, { key: k, trades: 0, wins: 0, net: 0 }]))
  for (const t of trades) {
    const r = rows.get(keyOf(t))
    if (!r) continue
    r.trades++
    if (t.pnl > 0) r.wins++
    r.net += t.pnl
  }
  return [...rows.values()].map((r) => ({ key: r.key, trades: r.trades, winRate: r.trades ? r.wins / r.trades : 0, net: r2(r.net) }))
}

/** Market session of a UTC time, by the hour the trade opened (simple fixed UTC windows). */
export function sessionOf(t: number): string {
  const h = new Date(t * 1000).getUTCHours()
  if (h >= 12 && h < 16) return 'London + New York'
  if (h >= 7 && h < 12) return 'London'
  if (h >= 16 && h < 21) return 'New York'
  return 'Asia'
}
export const SESSIONS = ['Asia', 'London', 'London + New York', 'New York']
