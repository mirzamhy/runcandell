import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type SeriesType,
  type Time,
} from 'lightweight-charts'
import * as C from './calc'
import { BandFill, LinePlot, SessionShade, type LineSpec } from './primitives'
import { pxAuto } from '../current'

/** Everything an indicator needs to compute, built once per render. */
export interface Ctx {
  times: Time[] // chart display times, aligned with bars
  rawTimes: Float64Array // UTC seconds
  o: Float64Array
  h: Float64Array
  l: Float64Array
  c: Float64Array
  v: Float64Array
  day: Float64Array // trading-day id
  intraday: boolean // below D1
  tfSec: number
  /** same bar window as last time, only the tail changed (replay step): series may update just the tail */
  incremental: boolean
}

export interface ParamDef {
  key: string
  label: string
  value: number
  min: number
  max: number
  step: number
}

export interface ColorDef {
  key: string
  label: string
  value: string
}

export interface IndicatorConfig {
  id: string
  type: string
  params: Record<string, number>
  colors: Record<string, string>
}

export interface Instance {
  update(ctx: Ctx): void
  /** Values at bar i for the legend chip: [label, value, color]. */
  values(i: number): [string, string, string][]
  restyle(): void
  destroy(): void
  /** Pane index (looked up live; panes shift when others are removed). */
  pane(): number
}

export interface IndicatorDef {
  type: string
  name: string
  place: 'overlay' | 'pane'
  params: ParamDef[]
  colors: ColorDef[]
  label(cfg: IndicatorConfig): string
  create(env: Env, cfg: IndicatorConfig): Instance
}

export interface Env {
  chart: IChartApi
  candles: ISeriesApi<'Candlestick'>
}

// ---------- helpers ----------

const P = (key: string, label: string, value: number, min = 1, max = 500, step = 1): ParamDef => ({
  key,
  label,
  value,
  min,
  max,
  step,
})
const K = (key: string, label: string, value: string): ColorDef => ({ key, label, value })

function lineData(times: Time[], arr: ArrayLike<number>): LineData<Time>[] {
  const out: LineData<Time>[] = []
  for (let i = 0; i < arr.length && i < times.length; i++) {
    if (Number.isFinite(arr[i])) out.push({ time: times[i], value: arr[i] })
  }
  return out
}

interface SyncState {
  len: number
  first: Time | null
}

/**
 * setData is O(n) and slow with many series; on a replay step only the last points change,
 * so update the tail instead. Indicators here are causal: older values never change.
 */
function syncSeries(s: ISeriesApi<SeriesType>, pts: { time: Time }[], st: SyncState, incremental: boolean) {
  const n = pts.length
  if (incremental && n && st.len && pts[0].time === st.first && n >= st.len && n - st.len <= 500) {
    for (let i = st.len - 1; i < n; i++) s.update(pts[i] as never)
  } else {
    s.setData(pts as never)
  }
  st.len = n
  st.first = pts[0]?.time ?? null
}

const fmt2 = (v: number) => (Number.isFinite(v) ? pxAuto(v) : '–')
const fmtInt = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString('id-ID') : '–')

