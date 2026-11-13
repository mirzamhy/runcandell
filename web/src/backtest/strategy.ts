/**
 * Strategy definitions for the backtester: a no-code rule set or a small JavaScript function.
 * Both compile to a SignalFn evaluated on the CLOSE of strategy bar i; the runner acts on the
 * OPEN of bar i + 1, so a strategy can never trade on a price it has not seen yet.
 */
import type { Bar, TF } from '../data.ts'
import type { Side } from '../engine/account.ts'
import * as ta from '../indicators/calc.ts'
import { tradingDay } from '../time.ts'

export type Op = 'gt' | 'lt' | 'xup' | 'xdown'
export interface Operand {
  src: string
  p: number[]
}
export interface Cond {
  a: Operand
  op: Op
  b: Operand
}

export interface StrategySpec {
  name: string
  mode: 'rules' | 'code'
  tf: TF
  long: Cond[]
  short: Cond[]
  exitLong: Cond[]
  exitShort: Cond[]
  code: string
  /** stop distance: fixed price distance (USD) or ATR(14) multiple */
  sl: { kind: 'none' | 'price' | 'atr'; value: number }
  /** target: price distance, ATR multiple, or multiple of the stop distance (R:R) */
  tp: { kind: 'none' | 'price' | 'atr' | 'rr'; value: number }
  /** fixed lots, or % of balance risked per trade (needs a stop) */
  sizing: { kind: 'fixed' | 'risk'; value: number }
  /** only open trades between these hours (in the chosen time zone); from > to wraps midnight */
  hours: { on: boolean; from: number; to: number }
  /** opposite signal closes the trade and opens the other way */
  reverse: boolean
  /** close after this many strategy bars (0 = off) */
  maxBars: number
  /** UTC seconds; null = start/end of data */
  from: number | null
  to: number | null
  balance: number
  leverage: number
  /** round-turn, USD per lot */
  commission: number
  /** price units against each entry */
  slippage: number
}

export interface Signal {
  enter?: { side: Side; sl?: number; tp?: number }
  exit?: 'long' | 'short' | 'all'
}
export type SignalFn = (i: number) => Signal | null

// ---------- operand catalog ----------

export interface Source {
  label: string
  group: string
  params: { name: string; def: number }[]
}

const P = (name: string, def: number) => ({ name, def })

export const SOURCES: Record<string, Source> = {
  close: { label: 'Close', group: 'Harga', params: [] },
  open: { label: 'Open', group: 'Harga', params: [] },
  high: { label: 'High', group: 'Harga', params: [] },
  low: { label: 'Low', group: 'Harga', params: [] },
  num: { label: 'Angka', group: 'Harga', params: [P('nilai', 50)] },
  ema: { label: 'EMA', group: 'Rata-rata', params: [P('periode', 20)] },
  sma: { label: 'SMA', group: 'Rata-rata', params: [P('periode', 50)] },
  vwap: { label: 'VWAP harian', group: 'Rata-rata', params: [] },
  bb_upper: { label: 'Bollinger atas', group: 'Band', params: [P('periode', 20), P('stdev', 2)] },
  bb_mid: { label: 'Bollinger tengah', group: 'Band', params: [P('periode', 20), P('stdev', 2)] },
  bb_lower: { label: 'Bollinger bawah', group: 'Band', params: [P('periode', 20), P('stdev', 2)] },
  dc_upper: { label: 'Donchian atas (candle sebelumnya)', group: 'Band', params: [P('periode', 20)] },
  dc_lower: { label: 'Donchian bawah (candle sebelumnya)', group: 'Band', params: [P('periode', 20)] },
  st_line: { label: 'Supertrend', group: 'Tren', params: [P('ATR', 10), P('faktor', 3)] },
  st_dir: { label: 'Supertrend arah (1 naik, -1 turun)', group: 'Tren', params: [P('ATR', 10), P('faktor', 3)] },
  rsi: { label: 'RSI', group: 'Osilator', params: [P('periode', 14)] },
  stoch_k: { label: 'Stochastic %K', group: 'Osilator', params: [P('%K', 14), P('smooth', 3), P('%D', 3)] },
  stoch_d: { label: 'Stochastic %D', group: 'Osilator', params: [P('%K', 14), P('smooth', 3), P('%D', 3)] },
  macd: { label: 'MACD', group: 'Osilator', params: [P('fast', 12), P('slow', 26), P('signal', 9)] },
  macd_signal: { label: 'MACD signal', group: 'Osilator', params: [P('fast', 12), P('slow', 26), P('signal', 9)] },
  macd_hist: { label: 'MACD histogram', group: 'Osilator', params: [P('fast', 12), P('slow', 26), P('signal', 9)] },
  atr: { label: 'ATR', group: 'Osilator', params: [P('periode', 14)] },
}

