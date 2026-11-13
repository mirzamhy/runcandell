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

/** Drawing tools, roughly the everyday set of the TradingView toolbar. */
export type DrawKind =
  | 'trend'
  | 'ray'
  | 'extline'
  | 'arrow'
  | 'hline'
  | 'hray'
  | 'vline'
  | 'cross'
  | 'channel'
  | 'fib'
  | 'fibext'
  | 'rect'
  | 'ellipse'
  | 'long'
  | 'short'
  | 'range'
  | 'text'
export type Tool = 'cursor' | DrawKind
export type Dash = 'solid' | 'dash' | 'dot'
export type Magnet = 'off' | 'weak' | 'strong'

export interface DrawStyle {
  color: string
  /** line width in px, 1–4 */
  width: number
  dash: Dash
  /** text tool content, or a label on lines and boxes */
  text?: string
  /** shapes: fill color (default = line color) and opacity 0-100 */
  fill?: string
  fillAlpha?: number
  /** lines, boxes, fibs: run on to the chart edge */
  extendL?: boolean
  extendR?: boolean
  /** text size in px */
  fontSize?: number
}

/** A point in data space: t = UTC seconds (may be fractional / outside data), p = price. */
export interface Pt {
  t: number
  p: number
}

export interface Drawing {
  id: string
  kind: DrawKind
  pts: Pt[]
  /** missing on drawings saved before styles existed: defaults apply */
  style?: DrawStyle
  /** locked: can be selected, not moved */
  locked?: boolean
  hidden?: boolean
  /** timeframes to show on; missing = all */
  tfs?: string[]
}

/** Which style options make sense for a tool (style bar and settings dialog). */
export const CAN = {
  fill: (k: DrawKind) => k === 'rect' || k === 'ellipse' || k === 'channel',
  extend: (k: DrawKind) => k === 'trend' || k === 'rect' || k === 'fib' || k === 'fibext',
  label: (k: DrawKind) => k !== 'text' && k !== 'long' && k !== 'short' && k !== 'range',
}

export interface OHLC {
  open: number
  high: number
  low: number
  close: number
}

/** Converts between data time and the chart's logical index for the current timeframe. */
export interface Axis {
  toLogical(t: number): number
  toTime(l: number): number
  /** candle at a whole logical index (magnet) */
  bar?(l: number): OHLC | null
}

export const TOOL_LABEL: Record<Tool, string> = {
  cursor: 'Kursor',
  trend: 'Trendline',
  ray: 'Ray',
  extline: 'Garis diperpanjang',
  arrow: 'Panah',
  hline: 'Garis horizontal',
  hray: 'Ray horizontal',
  vline: 'Garis vertikal',
  cross: 'Garis silang',
  channel: 'Channel paralel',
  fib: 'Fib retracement',
  fibext: 'Fib extension',
  rect: 'Kotak / zona',
  ellipse: 'Elips',
  long: 'Posisi long',
  short: 'Posisi short',
  range: 'Ukur harga & waktu',
  text: 'Teks',
}

/** clicks needed to place each tool */
const NEED: Record<DrawKind, number> = {
  trend: 2, ray: 2, extline: 2, arrow: 2, hline: 1, hray: 1, vline: 1, cross: 1, channel: 3,
  fib: 2, fibext: 3, rect: 2, ellipse: 2, long: 2, short: 2, range: 2, text: 1,
}
export const DEFAULT_STYLE: Record<DrawKind, DrawStyle> = {
  trend: { color: '#4c8dff', width: 2, dash: 'solid' },
  ray: { color: '#4c8dff', width: 2, dash: 'solid' },
  extline: { color: '#4c8dff', width: 2, dash: 'solid' },
  arrow: { color: '#f5a524', width: 2, dash: 'solid' },
  hline: { color: '#f5a524', width: 1, dash: 'solid' },
  hray: { color: '#f5a524', width: 1, dash: 'solid' },
  vline: { color: '#9aa4b2', width: 1, dash: 'dash' },
  cross: { color: '#9aa4b2', width: 1, dash: 'dash' },
  channel: { color: '#a78bfa', width: 1, dash: 'solid' },
  fib: { color: '#2ec4b6', width: 1, dash: 'solid' },
  fibext: { color: '#2ec4b6', width: 1, dash: 'solid' },
  rect: { color: '#a78bfa', width: 1, dash: 'solid' },
  ellipse: { color: '#a78bfa', width: 1, dash: 'solid' },
  long: { color: '#26a69a', width: 1, dash: 'solid' },
  short: { color: '#ef5350', width: 1, dash: 'solid' },
  range: { color: '#4c8dff', width: 1, dash: 'solid' },
  text: { color: '#e6e9ef', width: 2, dash: 'solid', text: 'Teks' },
}
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
const FIBEXT_LEVELS = [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618]
const HANDLE_R = 5
const HIT_PX = 6
const MAGNET_PX = 14
const FAR = 1e5