/** Hex color + alpha → rgba() for fills. */
export function alpha(hex: string, a: number): string {
  const m = hex.replace('#', '')
  const n = parseInt(m.length === 3 ? m.replace(/(.)/g, '$1$1') : m, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

const DASH = [4, 3]
const DOT = [1, 3]

type Shown = { key: string; label: string; color: string; fmt?: (v: number) => string; offset?: number }

/**
 * Lines drawn by a LinePlot primitive.
 * Overlay: plot attached to the candle series, no extra chart series.
 * Pane: one real "host" series creates the pane and its price scale; other lines go on the plot.
 * (Every extra chart series makes each setData slower, so keep series to a minimum.)
 */
class Lines implements Instance {
  readonly plot = new LinePlot()
  private readonly specs: { idx: number; color: string }[] = []
  private host: ISeriesApi<SeriesType> | null = null
  private hostColor = ''
  private readonly hostSync: SyncState = { len: 0, first: null }
  data: Record<string, ArrayLike<number>> = {}

  constructor(
    protected readonly env: Env,
    protected readonly cfg: IndicatorConfig,
    readonly place: 'overlay' | 'pane',
    private readonly shown: Shown[],
  ) {
    if (place === 'overlay') env.candles.attachPrimitive(this.plot)
  }

  /** Pane only: the series that owns the pane and its price scale. */
  hostLine(color: string, opts: Record<string, unknown> = {}) {
    const s = this.env.chart.addSeries(
      LineSeries,
      {
        color: this.cfg.colors[color],
        lineWidth: 1,
        crosshairMarkerVisible: false,
        priceLineVisible: false,
        lastValueVisible: true,
        ...opts,
      },
      this.env.chart.panes().length,
    )
    this.adoptHost(s, color)
    return s
  }

  hostHistogram(color: string) {
    const s = this.env.chart.addSeries(
      HistogramSeries,
      { color: this.cfg.colors[color], priceLineVisible: false, lastValueVisible: false },
      this.env.chart.panes().length,
    )
    this.adoptHost(s, color)
    return s
  }

  private adoptHost(s: ISeriesApi<SeriesType>, color: string) {
    this.host = s
    this.hostColor = color
    s.attachPrimitive(this.plot)
  }

  line(color: string, spec: Partial<LineSpec> = {}) {
    const idx = this.plot.add({ color: this.cfg.colors[color], width: 1, ...spec })
    this.specs.push({ idx, color })
    return idx
  }

  setLine(idx: number, data: ArrayLike<number>) {
    this.plot.set(idx, data)
  }

  setHost(data: ArrayLike<number>, ctx: Ctx) {
    if (this.host) syncSeries(this.host, lineData(ctx.times, data), this.hostSync, ctx.incremental)
  }

  /** For hosts that need custom points (MACD histogram colors). */
  setHostPoints(pts: { time: Time }[], ctx: Ctx) {
    if (this.host) syncSeries(this.host, pts, this.hostSync, ctx.incremental)
  }

  guide(price: number): IPriceLine | null {
    if (!this.host) return null
    return this.host.createPriceLine({ price, color: '#3a4256', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false })
  }

  update(_ctx: Ctx) {}

  values(i: number): [string, string, string][] {
    return this.shown.map((x) => [
      x.label,
      (x.fmt ?? fmt2)(this.data[x.key]?.[i - (x.offset ?? 0)] ?? NaN),
      this.cfg.colors[x.color],
    ])
  }

  restyle() {
    for (const { idx, color } of this.specs) this.plot.lines[idx].spec.color = this.cfg.colors[color]
    if (this.host && this.hostColor) this.host.applyOptions({ color: this.cfg.colors[this.hostColor] })
    this.plot.refresh()
  }

  destroy() {
    if (this.host) {
      this.host.detachPrimitive(this.plot)
      this.env.chart.removeSeries(this.host)
      this.host = null
    } else {
      this.env.candles.detachPrimitive(this.plot)
    }
  }

  pane(): number {
    return this.host ? this.host.getPane().paneIndex() : 0
  }
}

/** Overlay with a filled band between two lines (Bollinger, Donchian). */
class Banded extends Lines {
  readonly fill: BandFill

  constructor(
    env: Env,
    cfg: IndicatorConfig,
    shown: Shown[],
    private readonly fillKey: string,
    private readonly fillAlpha: number,
  ) {
    super(env, cfg, 'overlay', shown)
    this.fill = new BandFill({ fillUp: alpha(cfg.colors[fillKey], fillAlpha) })
    env.candles.attachPrimitive(this.fill)
  }

  restyle() {
    super.restyle()
    this.fill.style.fillUp = alpha(this.cfg.colors[this.fillKey], this.fillAlpha)
    this.fill.refresh()
  }

  destroy() {
    this.env.candles.detachPrimitive(this.fill)
    super.destroy()
  }
}

// ---------- overlays ----------

function movingAverage(kind: 'sma' | 'ema'): IndicatorDef {
  return {
    type: kind,
    name: kind === 'sma' ? 'Simple Moving Average' : 'Exponential Moving Average',
    place: 'overlay',
    params: [P('length', 'Periode', kind === 'sma' ? 50 : 20)],
    colors: [K('line', 'Garis', kind === 'sma' ? '#4c8dff' : '#f5a524')],
    label: (c) => `${kind.toUpperCase()} ${c.params.length}`,
    create(env, cfg) {
      const inst = new Lines(env, cfg, 'overlay', [{ key: 'v', label: '', color: 'line' }])
      const ln = inst.line('line', { width: 2 })
      inst.update = (ctx) => {
        const v = (kind === 'sma' ? C.sma : C.ema)(ctx.c, cfg.params.length)
        inst.data = { v }
        inst.setLine(ln, v)
      }
      return inst
    },
  }
}

const bollinger: IndicatorDef = {
  type: 'bb',
  name: 'Bollinger Bands',
  place: 'overlay',
  params: [P('length', 'Periode', 20), P('mult', 'Deviasi', 2, 0.1, 10, 0.1)],
  colors: [K('mid', 'Tengah', '#f5a524'), K('band', 'Band', '#4c8dff')],
  label: (c) => `BB ${c.params.length} ${c.params.mult}`,
  create(env, cfg) {
    const inst = new Banded(
      env,
      cfg,
      [
        { key: 'upper', label: 'U', color: 'band' },
        { key: 'mid', label: 'M', color: 'mid' },
        { key: 'lower', label: 'L', color: 'band' },
      ],
      'band',
      0.06,
    )
    const mid = inst.line('mid')
    const up = inst.line('band')
    const lo = inst.line('band')
    inst.update = (ctx) => {
      const r = C.bollinger(ctx.c, cfg.params.length, cfg.params.mult)
      inst.data = r
      inst.setLine(mid, r.mid)
      inst.setLine(up, r.upper)
      inst.setLine(lo, r.lower)
      inst.fill.set(r.upper, r.lower)
    }
    return inst
  },
}

const donchian: IndicatorDef = {
  type: 'donchian',
  name: 'Donchian Channel',
  place: 'overlay',
  params: [P('length', 'Periode', 20)],
  colors: [K('band', 'Band', '#2ec4b6'), K('mid', 'Tengah', '#7d8590')],
  label: (c) => `DC ${c.params.length}`,
  create(env, cfg) {
    const inst = new Banded(
      env,
      cfg,
      [
        { key: 'upper', label: 'U', color: 'band' },
        { key: 'lower', label: 'L', color: 'band' },
      ],
      'band',
      0.05,
    )
    const up = inst.line('band')
    const lo = inst.line('band')
    const mid = inst.line('mid', { dash: DASH })
    inst.update = (ctx) => {
      const r = C.donchian(ctx.h, ctx.l, cfg.params.length)
      inst.data = r
      inst.setLine(up, r.upper)
      inst.setLine(lo, r.lower)
      inst.setLine(mid, r.mid)
      inst.fill.set(r.upper, r.lower)
    }
    return inst
  },
}

const vwap: IndicatorDef = {
  type: 'vwap',
  name: 'VWAP (harian, tick volume)',
  place: 'overlay',
  params: [],
  colors: [K('line', 'Garis', '#e879f9')],
  label: () => 'VWAP',
  create(env, cfg) {
    const inst = new Lines(env, cfg, 'overlay', [{ key: 'v', label: '', color: 'line' }])
    const ln = inst.line('line', { width: 2 })
    inst.update = (ctx) => {
      const v = ctx.intraday ? C.vwap(ctx.h, ctx.l, ctx.c, ctx.v, ctx.day) : new Float64Array(ctx.c.length).fill(NaN)
      inst.data = { v }
      inst.setLine(ln, v)
    }
    return inst
  },
}

const supertrend: IndicatorDef = {
  type: 'supertrend',
  name: 'Supertrend',
  place: 'overlay',
  params: [P('length', 'ATR periode', 10), P('mult', 'Pengali', 3, 0.1, 20, 0.1)],
  colors: [K('up', 'Naik', '#26a69a'), K('down', 'Turun', '#ef5350')],
  label: (c) => `Supertrend ${c.params.length} ${c.params.mult}`,
  create(env, cfg) {
    let dir = new Int8Array(0)
    const inst = new Lines(env, cfg, 'overlay', [])
    const ln = inst.line('up', { width: 2, colorAt: (i) => (dir[i] === -1 ? cfg.colors.down : cfg.colors.up) })
    inst.update = (ctx) => {
      const r = C.supertrend(ctx.h, ctx.l, ctx.c, cfg.params.length, cfg.params.mult)
      dir = r.dir
      inst.data = { v: r.line }
      inst.setLine(ln, r.line)
    }
    inst.values = (i) => [['', fmt2(inst.data.v?.[i] ?? NaN), dir[i] === -1 ? cfg.colors.down : cfg.colors.up]]
    return inst
  },
}

const ichimoku: IndicatorDef = {
  type: 'ichimoku',
  name: 'Ichimoku Cloud',
  place: 'overlay',
  params: [P('conv', 'Tenkan', 9), P('base', 'Kijun', 26), P('spanB', 'Senkou B', 52), P('disp', 'Displacement', 26)],
  colors: [
    K('tenkan', 'Tenkan', '#4c8dff'),
    K('kijun', 'Kijun', '#ef5350'),
    K('lagging', 'Chikou', '#a78bfa'),
    K('cloudUp', 'Awan naik', '#26a69a'),
    K('cloudDown', 'Awan turun', '#ef5350'),
  ],
  label: (c) => `Ichimoku ${c.params.conv} ${c.params.base} ${c.params.spanB} ${c.params.disp}`,
  create(env, cfg) {
    const style = () => ({
      fillUp: alpha(cfg.colors.cloudUp, 0.12),
      fillDown: alpha(cfg.colors.cloudDown, 0.12),
      lineA: alpha(cfg.colors.cloudUp, 0.8),
      lineB: alpha(cfg.colors.cloudDown, 0.8),
    })
    const cloud = new BandFill(style())
    cloud.autoscale = true
    env.candles.attachPrimitive(cloud)
    const inst = new Lines(env, cfg, 'overlay', [])
    const tenkan = inst.line('tenkan')
    const kijun = inst.line('kijun')
    const lagging = inst.line('lagging')
    // spans plotted (displacement - 1) bars ahead, lagging line the same distance back (TradingView)
    const off = () => cfg.params.disp - 1
    inst.update = (ctx) => {
      const r = C.ichimoku(ctx.h, ctx.l, ctx.c, cfg.params.conv, cfg.params.base, cfg.params.spanB)
      inst.data = r
      inst.setLine(tenkan, r.tenkan)
      inst.setLine(kijun, r.kijun)
      inst.plot.lines[lagging].spec.offset = -off()
      inst.setLine(lagging, r.lagging)
      cloud.set(r.spanA, r.spanB, off())
    }
    inst.values = (i) => [
      ['T', fmt2(inst.data.tenkan?.[i] ?? NaN), cfg.colors.tenkan],
      ['K', fmt2(inst.data.kijun?.[i] ?? NaN), cfg.colors.kijun],
      ['A', fmt2(inst.data.spanA?.[i - off()] ?? NaN), cfg.colors.cloudUp],
      ['B', fmt2(inst.data.spanB?.[i - off()] ?? NaN), cfg.colors.cloudDown],
    ]
    const baseRestyle = inst.restyle.bind(inst)
    inst.restyle = () => {
      baseRestyle()
      cloud.style = style()
      cloud.refresh()
    }
    const baseDestroy = inst.destroy.bind(inst)
    inst.destroy = () => {
      env.candles.detachPrimitive(cloud)
      baseDestroy()
    }
    return inst
  },
}

const PIVOT_KEYS = ['r3', 'r2', 'r1', 'p', 's1', 's2', 's3'] as const

const pivotsDef: IndicatorDef = {
  type: 'pivots',
  name: 'Pivot Points harian (classic)',
  place: 'overlay',
  params: [],
  colors: [K('p', 'Pivot', '#f5a524'), K('r', 'Resistance', '#ef5350'), K('s', 'Support', '#26a69a')],
  label: () => 'Pivot harian',
  create(env, cfg) {
    const inst = new Lines(env, cfg, 'overlay', [
      { key: 'r1', label: 'R1', color: 'r' },
      { key: 'p', label: 'P', color: 'p' },
      { key: 's1', label: 'S1', color: 's' },
    ])
    // far levels (R3/S3) would squash the candles; keep them out of the price scale fit
    inst.plot.autoscale = false
    const idx = PIVOT_KEYS.map((k) => inst.line(k === 'p' ? 'p' : k[0], { step: true, dash: k === 'p' ? undefined : DOT }))
    inst.update = (ctx) => {
      const r = ctx.intraday ? C.pivots(ctx.h, ctx.l, ctx.c, ctx.day) : null
      inst.data = r ?? {}
      PIVOT_KEYS.forEach((k, j) => inst.setLine(idx[j], r ? r[k] : []))
    }
    return inst
  },
}

const sessions: IndicatorDef = {
  type: 'sessions',
  name: 'Sesi pasar (Asia, London, New York)',
  place: 'overlay',
  params: [],
  colors: [],
  label: () => 'Sesi: Asia · London · NY',
  create(env) {
    const shade = new SessionShade()
    env.candles.attachPrimitive(shade)
    return {
      update(ctx: Ctx) {
        shade.set(ctx.tfSec <= 3600 ? ctx.rawTimes : [])
      },
      values: () => [
        ['Asia', '', '#4c8dff'],
        ['London', '', '#2ec4b6'],
        ['NY', '', '#f5a524'],
      ],
      restyle() {},
      destroy() {
        env.candles.detachPrimitive(shade)
      },
      pane: () => 0,
    }
  },
}

// ---------- panes ----------

const range0to100 = () => ({ priceRange: { minValue: 0, maxValue: 100 } })

function oscillator(
  def: Omit<IndicatorDef, 'create' | 'place'>,
  compute: (ctx: Ctx, p: Record<string, number>) => Record<string, ArrayLike<number>>,
  shown: Shown[],
  opts: { bounded?: boolean; guides?: number[]; volumeFormat?: boolean } = {},
): IndicatorDef {
  return {
    ...def,
    place: 'pane',
    create(env, cfg) {
      const inst = new Lines(env, cfg, 'pane', shown)
      const [first, ...rest] = shown
      inst.hostLine(first.color, {
        ...(opts.bounded ? { autoscaleInfoProvider: range0to100 } : {}),
        ...(opts.volumeFormat ? { priceFormat: { type: 'volume' } } : {}),
      })
      const extra = rest.map((s) => inst.line(s.color))
      for (const g of opts.guides ?? []) inst.guide(g)
      inst.update = (ctx) => {
        inst.data = compute(ctx, cfg.params)
        inst.setHost(inst.data[first.key], ctx)
        rest.forEach((s, j) => inst.setLine(extra[j], inst.data[s.key]))
      }
      return inst
    },
  }
}

const rsiDef = oscillator(
  {
    type: 'rsi',
    name: 'Relative Strength Index',
    params: [P('length', 'Periode', 14)],
    colors: [K('line', 'Garis', '#a78bfa')],
    label: (c) => `RSI ${c.params.length}`,
  },
  (ctx, p) => ({ v: C.rsi(ctx.c, p.length) }),
  [{ key: 'v', label: '', color: 'line' }],
  { bounded: true, guides: [70, 50, 30] },
)

const stochDef = oscillator(
  {
    type: 'stoch',
    name: 'Stochastic',
    params: [P('k', '%K', 14), P('smooth', 'Smooth %K', 3), P('d', '%D', 3)],
    colors: [K('k', '%K', '#4c8dff'), K('d', '%D', '#f5a524')],
    label: (c) => `Stoch ${c.params.k} ${c.params.smooth} ${c.params.d}`,
  },
  (ctx, p) => C.stochastic(ctx.h, ctx.l, ctx.c, p.k, p.smooth, p.d),
  [
    { key: 'k', label: 'K', color: 'k' },
    { key: 'd', label: 'D', color: 'd' },
  ],
  { bounded: true, guides: [80, 20] },
)

const atrDef = oscillator(
  {
    type: 'atr',
    name: 'Average True Range',
    params: [P('length', 'Periode', 14)],
    colors: [K('line', 'Garis', '#ef5350')],
    label: (c) => `ATR ${c.params.length}`,
  },
  (ctx, p) => ({ v: C.atr(ctx.h, ctx.l, ctx.c, p.length) }),
  [{ key: 'v', label: '', color: 'line' }],
)

const obvDef = oscillator(
  {
    type: 'obv',
    name: 'On Balance Volume (tick volume)',
    params: [],
    colors: [K('line', 'Garis', '#2ec4b6')],
    label: () => 'OBV',
  },
  (ctx) => ({ v: C.obv(ctx.c, ctx.v) }),
  [{ key: 'v', label: '', color: 'line', fmt: fmtInt }],
  { volumeFormat: true },
)

const mfiDef = oscillator(
  {
    type: 'mfi',
    name: 'Money Flow Index (tick volume)',
    params: [P('length', 'Periode', 14)],
    colors: [K('line', 'Garis', '#e879f9')],
    label: (c) => `MFI ${c.params.length}`,
  },
  (ctx, p) => ({ v: C.mfi(ctx.h, ctx.l, ctx.c, ctx.v, p.length) }),
  [{ key: 'v', label: '', color: 'line' }],
  { bounded: true, guides: [80, 20] },
)

const macdDef: IndicatorDef = {
  type: 'macd',
  name: 'MACD',
  place: 'pane',
  params: [P('fast', 'Cepat', 12), P('slow', 'Lambat', 26), P('signal', 'Signal', 9)],
  colors: [
    K('macd', 'MACD', '#4c8dff'),
    K('signal', 'Signal', '#f5a524'),
    K('up', 'Histogram +', '#26a69a'),
    K('down', 'Histogram −', '#ef5350'),
  ],
  label: (c) => `MACD ${c.params.fast} ${c.params.slow} ${c.params.signal}`,
  create(env, cfg) {
    const inst = new Lines(env, cfg, 'pane', [
      { key: 'hist', label: 'H', color: 'up' },
      { key: 'line', label: 'MACD', color: 'macd' },
      { key: 'signal', label: 'S', color: 'signal' },
    ])
    inst.hostHistogram('up')
    const line = inst.line('macd')
    const sig = inst.line('signal')
    inst.update = (ctx) => {
      const r = C.macd(ctx.c, cfg.params.fast, cfg.params.slow, cfg.params.signal)
      inst.data = { line: r.line, signal: r.signal, hist: r.hist }
      const hist = []
      for (let i = 0; i < r.hist.length; i++) {
        const v = r.hist[i]
        if (Number.isFinite(v)) hist.push({ time: ctx.times[i], value: v, color: alpha(v >= 0 ? cfg.colors.up : cfg.colors.down, 0.6) })
      }
      inst.setHostPoints(hist, ctx)
      inst.setLine(line, r.line)
      inst.setLine(sig, r.signal)
    }
    return inst
  },
}

export const INDICATORS: IndicatorDef[] = [
  movingAverage('ema'),
  movingAverage('sma'),
  bollinger,
  vwap,
  supertrend,
  ichimoku,
  donchian,
  pivotsDef,
  sessions,
  rsiDef,
  macdDef,
  stochDef,
  atrDef,
  obvDef,
  mfiDef,
]

export const INDICATOR_BY_TYPE = Object.fromEntries(INDICATORS.map((d) => [d.type, d]))

export function defaultConfig(def: IndicatorDef): IndicatorConfig {
  return {
    id: crypto.randomUUID(),
    type: def.type,
    params: Object.fromEntries(def.params.map((p) => [p.key, p.value])),
    colors: Object.fromEntries(def.colors.map((c) => [c.key, c.value])),
  }
}