export const OPS: Record<Op, string> = {
  gt: 'di atas',
  lt: 'di bawah',
  xup: 'memotong ke atas',
  xdown: 'memotong ke bawah',
}

export const operand = (src: string, p?: number[]): Operand => ({ src, p: p ?? SOURCES[src].params.map((x) => x.def) })

// ---------- data ----------

export interface Data {
  time: number[]
  open: Float64Array
  high: Float64Array
  low: Float64Array
  close: Float64Array
  volume: Float64Array
  /** computed operand series, keyed by src + params */
  cache: Map<string, Float64Array>
}

export function toData(bars: Bar[]): Data {
  const n = bars.length
  const d: Data = {
    time: new Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
    cache: new Map(),
  }
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    d.time[i] = b.time
    d.open[i] = b.open
    d.high[i] = b.high
    d.low[i] = b.low
    d.close[i] = b.close
    d.volume[i] = b.volume
  }
  return d
}

const shift1 = (s: Float64Array) => {
  const out = new Float64Array(s.length).fill(NaN)
  out.set(s.subarray(0, s.length - 1), 1)
  return out
}

function compute(d: Data, src: string, p: number[]): Float64Array {
  const { open, high: h, low: l, close: c, volume: v } = d
  switch (src) {
    case 'close': return c
    case 'open': return open
    case 'high': return h
    case 'low': return l
    case 'num': return new Float64Array(c.length).fill(p[0])
    case 'ema': return ta.ema(c, p[0])
    case 'sma': return ta.sma(c, p[0])
    case 'vwap': return ta.vwap(h, l, c, v, d.time.map(tradingDay))
    case 'bb_upper': return ta.bollinger(c, p[0], p[1]).upper
    case 'bb_mid': return ta.bollinger(c, p[0], p[1]).mid
    case 'bb_lower': return ta.bollinger(c, p[0], p[1]).lower
    case 'dc_upper': return shift1(ta.highest(h, p[0]))
    case 'dc_lower': return shift1(ta.lowest(l, p[0]))
    case 'st_line': return ta.supertrend(h, l, c, p[0], p[1]).line
    case 'st_dir': {
      const st = ta.supertrend(h, l, c, p[0], p[1])
      const out = new Float64Array(c.length).fill(NaN)
      for (let i = 0; i < c.length; i++) if (Number.isFinite(st.line[i])) out[i] = st.dir[i]
      return out
    }
    case 'rsi': return ta.rsi(c, p[0])
    case 'stoch_k': return ta.stochastic(h, l, c, p[0], p[1], p[2]).k
    case 'stoch_d': return ta.stochastic(h, l, c, p[0], p[1], p[2]).d
    case 'macd': return ta.macd(c, p[0], p[1], p[2]).line
    case 'macd_signal': return ta.macd(c, p[0], p[1], p[2]).signal
    case 'macd_hist': return ta.macd(c, p[0], p[1], p[2]).hist
    case 'atr': return ta.atr(h, l, c, p[0])
  }
  throw new Error(`Sumber tidak dikenal: ${src}`)
}

