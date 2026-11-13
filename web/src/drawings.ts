import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts'

export type DrawKind = 'hline' | 'trend' | 'rect' | 'fib'
export type Tool = 'cursor' | DrawKind

/** A point in data space: t = UTC seconds (may be fractional / outside data), p = price. */
export interface Pt {
  t: number
  p: number
}

export interface Drawing {
  id: string
  kind: DrawKind
  pts: Pt[]
}

/** Converts between data time and the chart's logical index for the current timeframe. */
export interface Axis {
  toLogical(t: number): number
  toTime(l: number): number
}

const NEED: Record<DrawKind, number> = { hline: 1, trend: 2, rect: 2, fib: 2 }
const COLOR: Record<DrawKind, string> = {
  hline: '#f5a524',
  trend: '#4c8dff',
  rect: '#a78bfa',
  fib: '#2ec4b6',
}
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
const HANDLE_R = 5
const HIT_PX = 6

type Hit = { id: string; handle: number | null }

interface Drag {
  id: string
  handle: number | null
  startL: number
  startP: number
  orig: Pt[]
}

export class DrawingLayer implements ISeriesPrimitive<Time> {
  drawings: Drawing[] = []
  selected: string | null = null
  tool: Tool = 'cursor'
  onChange: () => void = () => {}
  onToolChange: (t: Tool) => void = () => {}

  private chart!: IChartApi
  private series!: ISeriesApi<'Candlestick'>
  private requestUpdate: () => void = () => {}
  private draft: Drawing | null = null
  private drag: Drag | null = null
  private digits = 2
  private readonly view: IPrimitivePaneView

