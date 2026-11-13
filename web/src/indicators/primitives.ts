import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type {
  AutoscaleInfo,
  IChartApi,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts'
import { makeShifter } from '../time'

type Draw = (ctx: CanvasRenderingContext2D, width: number, height: number) => void

/** Shared plumbing: attach to the candle series and paint with media (CSS px) coordinates. */
abstract class CanvasPrimitive implements ISeriesPrimitive<Time> {
  protected chart: IChartApi | null = null
  protected series: ISeriesApi<'Candlestick'> | null = null
  private requestUpdate: () => void = () => {}
  private readonly views: IPrimitivePaneView[]

  constructor(zOrder: 'bottom' | 'normal' | 'top') {
    const renderer = {
      draw: (target: CanvasRenderingTarget2D) => {
        if (!this.chart || !this.series) return
        target.useMediaCoordinateSpace(({ context, mediaSize }) =>
          this.paint(context, mediaSize.width, mediaSize.height),
        )
      },
    }
    this.views = [{ zOrder: () => zOrder, renderer: () => renderer }]
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi
    this.series = p.series as ISeriesApi<'Candlestick'>
    this.requestUpdate = p.requestUpdate
  }

  detached() {
    this.chart = null
    this.series = null
    this.requestUpdate = () => {}
  }

  paneViews() {
    return this.views
  }

  refresh() {
    this.requestUpdate()
  }

  protected abstract paint: Draw

  /** Visible logical index range, padded by one bar each side. */
  protected visible(): [number, number] | null {
    const r = this.chart?.timeScale().getVisibleLogicalRange()
    if (!r) return null
    return [Math.floor(r.from) - 1, Math.ceil(r.to) + 1]
  }

  protected xAt(i: number): number | null {
    return this.chart!.timeScale().logicalToCoordinate(i as Logical)
  }
}

export interface BandStyle {
  /** fill when upper >= lower */
  fillUp: string
  /** fill when upper < lower (Ichimoku cloud turning bearish); defaults to fillUp */
  fillDown?: string
  /** optional outline colors for the two edges (Ichimoku spans) */
  lineA?: string
  lineB?: string
}

/**
 * Filled area between two series, optionally shifted `offset` bars forward
 * (Ichimoku cloud is plotted ahead of price, past the last candle).
 */
export class BandFill extends CanvasPrimitive {
  a: ArrayLike<number> = []
  b: ArrayLike<number> = []
  offset = 0
  autoscale = false

  constructor(public style: BandStyle) {
    super('bottom')
  }

  set(a: ArrayLike<number>, b: ArrayLike<number>, offset = 0) {
    this.a = a
    this.b = b
    this.offset = offset
    this.refresh()
  }

  autoscaleInfo(start: Logical, end: Logical): AutoscaleInfo | null {
    if (!this.autoscale) return null
    let min = Infinity
    let max = -Infinity
    for (let p = Math.floor(start); p <= Math.ceil(end); p++) {
      const i = p - this.offset
      for (const v of [this.a[i], this.b[i]]) {
        if (Number.isFinite(v)) {
          if (v < min) min = v
          if (v > max) max = v
        }
      }
    }
    return min <= max ? { priceRange: { minValue: min, maxValue: max } } : null
  }

  protected paint: Draw = (ctx) => {
    const vis = this.visible()
    if (!vis) return
    const s = this.series!
    let prev: { x: number; ya: number; yb: number; up: boolean } | null = null
    for (let p = vis[0]; p <= vis[1]; p++) {
      const i = p - this.offset
      const va = this.a[i]
      const vb = this.b[i]
      const x = this.xAt(p)
      const ya = Number.isFinite(va) ? s.priceToCoordinate(va) : null
      const yb = Number.isFinite(vb) ? s.priceToCoordinate(vb) : null
      if (x === null || ya === null || yb === null) {
        prev = null
        continue
      }
      const cur = { x, ya, yb, up: va >= vb }
      if (prev) {
        ctx.beginPath()
        ctx.moveTo(prev.x, prev.ya)
        ctx.lineTo(cur.x, cur.ya)
        ctx.lineTo(cur.x, cur.yb)
        ctx.lineTo(prev.x, prev.yb)
        ctx.closePath()
        ctx.fillStyle = cur.up ? this.style.fillUp : (this.style.fillDown ?? this.style.fillUp)
        ctx.fill()
        if (this.style.lineA) this.segment(ctx, prev.x, prev.ya, cur.x, cur.ya, this.style.lineA)
        if (this.style.lineB) this.segment(ctx, prev.x, prev.yb, cur.x, cur.yb, this.style.lineB)
      }
      prev = cur
    }
  }

  private segment(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string) {
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.stroke()
  }
}

export interface LineSpec {
  color: string
  width: number
  dash?: number[]
  /** hold each value until the next bar (pivots) */
  step?: boolean
  /** plot value i at bar i + offset (negative = shifted back) */
  offset?: number
  /** per-point color; a change of color breaks the line (supertrend flips) */
  colorAt?: (i: number) => string
}

/**
 * Draws indicator lines straight onto the canvas for the visible bars only.
 * Far cheaper than one chart series per line: series setData cost grows with every series on the chart.
 */
export class LinePlot extends CanvasPrimitive {
  lines: { spec: LineSpec; data: ArrayLike<number> }[] = []
  autoscale = true

  constructor() {
    super('normal')
  }

  add(spec: LineSpec): number {
    this.lines.push({ spec, data: [] })
    return this.lines.length - 1
  }

  set(idx: number, data: ArrayLike<number>) {
    this.lines[idx].data = data
  }

  autoscaleInfo(start: Logical, end: Logical): AutoscaleInfo | null {
    if (!this.autoscale) return null
    let min = Infinity
    let max = -Infinity
    for (const { spec, data } of this.lines) {
      const off = spec.offset ?? 0
      for (let p = Math.floor(start); p <= Math.ceil(end); p++) {
        const v = data[p - off]
        if (Number.isFinite(v)) {
          if (v < min) min = v
          if (v > max) max = v
        }
      }
    }
    return min <= max ? { priceRange: { minValue: min, maxValue: max } } : null
  }

  protected paint: Draw = (ctx) => {
    const vis = this.visible()
    if (!vis) return
    const s = this.series!
    ctx.lineJoin = 'round'
    for (const { spec, data } of this.lines) {
      const off = spec.offset ?? 0
      ctx.lineWidth = spec.width
      ctx.setLineDash(spec.dash ?? [])
      let open = false
      let prevX = 0
      let prevY = 0
      let prevColor = spec.color
      const flush = () => {
        if (open) {
          ctx.strokeStyle = prevColor
          ctx.stroke()
        }
        open = false
      }
      for (let p = vis[0]; p <= vis[1]; p++) {
        const i = p - off
        const v = data[i]
        const x = Number.isFinite(v) ? this.xAt(p) : null
        const y = x !== null ? s.priceToCoordinate(v) : null
        if (x === null || y === null) {
          flush()
          continue
        }
        const color = spec.colorAt ? spec.colorAt(i) : spec.color
        if (open && color !== prevColor) flush()
        if (!open) {
          ctx.beginPath()
          ctx.moveTo(x, y)
          open = true
        } else if (spec.step) {
          ctx.lineTo(x, prevY)
          ctx.lineTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }
        prevX = x
        prevY = y
        prevColor = color
      }
      if (open && spec.step) ctx.lineTo(prevX + 4, prevY)
      flush()
    }
    ctx.setLineDash([])
  }
}

interface SessionDef {
  zone: string
  from: number // local hour
  to: number
  color: string
}

export const SESSIONS: Record<'asia' | 'london' | 'newyork', SessionDef> = {
  asia: { zone: 'Asia/Tokyo', from: 9, to: 18, color: 'rgba(76,141,255,0.07)' },
  london: { zone: 'Europe/London', from: 8, to: 17, color: 'rgba(46,196,182,0.07)' },
  newyork: { zone: 'America/New_York', from: 8, to: 17, color: 'rgba(245,165,36,0.07)' },
}

/** Vertical background bands for the Asia / London / New York sessions (intraday timeframes). */
export class SessionShade extends CanvasPrimitive {
  times: ArrayLike<number> = []
  enabled: Record<keyof typeof SESSIONS, boolean> = { asia: true, london: true, newyork: true }
  private readonly shifters = Object.fromEntries(
    Object.entries(SESSIONS).map(([k, s]) => [k, makeShifter(s.zone)]),
  ) as Record<keyof typeof SESSIONS, (t: number) => number>

  constructor() {
    super('bottom')
  }

  set(times: ArrayLike<number>) {
    this.times = times
    this.refresh()
  }

  protected paint: Draw = (ctx, _w, height) => {
    const vis = this.visible()
    if (!vis || this.times.length < 2) return
    const ts = this.chart!.timeScale()
    const spacing = (ts.logicalToCoordinate(1 as Logical) ?? 0) - (ts.logicalToCoordinate(0 as Logical) ?? 0)
    const half = spacing / 2
    const lo = Math.max(0, vis[0])
    const hi = Math.min(this.times.length - 1, vis[1])
    for (const key of Object.keys(SESSIONS) as (keyof typeof SESSIONS)[]) {
      if (!this.enabled[key]) continue
      const s = SESSIONS[key]
      const shift = this.shifters[key]
      ctx.fillStyle = s.color
      let runStart: number | null = null
      for (let i = lo; i <= hi + 1; i++) {
        let inside = false
        if (i <= hi) {
          const hour = ((shift(this.times[i]) % 86400) + 86400) % 86400 / 3600
          inside = hour >= s.from && hour < s.to
        }
        if (inside && runStart === null) runStart = i
        if (!inside && runStart !== null) {
          const x0 = this.xAt(runStart)
          const x1 = this.xAt(i - 1)
          if (x0 !== null && x1 !== null) ctx.fillRect(x0 - half, 0, x1 - x0 + spacing, height)
          runStart = null
        }
      }
    }
  }
}