export function series(d: Data, o: Operand): Float64Array {
  const key = `${o.src}:${o.p.join(',')}`
  let s = d.cache.get(key)
  if (!s) {
    for (const x of o.p) if (!Number.isFinite(x)) throw new Error(`Parameter ${SOURCES[o.src]?.label ?? o.src} tidak valid.`)
    s = compute(d, o.src, o.p)
    d.cache.set(key, s)
  }
  return s
}

export function crossUp(a: ArrayLike<number>, b: ArrayLike<number> | number, i: number): boolean {
  const b0 = typeof b === 'number' ? b : b[i]
  const b1 = typeof b === 'number' ? b : b[i - 1]
  return i > 0 && a[i - 1] <= b1 && a[i] > b0
}

export function crossDown(a: ArrayLike<number>, b: ArrayLike<number> | number, i: number): boolean {
  const b0 = typeof b === 'number' ? b : b[i]
  const b1 = typeof b === 'number' ? b : b[i - 1]
  return i > 0 && a[i - 1] >= b1 && a[i] < b0
}

function compileCond(d: Data, c: Cond): (i: number) => boolean {
  const A = series(d, c.a)
  const B = series(d, c.b)
  switch (c.op) {
    case 'gt': return (i) => A[i] > B[i]
    case 'lt': return (i) => A[i] < B[i]
    case 'xup': return (i) => crossUp(A, B, i)
    case 'xdown': return (i) => crossDown(A, B, i)
  }
}

/** AND of all conditions; an empty list never fires. */
function all(d: Data, list: Cond[]): (i: number) => boolean {
  const fs = list.map((c) => compileCond(d, c))
  if (!fs.length) return () => false
  return (i) => fs.every((f) => f(i))
}

export function compileRules(spec: StrategySpec, d: Data): SignalFn {
  const long = all(d, spec.long)
  const short = all(d, spec.short)
  const xl = all(d, spec.exitLong)
  const xs = all(d, spec.exitShort)
  return (i) => {
    const s: Signal = {}
    const el = xl(i)
    const es = xs(i)
    if (el || es) s.exit = el && es ? 'all' : el ? 'long' : 'short'
    const L = long(i)
    const S = short(i)
    if (L !== S) s.enter = { side: L ? 'buy' : 'sell' }
    return s.enter || s.exit ? s : null
  }
}

export const CODE_TEMPLATE = `// Bagian ini jalan sekali di awal.
// Data (array per candle): open, high, low, close, volume, time (unix detik UTC)
// ta: sma, ema, rma, rsi, atr, macd, bollinger, stochastic, supertrend, donchian, highest, lowest, vwap
const fast = ta.ema(close, 20)
const slow = ta.ema(close, 50)
const r = ta.rsi(close, 14)

// Dipanggil saat candle i tertutup. Order masuk di open candle berikutnya.
// Hanya pakai data sampai index i (jangan i + 1), kalau tidak hasilnya curang.
// Return: 'buy' | 'sell' | 'exit' | { side: 'buy', sl: harga, tp: harga } | null
// SL/TP yang tidak diisi memakai pengaturan Risiko.
return function (i) {
  if (crossUp(fast, slow, i) && r[i] > 50) return 'buy'
  if (crossDown(fast, slow, i) && r[i] < 50) return 'sell'
  return null
}
`