  constructor(
    private readonly axis: Axis,
    private readonly host: HTMLElement,
  ) {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target: CanvasRenderingTarget2D) => {
        target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize.width))
      },
    }
    this.view = { zOrder: () => 'top', renderer: () => renderer }
    this.bindEvents()
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi
    this.series = p.series as ISeriesApi<'Candlestick'>
    this.requestUpdate = p.requestUpdate
  }

  detached() {
    this.requestUpdate = () => {}
  }

  paneViews() {
    return [this.view]
  }

  setDigits(d: number) {
    this.digits = d
  }

  setTool(t: Tool) {
    this.tool = t
    this.draft = null
    this.host.style.cursor = t === 'cursor' ? '' : 'crosshair'
    this.onToolChange(t)
    this.refresh()
  }

  load(list: Drawing[]) {
    this.drawings = list
    this.selected = null
    this.refresh()
  }

  removeSelected() {
    if (!this.selected) return
    this.drawings = this.drawings.filter((d) => d.id !== this.selected)
    this.selected = null
    this.changed()
  }

  clear() {
    this.drawings = []
    this.selected = null
    this.draft = null
    this.changed()
  }

  refresh() {
    this.requestUpdate()
  }

  private changed() {
    this.onChange()
    this.refresh()
  }

  // ---- coordinates ----

  private x(t: number): number | null {
    // logicalToCoordinate only handles whole indices (fractions return 0), so interpolate.
    const ts = this.chart.timeScale()
    const l = this.axis.toLogical(t)
    const i = Math.floor(l)
    const x0 = ts.logicalToCoordinate(i as Logical)
    if (x0 === null) return null
    if (l === i) return x0
    const x1 = ts.logicalToCoordinate((i + 1) as Logical)
    if (x1 === null) return x0
    return x0 + (l - i) * (x1 - x0)
  }

  private y(p: number): number | null {
    return this.series.priceToCoordinate(p)
  }

  private toPt(x: number, y: number): Pt | null {
    const l = this.chart.timeScale().coordinateToLogical(x)
    const p = this.series.coordinateToPrice(y)
    if (l === null || p === null) return null
    return { t: this.axis.toTime(l), p }
  }

  private inMainPane(y: number, x: number): boolean {
    const pane = this.chart.panes()[0]
    const width = this.chart.timeScale().width()
    return y >= 0 && y <= pane.getHeight() && x >= 0 && x <= width
  }

  // ---- input ----

  private local(e: PointerEvent) {
    const r = this.host.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private bindEvents() {
    const h = this.host
    h.addEventListener('pointerdown', (e) => this.onDown(e), true)
    h.addEventListener('pointermove', (e) => this.onMove(e), true)
    h.addEventListener('pointerup', (e) => this.onUp(e), true)
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') {
        if (this.draft || this.tool !== 'cursor') this.setTool('cursor')
        else if (this.selected) {
          this.selected = null
          this.refresh()
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        this.removeSelected()
      }
    })
  }

  private block(e: PointerEvent) {
    e.stopPropagation()
    e.preventDefault()
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return
    const { x, y } = this.local(e)
    if (!this.inMainPane(y, x)) return
    const pt = this.toPt(x, y)
    if (!pt) return

    if (this.tool !== 'cursor') {
      this.block(e)
      const kind = this.tool
      if (!this.draft) {
        this.draft = { id: crypto.randomUUID(), kind, pts: [pt] }
        if (NEED[kind] === 1) this.finishDraft()
        else this.draft.pts.push({ ...pt })
      } else {
        this.draft.pts[this.draft.pts.length - 1] = pt
        if (this.draft.pts.length >= NEED[kind]) this.finishDraft()
        else this.draft.pts.push({ ...pt })
      }
      this.refresh()
      return
    }

    const hit = this.findHit(x, y)
    if (!hit) {
      if (this.selected) {
        this.selected = null
        this.refresh()
      }
      return
    }
    this.block(e)
    this.selected = hit.id
    const d = this.drawings.find((dd) => dd.id === hit.id)!
    const l = this.chart.timeScale().coordinateToLogical(x) ?? 0
    this.drag = { id: hit.id, handle: hit.handle, startL: l, startP: pt.p, orig: d.pts.map((p) => ({ ...p })) }
    this.host.setPointerCapture(e.pointerId)
    this.refresh()
  }

  private onMove(e: PointerEvent) {
    const { x, y } = this.local(e)
    if (this.draft) {
      const pt = this.toPt(x, y)
      if (pt) {
        this.draft.pts[this.draft.pts.length - 1] = pt
        this.refresh()
      }
      return
    }
    if (this.drag) {
      this.block(e)
      const d = this.drawings.find((dd) => dd.id === this.drag!.id)
      const l = this.chart.timeScale().coordinateToLogical(x)
      const p = this.series.coordinateToPrice(y)
      if (!d || l === null || p === null) return
      const g = this.drag
      if (g.handle !== null) {
        d.pts[g.handle] = { t: this.axis.toTime(l), p }
      } else {
        const dl = l - g.startL
        const dp = p - g.startP
        d.pts = g.orig.map((o) => ({ t: this.axis.toTime(this.axis.toLogical(o.t) + dl), p: o.p + dp }))
      }
      this.refresh()
      return
    }
    if (this.tool === 'cursor' && this.inMainPane(y, x)) {
      const hit = this.findHit(x, y)
      this.host.style.cursor = hit ? (hit.handle !== null ? 'grab' : 'move') : ''
    }
  }

  private onUp(e: PointerEvent) {
    if (!this.drag) return
    this.block(e)
    this.drag = null
    if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId)
    this.changed()
  }

  private finishDraft() {
    if (!this.draft) return
    this.drawings.push(this.draft)
    this.selected = this.draft.id
    this.draft = null
    this.setTool('cursor')
    this.changed()
  }

  // ---- hit testing ----

  private screenPts(d: Drawing): { x: number; y: number }[] | null {
    const out = []
    for (const p of d.pts) {
      const x = this.x(p.t)
      const y = this.y(p.p)
      if (x === null || y === null) return null
      out.push({ x, y })
    }
    return out
  }

  private findHit(x: number, y: number): Hit | null {
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i]
      const s = this.screenPts(d)
      if (!s) continue
      if (d.kind !== 'hline') {
        for (let k = 0; k < s.length; k++) {
          if (Math.hypot(s[k].x - x, s[k].y - y) <= HANDLE_R + 3) return { id: d.id, handle: k }
        }
      }
      if (this.hitBody(d, s, x, y)) return { id: d.id, handle: null }
    }
    return null
  }

  private hitBody(d: Drawing, s: { x: number; y: number }[], x: number, y: number): boolean {
    switch (d.kind) {
      case 'hline':
        return Math.abs(s[0].y - y) <= HIT_PX
      case 'trend':
        return distToSegment(x, y, s[0], s[1]) <= HIT_PX
      case 'rect': {
        const [x0, x1] = [Math.min(s[0].x, s[1].x), Math.max(s[0].x, s[1].x)]
        const [y0, y1] = [Math.min(s[0].y, s[1].y), Math.max(s[0].y, s[1].y)]
        return x >= x0 - HIT_PX && x <= x1 + HIT_PX && y >= y0 - HIT_PX && y <= y1 + HIT_PX
      }
      case 'fib': {
        const [x0, x1] = [Math.min(s[0].x, s[1].x), Math.max(s[0].x, s[1].x)]
        if (x < x0 - HIT_PX || x > x1 + HIT_PX) return false
        return FIB_LEVELS.some((lv) => {
          const py = this.y(fibPrice(d, lv))
          return py !== null && Math.abs(py - y) <= HIT_PX
        })
      }
    }
  }

  // ---- painting ----

  private paint(ctx: CanvasRenderingContext2D, width: number) {
    for (const d of this.drawings) this.paintOne(ctx, d, width, d.id === this.selected)
    if (this.draft) this.paintOne(ctx, this.draft, width, true)
  }

  private paintOne(ctx: CanvasRenderingContext2D, d: Drawing, width: number, selected: boolean) {
    const s = this.screenPts(d)
    if (!s) return
    const color = COLOR[d.kind]
    ctx.save()
    ctx.lineWidth = selected ? 2 : 1.5
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'

    switch (d.kind) {
      case 'hline': {
        const y = Math.round(s[0].y) + 0.5
        line(ctx, 0, y, width, y)
        const label = d.pts[0].p.toFixed(this.digits)
        const w = ctx.measureText(label).width + 10
        ctx.fillRect(width - w - 4, y - 9, w, 18)
        ctx.fillStyle = '#0b0e14'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, width - w + 1, y)
        break
      }
      case 'trend':
        line(ctx, s[0].x, s[0].y, s[1].x, s[1].y)
        break
      case 'rect': {
        const x0 = Math.min(s[0].x, s[1].x)
        const y0 = Math.min(s[0].y, s[1].y)
        const w = Math.abs(s[1].x - s[0].x)
        const h = Math.abs(s[1].y - s[0].y)
        ctx.globalAlpha = 0.15
        ctx.fillRect(x0, y0, w, h)
        ctx.globalAlpha = 1
        ctx.strokeRect(x0, y0, w, h)
        break
      }
      case 'fib': {
        const x0 = Math.min(s[0].x, s[1].x)
        const x1 = Math.max(s[0].x, s[1].x)
        ctx.setLineDash([4, 3])
        ctx.globalAlpha = 0.5
        line(ctx, s[0].x, s[0].y, s[1].x, s[1].y)
        ctx.setLineDash([])
        ctx.globalAlpha = 1
        ctx.textBaseline = 'bottom'
        for (const lv of FIB_LEVELS) {
          const price = fibPrice(d, lv)
          const y = this.y(price)
          if (y === null) continue
          const yy = Math.round(y) + 0.5
          line(ctx, x0, yy, x1, yy)
          ctx.fillText(`${lv} (${price.toFixed(this.digits)})`, x0 + 4, yy - 2)
        }
        break
      }
    }

    if (selected && d.kind !== 'hline') {
      for (const p of s) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2)
        ctx.fillStyle = '#0b0e14'
        ctx.fill()
        ctx.lineWidth = 1.5
        ctx.strokeStyle = color
        ctx.stroke()
      }
    }
    ctx.restore()
  }
}

/** Fib from point 0 (start) to point 1 (end): level 0 at the end, level 1 at the start (TradingView style). */
function fibPrice(d: Drawing, lv: number): number {
  const [a, b] = d.pts
  return b.p + (a.p - b.p) * lv
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()
}

function distToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}