type XY = { x: number; y: number }
/** A grab point: where it is on screen and what dragging it changes. */
type Handle = { x: number; y: number; cursor: string; set: (pts: Pt[], pt: Pt) => void }
type Hit = { id: string; handle: Handle | null }

interface Drag {
  id: string
  handle: Handle | null
  startL: number
  startP: number
  orig: Pt[]
}

export class DrawingLayer implements ISeriesPrimitive<Time> {
  drawings: Drawing[] = []
  selected: string | null = null
  tool: Tool = 'cursor'
  magnet: Magnet = 'off'
  /** remembered style per tool: new drawings start with the last style used */
  styles: Partial<Record<DrawKind, DrawStyle>> = {}
  onChange: () => void = () => {}
  onToolChange: (t: Tool) => void = () => {}
  onSelect: (d: Drawing | null) => void = () => {}
  /** double click on a drawing */
  onOpen: (d: Drawing) => void = () => {}
  /** hide every drawing (toolbar eye) */
  hideAll = false
  /** current timeframe, for per-timeframe visibility */
  tf = ''
  private past: string[] = []
  private future: string[] = []
  private snap = '[]'

  private chart!: IChartApi
  private series!: ISeriesApi<'Candlestick'>
  private requestUpdate: () => void = () => {}
  private draft: Drawing | null = null
  private drag: Drag | null = null
  private digits = 2
  private ctrl = false
  private readonly view: IPrimitivePaneView
  private readonly axis: Axis
  private readonly host: HTMLElement

  constructor(axis: Axis, host: HTMLElement) {
    this.axis = axis
    this.host = host
    const renderer: IPrimitivePaneRenderer = {
      draw: (target: CanvasRenderingTarget2D) => {
        target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize.width, mediaSize.height))
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
    this.snap = JSON.stringify(list)
    this.past = []
    this.future = []
    this.select(null)
  }

  setTF(tf: string) {
    this.tf = tf
    this.refresh()
  }

  isVisible(d: Drawing): boolean {
    return !d.hidden && !this.hideAll && (!d.tfs || d.tfs.includes(this.tf))
  }

  /** change one drawing's flags or points from outside (object list, settings dialog) */
  patch(id: string, fn: (d: Drawing) => void) {
    const d = this.drawings.find((x) => x.id === id)
    if (!d) return
    fn(d)
    if (!this.isVisible(d) && this.selected === id) this.select(null)
    this.changed()
  }

  get canUndo() {
    return this.past.length > 0
  }
  get canRedo() {
    return this.future.length > 0
  }

  undo() {
    const prev = this.past.pop()
    if (prev === undefined) return
    this.future.push(this.snap)
    this.restore(prev)
  }

  redo() {
    const next = this.future.pop()
    if (next === undefined) return
    this.past.push(this.snap)
    this.restore(next)
  }

  private restore(json: string) {
    this.snap = json
    this.drawings = JSON.parse(json) as Drawing[]
    if (!this.drawings.some((d) => d.id === this.selected)) this.selected = null
    this.onSelect(this.selectedDrawing)
    this.onChange()
    this.refresh()
  }

  styleOf(d: Drawing): DrawStyle {
    return d.style ?? DEFAULT_STYLE[d.kind]
  }

  get selectedDrawing(): Drawing | null {
    return this.drawings.find((d) => d.id === this.selected) ?? null
  }

  select(id: string | null) {
    this.selected = id
    this.onSelect(this.selectedDrawing)
    this.refresh()
  }

  /** Restyle the selected drawing; the new style becomes that tool's default. */
  setStyle(patch: Partial<DrawStyle>) {
    const d = this.selectedDrawing
    if (!d) return
    d.style = { ...this.styleOf(d), ...patch }
    this.styles[d.kind] = { ...d.style, text: DEFAULT_STYLE[d.kind].text }
    this.changed()
  }

  duplicate(id = this.selected) {
    const d = this.drawings.find((x) => x.id === id)
    if (!d) return
    // shift the copy a little so it does not hide the original
    const dl = 3
    const copy: Drawing = {
      id: crypto.randomUUID(),
      kind: d.kind,
      style: d.style ? { ...d.style } : undefined,
      pts: d.pts.map((p) => ({ t: this.axis.toTime(this.axis.toLogical(p.t) + dl), p: p.p })),
    }
    this.drawings.push(copy)
    this.select(copy.id)
    this.changed()
  }

  /** Place a one-click drawing (right-click menu: horizontal line here). */
  addAt(kind: DrawKind, pt: Pt) {
    const d: Drawing = { id: crypto.randomUUID(), kind, pts: [pt], style: this.newStyle(kind) }
    this.drawings.push(d)
    this.select(d.id)
    this.changed()
  }