export function compileCode(code: string, d: Data): SignalFn {
  // Runs inside the backtest Worker: no DOM, and only the author's own code.
  const factory = new Function(
    'ta', 'open', 'high', 'low', 'close', 'volume', 'time', 'crossUp', 'crossDown',
    `"use strict";\n${code}`,
  )
  const fn = factory(ta, d.open, d.high, d.low, d.close, d.volume, d.time, crossUp, crossDown)
  if (typeof fn !== 'function') throw new Error('Kode harus diakhiri dengan: return function (i) { ... }')
  return (i) => {
    const r = fn(i)
    if (r === null || r === undefined || r === false) return null
    if (r === 'buy' || r === 'sell') return { enter: { side: r } }
    if (r === 'exit') return { exit: 'all' }
    if (typeof r === 'object') {
      const s: Signal = {}
      if (r.side === 'buy' || r.side === 'sell') {
        s.enter = { side: r.side }
        if (Number.isFinite(r.sl)) s.enter.sl = r.sl
        if (Number.isFinite(r.tp)) s.enter.tp = r.tp
      }
      if (r.exit) s.exit = r.exit === true ? 'all' : r.exit
      return s.enter || s.exit ? s : null
    }
    throw new Error(`Nilai return tidak dikenal di candle ${i}: ${String(r)}`)
  }
}

export function compile(spec: StrategySpec, d: Data): SignalFn {
  return spec.mode === 'code' ? compileCode(spec.code, d) : compileRules(spec, d)
}

// ---------- defaults & presets ----------

export function defaultSpec(): StrategySpec {
  return { ...PRESETS[0].make(), name: PRESETS[0].name }
}

const C = (a: Operand, op: Op, b: Operand): Cond => ({ a, op, b })
const base = (): StrategySpec => ({
  name: '',
  mode: 'rules',
  tf: 'M15',
  long: [],
  short: [],
  exitLong: [],
  exitShort: [],
  code: CODE_TEMPLATE,
  sl: { kind: 'atr', value: 1.5 },
  tp: { kind: 'rr', value: 2 },
  sizing: { kind: 'risk', value: 1 },
  hours: { on: false, from: 14, to: 23 },
  reverse: false,
  maxBars: 0,
  from: null,
  to: null,
  balance: 10_000,
  leverage: 100,
  commission: 0,
  slippage: 0,
})

export const PRESETS: { name: string; make: () => StrategySpec }[] = [
  {
    name: 'EMA 20/50 cross',
    make: () => ({
      ...base(),
      long: [C(operand('ema', [20]), 'xup', operand('ema', [50]))],
      short: [C(operand('ema', [20]), 'xdown', operand('ema', [50]))],
    }),
  },
  {
    name: 'RSI 30/70 balik arah',
    make: () => ({
      ...base(),
      long: [C(operand('rsi'), 'xup', operand('num', [30]))],
      short: [C(operand('rsi'), 'xdown', operand('num', [70]))],
      tp: { kind: 'rr', value: 1.5 },
    }),
  },
  {
    name: 'Supertrend ikut tren',
    make: () => ({
      ...base(),
      long: [C(operand('st_dir'), 'xup', operand('num', [0]))],
      short: [C(operand('st_dir'), 'xdown', operand('num', [0]))],
      sl: { kind: 'atr', value: 2 },
      tp: { kind: 'none', value: 0 },
      reverse: true,
    }),
  },
  {
    name: 'Donchian breakout 20',
    make: () => ({
      ...base(),
      long: [C(operand('close'), 'xup', operand('dc_upper'))],
      short: [C(operand('close'), 'xdown', operand('dc_lower'))],
      sl: { kind: 'atr', value: 2 },
    }),
  },
  {
    name: 'MACD cross + filter EMA 200',
    make: () => ({
      ...base(),
      long: [C(operand('macd'), 'xup', operand('macd_signal')), C(operand('close'), 'gt', operand('ema', [200]))],
      short: [C(operand('macd'), 'xdown', operand('macd_signal')), C(operand('close'), 'lt', operand('ema', [200]))],
    }),
  },
]

// ---------- parameters (for the optimizer) ----------

export interface Param {
  id: string
  label: string
  value: number
}

const LISTS = ['long', 'short', 'exitLong', 'exitShort'] as const

/**
 * Numeric knobs of a strategy. Indicator parameters are grouped by (indicator, slot, value), so
 * "EMA period 20" moves the EMA 20 in both the buy and the sell rule together.
 */
