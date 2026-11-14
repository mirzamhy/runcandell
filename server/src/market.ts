/** Read the Parquet candle pyramid (data/build) on the server, for duel snapshots. */
import { decompress } from 'fzstd'
import { parquetReadObjects, type Compressors } from 'hyparquet'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Bar, Manifest, TF } from '../../web/src/types.ts'

export interface MarketData {
  span(): Promise<{ from: number; to: number }>
  /** bars with from <= time < to */
  bars(tf: TF, from: number, to: number): Promise<Bar[]>
}

const compressors: Compressors = { ZSTD: (input, outputLength) => decompress(input, new Uint8Array(outputLength)) }

export class ParquetMarket implements MarketData {
  private manifest: Promise<Manifest> | null = null
  private cache = new Map<string, Promise<Bar[]>>()
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  private man(): Promise<Manifest> {
    this.manifest ??= readFile(join(this.dir, 'manifest.json'), 'utf8').then((s) => JSON.parse(s) as Manifest)
    return this.manifest
  }

  async span() {
    const c = (await this.man()).timeframes.M1
    return { from: Math.min(...c.map((x) => x.from)), to: Math.max(...c.map((x) => x.to)) }
  }

  private chunk(file: string, point: number): Promise<Bar[]> {
    let p = this.cache.get(file)
    if (!p) {
      p = (async () => {
        const buf = await readFile(join(this.dir, file))
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        const rows = (await parquetReadObjects({ file: ab, compressors })) as Record<string, number>[]
        return rows.map((r) => ({
          time: Number(r.time),
          open: r.open * point,
          high: r.high * point,
          low: r.low * point,
          close: r.close * point,
          volume: Number(r.tick_volume),
          spread: r.spread * point,
        }))
      })()
      // keep memory bounded: M1 month files are the big ones
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(file, p)
      p.catch(() => this.cache.delete(file))
    }
    return p
  }

  async bars(tf: TF, from: number, to: number): Promise<Bar[]> {
    const m = await this.man()
    const chunks = m.timeframes[tf].filter((c) => c.to >= from && c.from < to).sort((a, b) => a.from - b.from)
    const parts = await Promise.all(chunks.map((c) => this.chunk(c.file, m.point)))
    const out: Bar[] = []
    for (const part of parts) for (const b of part) if (b.time >= from && b.time < to) out.push(b)
    return out
  }
}

/** Every instrument with data: data/build/<SYMBOL>/ plus data/build/symbols.json. */
export interface MarketSource {
  symbols(): Promise<string[]>
  of(symbol: string): MarketData
}

export class ParquetMarkets implements MarketSource {
  private readonly root: string
  private readonly markets = new Map<string, ParquetMarket>()
  private list: Promise<string[]> | null = null

  constructor(root: string) {
    this.root = root
  }

  symbols() {
    this.list ??= readFile(join(this.root, 'symbols.json'), 'utf8').then(
      (s) => (JSON.parse(s) as { symbol: string }[]).map((x) => x.symbol),
      () => ['XAUUSD'],
    )
    return this.list
  }

  of(symbol: string): MarketData {
    let m = this.markets.get(symbol)
    if (!m) {
      m = new ParquetMarket(join(this.root, symbol))
      this.markets.set(symbol, m)
    }
    return m
  }
}

/** one data set as gold (tests) */
export const singleMarket = (m: MarketData, symbol = 'XAUUSD'): MarketSource => ({ symbols: async () => [symbol], of: () => m })