  removeSelected() {
    if (!this.selected) return
    this.drawings = this.drawings.filter((d) => d.id !== this.selected)
    this.select(null)
    this.changed()
  }

  clear() {
    this.drawings = []
    this.draft = null
    this.select(null)
    this.changed()
  }

  refresh() {
    this.requestUpdate()
  }

  /** Drawing id under a point in chart-element coordinates (right-click menu). */
  hitAt(x: number, y: number): string | null {
    return this.findHit(x, y)?.id ?? null
  }

  /** Data point under a point in chart-element coordinates, magnet applied. */
  pointAt(x: number, y: number): Pt | null {
    return this.toPt(x, y)
  }

  private changed() {
    // undo history: one step per finished change
    const now = JSON.stringify(this.drawings)
    if (now !== this.snap) {
      this.past.push(this.snap)
      if (this.past.length > 100) this.past.shift()
      this.future = []
      this.snap = now
    }
    this.onChange()
    this.refresh()
  }

  private newStyle(kind: DrawKind): DrawStyle {
    return { ...(this.styles[kind] ?? DEFAULT_STYLE[kind]), text: DEFAULT_STYLE[kind].text }
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

  /** Screen point to data point. Magnet snaps to the nearest open/high/low/close of the candle under the cursor. */
  private toPt(x: number, y: number, snap = true): Pt | null {
    const l = this.chart.timeScale().coordinateToLogical(x)
    const p = this.series.coordinateToPrice(y)
    if (l === null || p === null) return null
    const mode = this.ctrl ? (this.magnet === 'off' ? 'strong' : 'off') : this.magnet
    if (snap && mode !== 'off' && this.axis.bar) {
      const i = Math.round(l)
      const b = this.axis.bar(i)
      if (b) {
        let best: number | null = null
        let bestD = Infinity
        for (const v of [b.open, b.high, b.low, b.close]) {
          const vy = this.y(v)
          if (vy === null) continue
          const d = Math.abs(vy - y)
          if (d < bestD) {
            bestD = d
            best = v
          }
        }
        if (best !== null && (mode === 'strong' || bestD <= MAGNET_PX)) return { t: this.axis.toTime(i), p: best }
      }
    }
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
    h.addEventListener(
      'dblclick',
      (e) => {
        if (this.tool !== 'cursor') return
        const r = h.getBoundingClientRect()
        const hit = this.findHit(e.clientX - r.left, e.clientY - r.top)
        const d = hit && this.drawings.find((x) => x.id === hit.id)
        if (!d) return
        e.stopPropagation()
        this.select(d.id)
        this.onOpen(d)
      },
      true,
    )
    const ctrl = (e: KeyboardEvent) => {
      // hold Ctrl to flip the magnet while drawing (TradingView habit)
      const on = e.ctrlKey || e.metaKey
      if (on !== this.ctrl) this.ctrl = on
    }
    window.addEventListener('keyup', ctrl)
    window.addEventListener('keydown', (e) => {
      ctrl(e)
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.key === 'Escape') {
        if (this.draft || this.tool !== 'cursor') this.setTool('cursor')
        else if (this.selected) this.select(null)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        this.removeSelected()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) this.redo()
        else this.undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        this.redo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && this.selected) {
        e.preventDefault()
        this.duplicate()
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
    this.ctrl = e.ctrlKey || e.metaKey
    const pt = this.toPt(x, y)
    if (!pt) return

    if (this.tool !== 'cursor') {
      this.block(e)
      const kind = this.tool
      if (!this.draft) {
        this.draft = { id: crypto.randomUUID(), kind, pts: [pt], style: this.newStyle(kind) }
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
      if (this.selected) this.select(null)
      return
    }
    this.block(e)
    if (this.selected !== hit.id) this.select(hit.id)
    const d = this.drawings.find((dd) => dd.id === hit.id)!
    if (d.locked) return
    const l = this.chart.timeScale().coordinateToLogical(x) ?? 0
    const p = this.series.coordinateToPrice(y) ?? pt.p
    this.drag = { id: hit.id, handle: hit.handle, startL: l, startP: p, orig: d.pts.map((q) => ({ ...q })) }
    this.host.setPointerCapture(e.pointerId)
    this.refresh()
  }

  private onMove(e: PointerEvent) {
    const { x, y } = this.local(e)
    this.ctrl = e.ctrlKey || e.metaKey
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
      if (!d) return
      const g = this.drag
      if (g.handle !== null) {
        const pt = this.toPt(x, y)
        if (!pt) return
        const pts = g.orig.map((q) => ({ ...q }))
        g.handle.set(pts, pt)
        d.pts = pts
      } else {
        const l = this.chart.timeScale().coordinateToLogical(x)
        const p = this.series.coordinateToPrice(y)
        if (l === null || p === null) return
        const dl = l - g.startL
        const dp = p - g.startP
        d.pts = g.orig.map((o) => ({ t: this.axis.toTime(this.axis.toLogical(o.t) + dl), p: o.p + dp }))
      }
      this.refresh()
      return
    }
    if (this.tool === 'cursor' && this.inMainPane(y, x)) {
      const hit = this.findHit(x, y)
      const locked = hit && this.drawings.find((dd) => dd.id === hit.id)?.locked
      this.host.style.cursor = !hit ? '' : locked ? 'pointer' : hit.handle ? hit.handle.cursor : 'move'
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
    const d = this.draft
    if (!d) return
    if (d.kind === 'long' || d.kind === 'short') {
      // second click = target; the stop starts at the mirror of the target (1:1)
      const [a, b] = d.pts
      const up = d.kind === 'long'
      const target = up ? Math.max(b.p, a.p + Math.abs(b.p - a.p)) : Math.min(b.p, a.p - Math.abs(b.p - a.p))
      const risk = Math.abs(target - a.p) || 1
      const t = b.t > a.t ? b.t : this.axis.toTime(this.axis.toLogical(a.t) + 20)
      d.pts = [a, { t, p: target }, { t, p: up ? a.p - risk : a.p + risk }]
    }
    this.drawings.push(d)
    this.draft = null
    this.setTool('cursor')
    this.select(d.id)
    this.changed()
  }

  // ---- geometry ----

  private screenPts(d: Drawing): XY[] | null {
    const out = []
    for (const p of d.pts) {
      const x = this.x(p.t)
      const y = this.y(p.p)
      if (x === null || y === null) return null
      out.push({ x, y })
    }
    return out
  }

  /** the second rail of a parallel channel: the base line shifted to pass through point 3 */
  private channelOffset(s: XY[]): number {
    if (s.length < 3) return 0
    const [a, b, c] = s
    const k = b.x === a.x ? 0 : (c.x - a.x) / (b.x - a.x)
    return c.y - (a.y + (b.y - a.y) * k)
  }

  /** Line segments that make up a drawing (hit testing for line-like tools). */
  private segments(d: Drawing, s: XY[], w: number, h: number): [XY, XY][] {
    const [a, b] = s
    switch (d.kind) {
      case 'trend': {
        const st = this.styleOf(d)
        return [[st.extendL ? extend(b, a) : a, st.extendR ? extend(a, b) : b]]
      }
      case 'arrow':
        return [[a, b]]
      case 'ray':
        return [[a, extend(a, b)]]
      case 'extline':
        return [[extend(b, a), extend(a, b)]]
      case 'hline':
        return [[{ x: 0, y: a.y }, { x: w, y: a.y }]]
      case 'hray':
        return [[a, { x: w, y: a.y }]]
      case 'vline':
        return [[{ x: a.x, y: 0 }, { x: a.x, y: h }]]
      case 'cross':
        return [
          [{ x: 0, y: a.y }, { x: w, y: a.y }],
          [{ x: a.x, y: 0 }, { x: a.x, y: h }],
        ]
      case 'channel': {
        const off = this.channelOffset(s)
        return [[a, b], [{ x: a.x, y: a.y + off }, { x: b.x, y: b.y + off }]]
      }
      default:
        return []
    }
  }

  // ---- handles ----

  /**
   * Grab points of a drawing. Boxes get all four corners and the four edge middles
   * (an edge moves one side only), like TradingView.
   */
  private handles(d: Drawing, s: XY[]): Handle[] {
    const pt = (i: number): Handle => ({ x: s[i].x, y: s[i].y, cursor: 'grab', set: (p, q) => (p[i] = q) })
    switch (d.kind) {
      case 'hline':
      case 'vline':
      case 'cross':
      case 'text':
        return []
      case 'hray':
        return [pt(0)]
      case 'rect':
      case 'ellipse':
      case 'range': {
        if (s.length < 2) return []
        const [a, b] = s
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        // which corner is top-left on screen decides the resize cursors
        const diag = a.x < b.x === a.y < b.y ? 'nwse-resize' : 'nesw-resize'
        const anti = diag === 'nwse-resize' ? 'nesw-resize' : 'nwse-resize'
        return [
          { x: a.x, y: a.y, cursor: diag, set: (p, q) => (p[0] = q) },
          { x: b.x, y: b.y, cursor: diag, set: (p, q) => (p[1] = q) },
          { x: b.x, y: a.y, cursor: anti, set: (p, q) => ((p[1].t = q.t), (p[0].p = q.p)) },
          { x: a.x, y: b.y, cursor: anti, set: (p, q) => ((p[0].t = q.t), (p[1].p = q.p)) },
          { x: mx, y: a.y, cursor: 'ns-resize', set: (p, q) => (p[0].p = q.p) },
          { x: mx, y: b.y, cursor: 'ns-resize', set: (p, q) => (p[1].p = q.p) },
          { x: a.x, y: my, cursor: 'ew-resize', set: (p, q) => (p[0].t = q.t) },
          { x: b.x, y: my, cursor: 'ew-resize', set: (p, q) => (p[1].t = q.t) },
        ]
      }
      case 'channel': {
        if (s.length < 3) return s.map((_, i) => pt(i))
        const off = this.channelOffset(s)
        const [a, b] = s
        // the second rail: any point on it sets the channel width
        const rail = (x: number, y: number): Handle => ({ x, y, cursor: 'ns-resize', set: (p, q) => (p[2] = q) })
        return [pt(0), pt(1), rail(a.x, a.y + off), rail(b.x, b.y + off), rail((a.x + b.x) / 2, (a.y + b.y) / 2 + off)]
      }
      case 'long':
      case 'short': {
        if (s.length < 2) return []
        const ys = d.pts[2] ? this.y(d.pts[2].p) : null
        const x0 = Math.min(s[0].x, s[1].x)
        const x1 = Math.max(s[0].x, s[1].x, x0 + 40)
        const out: Handle[] = [
          // entry: moves the trade start (time and price)
          { x: s[0].x, y: s[0].y, cursor: 'grab', set: (p, q) => (p[0] = q) },
          // target: price only
          { x: x0, y: s[1].y, cursor: 'ns-resize', set: (p, q) => (p[1] = { t: p[1].t, p: q.p }) },
          // right edge: how long the idea lasts
          {
            x: x1,
            y: s[0].y,
            cursor: 'ew-resize',
            set: (p, q) => {
              p[1] = { t: q.t, p: p[1].p }
              if (p[2]) p[2] = { t: q.t, p: p[2].p }
            },
          },
        ]
        if (ys !== null) out.push({ x: x0, y: ys, cursor: 'ns-resize', set: (p, q) => (p[2] = { t: p[1].t, p: q.p }) })
        return out
      }
      default:
        return s.map((_, i) => pt(i))
    }
  }

  // ---- hit testing ----

  private findHit(x: number, y: number): Hit | null {
    const w = this.chart.timeScale().width()
    const h = this.chart.panes()[0].getHeight()
    // the selected drawing comes first, so a small box inside a big one stays resizable
    const order = [...this.drawings.keys()].reverse()
    const sel = this.drawings.findIndex((d) => d.id === this.selected)
    if (sel >= 0) order.unshift(sel)
    for (const i of order) {
      const d = this.drawings[i]
      if (!this.isVisible(d)) continue
      const s = this.screenPts(d)
      if (!s) continue
      if (!d.locked) for (const hd of this.handles(d, s)) if (Math.hypot(hd.x - x, hd.y - y) <= HANDLE_R + 3) return { id: d.id, handle: hd }
      if (this.hitBody(d, s, x, y, w, h)) return { id: d.id, handle: null }
    }
    return null
  }

  private hitBody(d: Drawing, s: XY[], x: number, y: number, w: number, h: number): boolean {
    const segs = this.segments(d, s, w, h)
    if (segs.length) {
      if (segs.some(([a, b]) => distToSegment(x, y, a, b) <= HIT_PX)) return true
      if (d.kind !== 'channel') return false
      const off = this.channelOffset(s)
      return inPolygon(x, y, [s[0], s[1], { x: s[1].x, y: s[1].y + off }, { x: s[0].x, y: s[0].y + off }])
    }
    const box = (a: XY, b: XY) => {
      const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)]
      const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)]
      return x >= x0 - HIT_PX && x <= x1 + HIT_PX && y >= y0 - HIT_PX && y <= y1 + HIT_PX
    }
    switch (d.kind) {
      case 'rect': {
        const st = this.styleOf(d)
        const [l, r] = s[0].x <= s[1].x ? [s[0], s[1]] : [s[1], s[0]]
        return box(st.extendL ? { x: 0, y: l.y } : l, st.extendR ? { x: w, y: r.y } : r)
      }
      case 'range':
        return box(s[0], s[1])
      case 'ellipse': {
        const cx = (s[0].x + s[1].x) / 2
        const cy = (s[0].y + s[1].y) / 2
        const rx = Math.abs(s[1].x - s[0].x) / 2 + HIT_PX
        const ry = Math.abs(s[1].y - s[0].y) / 2 + HIT_PX
        return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
      }
      case 'long':
      case 'short':
        return box(s[0], s[1]) || box(s[0], { x: s[1].x, y: s[2]?.y ?? s[0].y })
      case 'fib':
      case 'fibext': {
        const lv = this.fibLines(d, s)
        if (!lv.length) return false
        const [x0, x1] = [lv[0].x0, lv[0].x1]
        if (x < x0 - HIT_PX || x > x1 + HIT_PX) return false
        return lv.some((l) => Math.abs(l.y - y) <= HIT_PX)
      }
      case 'text': {
        const m = this.textBox(d, s[0])
        return x >= m.x - 4 && x <= m.x + m.w + 4 && y >= m.y - 4 && y <= m.y + m.h + 4
      }
      default:
        return false
    }
  }

  private textBox(d: Drawing, a: XY) {
    const st = this.styleOf(d)
    const size = st.fontSize ?? 10 + st.width * 2
    const lines = (st.text || ' ').split('\n')
    // rough width without a context: ~0.6em per char
    const w = Math.max(...lines.map((l) => l.length)) * size * 0.6
    return { x: a.x, y: a.y - size, w, h: lines.length * size * 1.25, size, lines }
  }

  private fibLines(d: Drawing, s: XY[]) {
    const out: { lv: number; price: number; y: number; x0: number; x1: number }[] = []
    const st = this.styleOf(d)
    const W = this.chart.timeScale().width()
    const ext = (x0: number, x1: number) => [st.extendL ? 0 : x0, st.extendR ? W : x1] as const
    if (d.kind === 'fib') {
      const [x0, x1] = ext(Math.min(s[0].x, s[1].x), Math.max(s[0].x, s[1].x))
      for (const lv of FIB_LEVELS) {
        const price = d.pts[1].p + (d.pts[0].p - d.pts[1].p) * lv
        const y = this.y(price)
        if (y !== null) out.push({ lv, price, y, x0, x1 })
      }
    } else if (d.pts.length >= 3) {
      const move = d.pts[1].p - d.pts[0].p
      const [x0, x1] = ext(s[2].x, Math.max(s[1].x, s[2].x) + Math.max(60, Math.abs(s[2].x - s[1].x)))
      for (const lv of FIBEXT_LEVELS) {
        const price = d.pts[2].p + move * lv
        const y = this.y(price)
        if (y !== null) out.push({ lv, price, y, x0, x1 })
      }
    }
    return out
  }

  // ---- painting ----

  private paint(ctx: CanvasRenderingContext2D, width: number, height: number) {
    for (const d of this.drawings) if (this.isVisible(d)) this.paintOne(ctx, d, width, height, d.id === this.selected)
    if (this.draft) this.paintOne(ctx, this.draft, width, height, true)
  }

  private paintOne(ctx: CanvasRenderingContext2D, d: Drawing, width: number, height: number, selected: boolean) {
    const s = this.screenPts(d)
    if (!s) return
    const st = this.styleOf(d)
    const color = st.color
    const px = (p: number) => p.toFixed(this.digits)
    ctx.save()
    ctx.lineWidth = st.width + (selected ? 0.5 : 0)
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.setLineDash(st.dash === 'dash' ? [7, 4] : st.dash === 'dot' ? [2, 3] : [])
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    const fill = st.fill ?? color
    const fillA = (st.fillAlpha ?? 15) / 100
    const label = (text: string, x: number, y: number, bg = color, fg = '#0b0e14') => {
      ctx.save()
      ctx.setLineDash([])
      const w = ctx.measureText(text).width + 10
      ctx.fillStyle = bg
      ctx.fillRect(x, y - 9, w, 18)
      ctx.fillStyle = fg
      ctx.textBaseline = 'middle'
      ctx.fillText(text, x + 5, y)
      ctx.restore()
      return w
    }

    switch (d.kind) {
      case 'hline':
      case 'hray': {
        const y = Math.round(s[0].y) + 0.5
        line(ctx, d.kind === 'hline' ? 0 : s[0].x, y, width, y)
        const t = px(d.pts[0].p)
        label(t, width - ctx.measureText(t).width - 14, y)
        break
      }
      case 'vline':
        line(ctx, Math.round(s[0].x) + 0.5, 0, Math.round(s[0].x) + 0.5, height)
        break
      case 'cross': {
        const y = Math.round(s[0].y) + 0.5
        const x = Math.round(s[0].x) + 0.5
        line(ctx, 0, y, width, y)
        line(ctx, x, 0, x, height)
        const t = px(d.pts[0].p)
        label(t, width - ctx.measureText(t).width - 14, y)
        break
      }
      case 'trend': {
        const a = st.extendL ? extend(s[1], s[0]) : s[0]
        const b = st.extendR ? extend(s[0], s[1]) : s[1]
        line(ctx, a.x, a.y, b.x, b.y)
        break
      }
      case 'ray': {
        const e = extend(s[0], s[1])
        line(ctx, s[0].x, s[0].y, e.x, e.y)
        break
      }
      case 'extline': {
        const a = extend(s[1], s[0])
        const b = extend(s[0], s[1])
        line(ctx, a.x, a.y, b.x, b.y)
        break
      }
      case 'arrow': {
        line(ctx, s[0].x, s[0].y, s[1].x, s[1].y)
        const ang = Math.atan2(s[1].y - s[0].y, s[1].x - s[0].x)
        const len = 8 + st.width * 3
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.moveTo(s[1].x, s[1].y)
        ctx.lineTo(s[1].x - len * Math.cos(ang - 0.45), s[1].y - len * Math.sin(ang - 0.45))
        ctx.lineTo(s[1].x - len * Math.cos(ang + 0.45), s[1].y - len * Math.sin(ang + 0.45))
        ctx.closePath()
        ctx.fill()
        break
      }
      case 'channel': {
        const [a, b] = s
        line(ctx, a.x, a.y, b.x, b.y)
        if (s.length >= 3) {
          const off = this.channelOffset(s)
          line(ctx, a.x, a.y + off, b.x, b.y + off)
          ctx.fillStyle = fill
          ctx.globalAlpha = fillA
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.lineTo(b.x, b.y + off)
          ctx.lineTo(a.x, a.y + off)
          ctx.closePath()
          ctx.fill()
          ctx.globalAlpha = 0.6
          ctx.setLineDash([4, 4])
          line(ctx, a.x, a.y + off / 2, b.x, b.y + off / 2)
        }
        break
      }
      case 'rect': {
        const x0 = st.extendL ? 0 : Math.min(s[0].x, s[1].x)
        const x1 = st.extendR ? width : Math.max(s[0].x, s[1].x)
        const y0 = Math.min(s[0].y, s[1].y)
        const h = Math.abs(s[1].y - s[0].y)
        ctx.fillStyle = fill
        ctx.globalAlpha = fillA
        ctx.fillRect(x0, y0, x1 - x0, h)
        ctx.globalAlpha = 1
        ctx.strokeRect(x0, y0, x1 - x0, h)
        break
      }
      case 'ellipse': {
        const cx = (s[0].x + s[1].x) / 2
        const cy = (s[0].y + s[1].y) / 2
        ctx.beginPath()
        ctx.ellipse(cx, cy, Math.abs(s[1].x - s[0].x) / 2, Math.abs(s[1].y - s[0].y) / 2, 0, 0, Math.PI * 2)
        ctx.fillStyle = fill
        ctx.globalAlpha = fillA
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.stroke()
        break
      }
      case 'fib':
      case 'fibext': {
        ctx.save()
        ctx.setLineDash([4, 3])
        ctx.globalAlpha = 0.5
        ctx.beginPath()
        ctx.moveTo(s[0].x, s[0].y)
        for (const p of s.slice(1)) ctx.lineTo(p.x, p.y)
        ctx.stroke()
        ctx.restore()
        ctx.textBaseline = 'bottom'
        for (const l of this.fibLines(d, s)) {
          const yy = Math.round(l.y) + 0.5
          line(ctx, l.x0, yy, l.x1, yy)
          ctx.fillText(`${l.lv} (${px(l.price)})`, l.x0 + 4, yy - 2)
        }
        break
      }
      case 'long':
      case 'short':
        this.paintPosition(ctx, d, s, label)
        break
      case 'range': {
        const [a, b] = s
        const up = d.pts[1].p >= d.pts[0].p
        ctx.fillStyle = up ? 'rgba(76,141,255,0.16)' : 'rgba(239,83,80,0.16)'
        ctx.strokeStyle = up ? '#4c8dff' : '#ef5350'
        ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        ctx.setLineDash([])
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        arrowLine(ctx, mx, a.y, mx, b.y)
        arrowLine(ctx, a.x, my, b.x, my)
        const dp = d.pts[1].p - d.pts[0].p
        const pct = (dp / d.pts[0].p) * 100
        const bars = Math.round(this.axis.toLogical(d.pts[1].t) - this.axis.toLogical(d.pts[0].t))
        const text = `${dp >= 0 ? '+' : ''}${px(dp)} (${pct.toFixed(2)}%) · ${bars} bar · ${fmtSpan(Math.abs(d.pts[1].t - d.pts[0].t))}`
        const w = ctx.measureText(text).width + 10
        label(text, mx - w / 2, Math.max(a.y, b.y) + 16, up ? '#4c8dff' : '#ef5350', '#fff')
        break
      }
      case 'text': {
        const m = this.textBox(d, s[0])
        ctx.setLineDash([])
        ctx.font = `600 ${m.size}px ui-sans-serif, system-ui, sans-serif`
        ctx.textBaseline = 'top'
        m.lines.forEach((l, i) => ctx.fillText(l, m.x, m.y + i * m.size * 1.25))
        if (selected) {
          ctx.globalAlpha = 0.5
          ctx.setLineDash([3, 3])
          ctx.lineWidth = 1
          const w = Math.max(...m.lines.map((l) => ctx.measureText(l).width))
          ctx.strokeRect(m.x - 4, m.y - 4, w + 8, m.h + 8)
        }
        break
      }
    }

    // optional label on lines and boxes
    if (st.text && CAN.label(d.kind)) {
      ctx.save()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      ctx.fillStyle = color
      ctx.font = `600 ${st.fontSize ?? 12}px ui-sans-serif, system-ui, sans-serif`
      ctx.textBaseline = 'bottom'
      const a = s[0]
      const b = s[1] ?? s[0]
      if (d.kind === 'rect' || d.kind === 'ellipse' || d.kind === 'channel') {
        ctx.textBaseline = 'top'
        ctx.fillText(st.text, Math.min(a.x, b.x) + 6, Math.min(a.y, b.y) + 4)
      } else if (d.kind === 'hline' || d.kind === 'hray' || d.kind === 'cross') {
        ctx.fillText(st.text, (d.kind === 'hray' ? a.x : 0) + 8, a.y - 3)
      } else if (d.kind === 'vline') {
        ctx.fillText(st.text, a.x + 4, 16)
      } else {
        ctx.textAlign = 'center'
        ctx.fillText(st.text, (a.x + b.x) / 2, (a.y + b.y) / 2 - 5)
      }
      ctx.restore()
    }

    if (selected) {
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      for (const p of d.locked ? [] : this.handles(d, s)) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.cursor === 'grab' ? HANDLE_R : HANDLE_R - 1, 0, Math.PI * 2)
        ctx.fillStyle = '#0b0e14'
        ctx.fill()
        ctx.lineWidth = 1.5
        ctx.strokeStyle = color
        ctx.stroke()
      }
      if (d.locked) {
        // padlock badge next to the first point
        const p = s[0]
        ctx.fillStyle = color
        ctx.fillRect(p.x + 6, p.y - 12, 8, 6)
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(p.x + 10, p.y - 12, 3, Math.PI, 0)
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  /** Long/short position box: target zone, stop zone, prices and reward:risk. */
  private paintPosition(ctx: CanvasRenderingContext2D, d: Drawing, s: XY[], label: (t: string, x: number, y: number, bg?: string, fg?: string) => number) {
    const entry = d.pts[0].p
    const target = d.pts[1].p
    // while placing, the stop is the mirror of the target
    const stop = d.pts[2]?.p ?? entry - (target - entry)
    const ye = s[0].y
    const yt = s[1].y
    const ys = this.y(stop) ?? ye
    const x0 = Math.min(s[0].x, s[1].x)
    const x1 = Math.max(s[0].x, s[1].x, x0 + 40)
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(38,166,154,0.22)'
    ctx.fillRect(x0, Math.min(ye, yt), x1 - x0, Math.abs(yt - ye))
    ctx.fillStyle = 'rgba(239,83,80,0.22)'
    ctx.fillRect(x0, Math.min(ye, ys), x1 - x0, Math.abs(ys - ye))
    ctx.strokeStyle = '#9aa4b2'
    ctx.lineWidth = 1
    line(ctx, x0, ye, x1, ye)
    const px = (p: number) => p.toFixed(this.digits)
    const reward = Math.abs(target - entry)
    const risk = Math.abs(entry - stop)
    const pct = (v: number) => ((v / entry) * 100).toFixed(2)
    const above = (a: number, b: number) => (a < b ? a - 12 : a + 12)
    label(`Target ${px(target)} (${px(reward)}, ${pct(reward)}%)`, x0 + 4, above(yt, ye), '#26a69a', '#fff')
    label(`Stop ${px(stop)} (${px(risk)}, ${pct(risk)}%)`, x0 + 4, above(ys, ye), '#ef5350', '#fff')
    label(`${d.kind === 'long' ? 'Long' : 'Short'} ${px(entry)} · R:R ${risk ? (reward / risk).toFixed(2) : '–'}`, x0 + 4, ye, '#2a2f3a', '#e6e9ef')
  }
}

function fmtSpan(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.round((sec % 3600) / 60)
  if (d) return `${d}h ${h}j`
  if (h) return `${h}j ${m}m`
  return `${m}m`
}

/** point far along a→b (canvas clips it) */
function extend(a: XY, b: XY): XY {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: b.x + (dx / len) * FAR, y: b.y + (dy / len) * FAR }
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()
}

function arrowLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  if (Math.hypot(x1 - x0, y1 - y0) < 12) return
  line(ctx, x0, y0, x1, y1)
  const ang = Math.atan2(y1 - y0, x1 - x0)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x1 - 7 * Math.cos(ang - 0.5), y1 - 7 * Math.sin(ang - 0.5))
  ctx.moveTo(x1, y1)
  ctx.lineTo(x1 - 7 * Math.cos(ang + 0.5), y1 - 7 * Math.sin(ang + 0.5))
  ctx.stroke()
}

function distToSegment(px: number, py: number, a: XY, b: XY) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

function inPolygon(x: number, y: number, poly: XY[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