export function listParams(spec: StrategySpec): Param[] {
  const out: Param[] = []
  const seen = new Set<string>()
  if (spec.mode === 'rules') {
    for (const list of LISTS)
      for (const c of spec[list])
        for (const o of [c.a, c.b])
          o.p.forEach((v, j) => {
            const id = `op:${o.src}:${j}:${v}`
            if (seen.has(id)) return
            seen.add(id)
            const s = SOURCES[o.src]
            out.push({ id, label: o.src === 'num' ? `Angka ${v}` : `${s.label} ${s.params[j].name} (${v})`, value: v })
          })
  }
  if (spec.sl.kind !== 'none') out.push({ id: 'sl', label: `SL ${spec.sl.kind === 'atr' ? '× ATR' : 'jarak $'} (${spec.sl.value})`, value: spec.sl.value })
  if (spec.tp.kind !== 'none')
    out.push({ id: 'tp', label: `TP ${spec.tp.kind === 'rr' ? 'R:R' : spec.tp.kind === 'atr' ? '× ATR' : 'jarak $'} (${spec.tp.value})`, value: spec.tp.value })
  if (spec.maxBars > 0) out.push({ id: 'maxBars', label: `Tutup setelah N candle (${spec.maxBars})`, value: spec.maxBars })
  return out
}

/**
 * Copy of `spec` with parameters set. Matching uses the ORIGINAL values, so moving EMA 20 to 50
 * and EMA 50 to 100 in one call does not chain.
 */
export function withParams(spec: StrategySpec, set: [id: string, v: number][]): StrategySpec {
  const s: StrategySpec = structuredClone(spec)
  for (const [id, v] of set) {
    if (id === 'sl') s.sl.value = v
    else if (id === 'tp') s.tp.value = v
    else if (id === 'maxBars') s.maxBars = Math.max(1, Math.round(v))
  }
  const ops = set.filter(([id]) => id.startsWith('op:')).map(([id, v]) => {
    const [, src, slot, old] = id.split(':')
    return { src, slot: +slot, old: +old, v }
  })
  for (const list of LISTS)
    spec[list].forEach((c, ci) =>
      (['a', 'b'] as const).forEach((side) => {
        const o0 = c[side]
        for (const x of ops) if (o0.src === x.src && o0.p[x.slot] === x.old) s[list][ci][side].p[x.slot] = x.v
      }),
    )
  return s
}

export const withParam = (spec: StrategySpec, id: string, v: number) => withParams(spec, [[id, v]])

// ---------- description ----------

const fmtOperand = (o: Operand) => (o.src === 'num' ? String(o.p[0]) : `${SOURCES[o.src].label}${o.p.length ? `(${o.p.join(', ')})` : ''}`)
export const fmtCond = (c: Cond) => `${fmtOperand(c.a)} ${OPS[c.op]} ${fmtOperand(c.b)}`

export function describe(spec: StrategySpec): string {
  const parts: string[] = [spec.tf]
  if (spec.mode === 'code') parts.push('kode JS')
  else {
    if (spec.long.length) parts.push(`BUY: ${spec.long.map(fmtCond).join(' & ')}`)
    if (spec.short.length) parts.push(`SELL: ${spec.short.map(fmtCond).join(' & ')}`)
  }
  parts.push(spec.sl.kind === 'none' ? 'tanpa SL' : spec.sl.kind === 'atr' ? `SL ${spec.sl.value}×ATR` : `SL $${spec.sl.value}`)
  parts.push(
    spec.tp.kind === 'none' ? 'tanpa TP' : spec.tp.kind === 'rr' ? `TP ${spec.tp.value}R` : spec.tp.kind === 'atr' ? `TP ${spec.tp.value}×ATR` : `TP $${spec.tp.value}`,
  )
  parts.push(spec.sizing.kind === 'risk' ? `risiko ${spec.sizing.value}%` : `${spec.sizing.value} lot`)
  return parts.join(' · ')
}
