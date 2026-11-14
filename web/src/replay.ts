import { SeriesStore, type Bar, type Manifest } from './data'
import { Account, DEFAULT_CONFIG, type AccountConfig, type AccountState } from './engine/account'

/** Index of the last bar with time <= t, or -1. */
export function floorIndex(bars: Bar[], t: number): number {
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

export interface ReplaySession {
  startTime: number
  cursorTime: number
  account: AccountState
  hideDate: boolean
  /** id of the copy saved on the server (F5), so later saves update it */
  serverId?: number | null
  name?: string
  /** instrument; sessions saved before pairs existed are gold */
  symbol?: string
}

/**
 * Bar replay driven by M1 data.
 * The cursor is the last revealed M1 bar; everything after it is hidden.
 * Higher-timeframe candles are cut at the cursor and the forming candle is rebuilt from M1,
 * so the chart never shows a future high/low.
 */
export class Replay {
  readonly m1: SeriesStore
  cursor = -1
  startTime = 0
  account: Account
  hideDate = false
  serverId: number | null = null
  name = ''
  readonly symbol: string

  constructor(manifest: Manifest, cfg: AccountConfig = DEFAULT_CONFIG) {
    this.symbol = manifest.symbol
    this.m1 = new SeriesStore(manifest, 'M1')
    this.account = new Account(cfg)
  }

  get cursorBar(): Bar | undefined {
    return this.m1.bars[this.cursor]
  }

  get cursorTime(): number {
    return this.cursorBar?.time ?? this.startTime
  }

  get atEnd(): boolean {
    return this.cursor >= this.m1.bars.length - 1 && !this.m1.canRight
  }

  /** Reveal data up to and including time t (start of a fresh session). */
  async start(t: number) {
    await this.m1.loadAround(t)
    this.cursor = Math.max(0, floorIndex(this.m1.bars, t))
    this.startTime = this.cursorTime
    this.account.onBar(this.candle(this.cursor))
  }

  async resume(s: ReplaySession) {
    this.account = Account.fromJSON(s.account)
    this.hideDate = s.hideDate
    this.serverId = s.serverId ?? null
    this.name = s.name ?? ''
    await this.m1.loadAround(s.cursorTime)
    this.cursor = Math.max(0, floorIndex(this.m1.bars, s.cursorTime))
    this.startTime = s.startTime
  }

  session(): ReplaySession {
    return {
      startTime: this.startTime,
      cursorTime: this.cursorTime,
      account: this.account.toJSON(),
      hideDate: this.hideDate,
      serverId: this.serverId,
      name: this.name,
      symbol: this.symbol,
    }
  }

  private candle(i: number) {
    const b = this.m1.bars[i]
    return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, spread: b.spread }
  }

  /** Make sure M1 bar i exists, loading the next chunk if needed. */
  private async ensure(i: number): Promise<boolean> {
    while (i >= this.m1.bars.length) {
      if (!this.m1.canRight) return false
      await this.m1.extendRight()
    }
    return true
  }

  private advanceTo(i: number) {
    for (let k = this.cursor + 1; k <= i; k++) this.account.onBar(this.candle(k))
    this.cursor = i
  }

  /**
   * Step one candle of the view timeframe: finish the forming candle,
   * or if it is already complete, reveal the whole next one.
   * Returns false at the end of the data.
   */
  async step(view: SeriesStore): Promise<boolean> {
    if (!(await this.ensure(this.cursor + 1))) return false
    const nextBarStart = async (k: number): Promise<number> => {
      while (k + 1 >= view.bars.length && view.canRight) await view.extendRight()
      return view.bars[k + 1]?.time ?? Infinity
    }
    let k = floorIndex(view.bars, this.cursorTime)
    let end = await nextBarStart(k)
    if (this.m1.bars[this.cursor + 1].time >= end) {
      k += 1
      end = await nextBarStart(k)
    }
    let i = this.cursor
    while (true) {
      if (!(await this.ensure(i + 1))) break
      if (this.m1.bars[i + 1].time >= end) break
      i++
    }
    if (i === this.cursor) return false
    this.advanceTo(i)
    return true
  }

  /**
   * Bars of the view timeframe that may be shown: complete candles before the cursor's candle,
   * plus that candle rebuilt from M1 up to the cursor.
   */
  visible(view: SeriesStore): Bar[] {
    const t = this.cursorTime
    const k = floorIndex(view.bars, t)
    if (k < 0) return []
    const out = view.bars.slice(0, k)
    if (view.tf === 'M1') {
      out.push(this.m1.bars[this.cursor])
      return out
    }
    const startT = view.bars[k].time
    let j = floorIndex(this.m1.bars, startT - 1) + 1
    const first = this.m1.bars[j]
    if (!first || first.time > t) {
      out.push(view.bars[k]) // M1 for this candle not loaded (data edge): fall back
      return out
    }
    const forming: Bar = { ...first }
    for (j = j + 1; j <= this.cursor; j++) {
      const b = this.m1.bars[j]
      if (b.high > forming.high) forming.high = b.high
      if (b.low < forming.low) forming.low = b.low
      forming.close = b.close
      forming.volume += b.volume
      forming.spread = b.spread
    }
    forming.time = startT
    out.push(forming)
    return out
  }
}
