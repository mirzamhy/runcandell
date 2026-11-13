/// Backtest Web Worker: loads bars itself and runs strategies off the UI thread.
import { TF_SECONDS, dataSpan, loadManifest, loadRange, type Bar, type Manifest } from '../data'
import { makeShifter } from '../time'
import { downsample, metrics, type Metrics } from './report'
import { runBacktest, type BtTrade } from './run'
import { compile, operand, series, toData, type Data, type StrategySpec } from './strategy'

export interface RunReport {
  spec: StrategySpec
  trades: BtTrade[]
  metrics: Metrics
  curve: { t: number[]; v: number[] }
  skipped: Record<string, number>
  bars: number
  from: number
  to: number
  /** timeframe SL/TP were checked on */
  exec: string
  ms: number
}

export interface OptRow {
  index: number
  is: Metrics
  oos: Metrics | null
}

export type WorkerIn =
  | { id: number; kind: 'run'; spec: StrategySpec; zone: string }
  | { id: number; kind: 'optimize'; specs: StrategySpec[]; split: number; zone: string; top: number }

export type WorkerOut =
  | { id: number; kind: 'progress'; text: string }
  | { id: number; kind: 'result'; report: RunReport }
  | { id: number; kind: 'optimized'; rows: OptRow[]; split: number; isEnd: number; from: number; to: number }
  | { id: number; kind: 'error'; message: string }

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m)

let manifest: Promise<Manifest> | null = null

interface Prepared {
  bars: Bar[]
  m1: Bar[] | null
  data: Data
  atr: Float64Array
  start: number
  tfSec: number
}

let cached: { key: string; p: Prepared } | null = null

/** indicator warm-up loaded before the test start, in strategy bars */
const WARMUP = 600

async function prepare(spec: StrategySpec, id: number): Promise<Prepared> {
  manifest ??= loadManifest()
  const m = await manifest
  const span = dataSpan(m)
  const from = Math.max(spec.from ?? span.from, span.from)
  const to = Math.min(spec.to ?? Infinity, span.to + 60)
  if (!(to > from)) throw new Error('Rentang tanggal kosong.')
  const key = `${spec.tf}|${from}|${to}`
  if (cached?.key === key) return cached.p

  post({ id, kind: 'progress', text: 'Memuat data…' })
  const tfSec = TF_SECONDS[spec.tf]
  // weekends and holidays: load a bit more calendar time than WARMUP bars
  const bars = await loadRange(m, spec.tf, from - WARMUP * tfSec * 1.6, to)
  const start = bars.findIndex((b) => b.time >= from)
  if (start === -1) throw new Error('Tidak ada candle di rentang ini.')
  const m1 = spec.tf === 'M1' ? null : await loadRange(m, 'M1', from, to + tfSec)
  const data = toData(bars)
  const p: Prepared = { bars, m1, data, atr: series(data, operand('atr', [14])), start, tfSec }
  cached = { key, p }
  return p
}

function hourFn(zone: string) {
  const shift = makeShifter(zone)
  return (t: number) => (((Math.floor(shift(t) / 3600) % 24) + 24) % 24)
}

function runOne(p: Prepared, spec: StrategySpec, zone: string, start: number, end: number) {
  let signal
  try {
    signal = compile(spec, p.data)
  } catch (e) {
    throw new Error(spec.mode === 'code' ? `Kode error: ${(e as Error).message}` : (e as Error).message)
  }
  const wrapped = spec.mode === 'code'
    ? (i: number) => {
        try {
          return signal(i)
        } catch (e) {
          throw new Error(`Kode error di candle ${i}: ${(e as Error).message}`)
        }
      }
    : signal
  return runBacktest({ spec, bars: p.bars, tfSec: p.tfSec, m1: p.m1, signal: wrapped, atr: p.atr, start, end, hourOf: hourFn(zone) })
}

async function handle(msg: WorkerIn) {
  const { id } = msg
  if (msg.kind === 'run') {
    const t0 = performance.now()
    const p = await prepare(msg.spec, id)
    post({ id, kind: 'progress', text: 'Menghitung…' })
    const r = runOne(p, msg.spec, msg.zone, p.start, Infinity)
    post({
      id,
      kind: 'result',
      report: {
        spec: msg.spec,
        trades: r.trades,
        metrics: metrics(r.trades, r.eqTime, r.eqValue, msg.spec.balance),
        curve: downsample(r.eqTime, r.eqValue),
        skipped: r.skipped,
        bars: r.bars,
        from: r.from,
        to: r.to,
        exec: p.m1 ? 'M1' : msg.spec.tf,
        ms: Math.round(performance.now() - t0),
      },
    })
    return
  }

  const p = await prepare(msg.specs[0], id)
  const from = p.bars[p.start].time
  const to = p.bars[p.bars.length - 1].time
  const isEnd = from + (to - from) * msg.split
  const oosStart = p.bars.findIndex((b) => b.time >= isEnd)
  const rows: OptRow[] = []
  let lastPost = 0
  for (let i = 0; i < msg.specs.length; i++) {
    const s = msg.specs[i]
    const r = runOne(p, s, msg.zone, p.start, isEnd)
    rows.push({ index: i, is: metrics(r.trades, r.eqTime, r.eqValue, s.balance), oos: null })
    if (performance.now() - lastPost > 100) {
      lastPost = performance.now()
      post({ id, kind: 'progress', text: `Optimasi ${i + 1}/${msg.specs.length}` })
    }
  }
  rows.sort((a, b) => b.is.net - a.is.net)
  if (oosStart !== -1)
    for (const row of rows.slice(0, msg.top)) {
      const s = msg.specs[row.index]
      const r = runOne(p, s, msg.zone, oosStart, Infinity)
      row.oos = metrics(r.trades, r.eqTime, r.eqValue, s.balance)
    }
  post({ id, kind: 'optimized', rows, split: msg.split, isEnd, from, to })
}

self.addEventListener('message', (e: MessageEvent<WorkerIn>) => {
  handle(e.data).catch((err) => post({ id: e.data.id, kind: 'error', message: (err as Error).message }))
})
