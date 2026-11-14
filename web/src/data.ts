import { decompress as zstdDecompress } from 'fzstd'
import { parquetReadObjects, type Compressors } from 'hyparquet'

// Our Parquet files only use zstd; skip the full codec bundle.
const compressors: Compressors = {
  ZSTD: (input, outputLength) => zstdDecompress(input, new Uint8Array(outputLength)),
}

export { TIMEFRAMES, TF_SECONDS, type Bar, type ChunkInfo, type Manifest, type TF } from './types'
import type { Bar, ChunkInfo, Manifest, TF } from './types'
import { TF_SECONDS } from './types'

const DATA_URL = (import.meta.env.VITE_DATA_URL ?? '/data').replace(/\/$/, '')

export interface SymbolInfo {
  symbol: string
  label: string
  digits: number
  from: number
  to: number
}

/** instruments that have data (data/build/symbols.json) */
export async function loadSymbols(): Promise<SymbolInfo[]> {
  const res = await fetch(`${DATA_URL}/symbols.json`)
  if (!res.ok) throw new Error(`symbols.json: HTTP ${res.status}`)
  return res.json()
}

export async function loadManifest(symbol: string): Promise<Manifest> {
  const res = await fetch(`${DATA_URL}/${symbol}/manifest.json`)
  if (!res.ok) throw new Error(`${symbol}/manifest.json: HTTP ${res.status}`)
  return res.json()
}

const chunkCache = new Map<string, Promise<Bar[]>>()

function loadChunk(m: Manifest, c: ChunkInfo): Promise<Bar[]> {
  const key = `${m.symbol}/${c.file}`
  let p = chunkCache.get(key)
  if (!p) {
    p = readChunk(m, c)
    chunkCache.set(key, p)
    p.catch(() => chunkCache.delete(key))
  }
  return p
}

async function readChunk(m: Manifest, c: ChunkInfo): Promise<Bar[]> {
  const res = await fetch(`${DATA_URL}/${m.symbol}/${c.file}`)
  if (!res.ok) throw new Error(`${c.file}: HTTP ${res.status}`)
  const file = await res.arrayBuffer()
  const rows = (await parquetReadObjects({ file, compressors })) as Record<string, number>[]
  const pt = m.point
  const out = new Array<Bar>(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    out[i] = {
      time: Number(r.time),
      open: r.open * pt,
      high: r.high * pt,
      low: r.low * pt,
      close: r.close * pt,
      volume: Number(r.tick_volume),
      spread: r.spread * pt,
    }
  }
  return out
}

/** All bars of `tf` with from <= time < to (backtest). */
export async function loadRange(m: Manifest, tf: TF, from: number, to: number): Promise<Bar[]> {
  const chunks = m.timeframes[tf].filter((c) => c.to >= from && c.from < to).sort((a, b) => a.from - b.from)
  const parts = await Promise.all(chunks.map((c) => loadChunk(m, c)))
  const out: Bar[] = []
  for (const part of parts) for (const b of part) if (b.time >= from && b.time < to) out.push(b)
  return out
}

/** First and last bar time over all M1 data. */
export function dataSpan(m: Manifest): { from: number; to: number } {
  const c = m.timeframes.M1
  return { from: Math.min(...c.map((x) => x.from)), to: Math.max(...c.map((x) => x.to)) }
}

/**
 * Contiguous window of loaded chunks for one timeframe.
 * Logical index i = position in `bars`. Times between/after bars map to fractional indices,
 * so drawings keep their place when the window grows or the timeframe changes.
 */
export class SeriesStore {
  bars: Bar[] = []
  private lo = -1
  private hi = -1
  private readonly chunks: ChunkInfo[]
  readonly tfSec: number

  constructor(
    private readonly m: Manifest,
    readonly tf: TF,
  ) {
    this.chunks = [...m.timeframes[tf]].sort((a, b) => a.from - b.from)
    this.tfSec = TF_SECONDS[tf]
  }

  get canLeft() {
    return this.lo > 0
  }
  get canRight() {
    return this.hi >= 0 && this.hi < this.chunks.length - 1
  }
  get atLatest() {
    return this.hi === this.chunks.length - 1
  }
  get first(): number | null {
    return this.chunks.length ? this.chunks[0].from : null
  }

  /** Load the chunk holding time t (or the latest) plus one neighbour on each side. */
  async loadAround(t: number | null) {
    if (!this.chunks.length) throw new Error(`no data for ${this.tf}`)
    let idx = this.chunks.length - 1
    if (t !== null) {
      const found = this.chunks.findIndex((c) => c.to >= t)
      idx = found === -1 ? this.chunks.length - 1 : found
    }
    const lo = Math.max(0, idx - 1)
    const hi = Math.min(this.chunks.length - 1, idx + 1)
    const parts = await Promise.all(this.chunks.slice(lo, hi + 1).map((c) => loadChunk(this.m, c)))
    this.bars = parts.flat()
    this.lo = lo
    this.hi = hi
  }

  /** Prepend the previous chunk. Returns number of bars added (shift for logical indices). */
  async extendLeft(): Promise<number> {
    if (!this.canLeft) return 0
    const part = await loadChunk(this.m, this.chunks[this.lo - 1])
    this.lo -= 1
    this.bars = part.concat(this.bars)
    return part.length
  }

  async extendRight(): Promise<number> {
    if (!this.canRight) return 0
    const part = await loadChunk(this.m, this.chunks[this.hi + 1])
    this.hi += 1
    this.bars = this.bars.concat(part)
    return part.length
  }

  /** Last bar index with time <= t, or -1. */
  private floorIndex(t: number): number {
    const b = this.bars
    let lo = 0
    let hi = b.length - 1
    let ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (b[mid].time <= t) {
        ans = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return ans
  }

  indexOfTime(t: number): number {
    const b = this.bars
    if (!b.length) return 0
    if (t < b[0].time) return (t - b[0].time) / this.tfSec
    const i = this.floorIndex(t)
    if (i === b.length - 1) return i + (t - b[i].time) / this.tfSec
    return i + Math.min((t - b[i].time) / this.tfSec, 0.999)
  }

  timeOfIndex(l: number): number {
    const b = this.bars
    if (!b.length) return 0
    if (l < 0) return b[0].time + l * this.tfSec
    const i = Math.min(Math.floor(l), b.length - 1)
    return b[i].time + (l - i) * this.tfSec
  }

  barAt(l: number): Bar | undefined {
    return this.bars[Math.round(l)]
  }
}
