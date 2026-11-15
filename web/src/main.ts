import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  TickMarkType,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type CandlestickData,
  type HistogramData,
  type Logical,
  type LogicalRange,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import './style.css'
import { mountLogos, setFavicon } from './shared/brand'

mountLogos()
setFavicon()

// old links: the duel lobby has its own page now
{
  const q = new URLSearchParams(location.search)
  if (q.get('duel')) location.replace(`/duel.html?code=${encodeURIComponent(q.get('duel')!)}`)
  else if (q.get('open') === 'duel') location.replace('/duel.html')
}
import { AccountUI } from './account'
import { BacktestUI } from './backtest/ui'
import { DuelUI, type DuelLine, type DuelMarker, type LineField } from './duel'
import type { BtTrade } from './backtest/run'
import { SeriesStore, TIMEFRAMES, dataSpan, loadManifest, loadSymbols, type Bar, type Manifest, type SymbolInfo, type TF } from './data'
import { ChartSettingsDialog, alpha, applyLook, loadLook } from './chartsettings'
import { openMenu, type MenuItem } from './ctxmenu'
import { DrawingLayer, type Drawing } from './drawings'
import { askClear, DrawTools, magnetLabel } from './drawtools'
import { ask } from './shared/ask'
import { DEFAULT_CONFIG } from './engine/account'
import { IndicatorManager } from './indicators/manager'
import type { IndicatorConfig } from './indicators/registry'
import { Replay, floorIndex, type ReplaySession } from './replay'
import { ZONES, d1DisplayTime, formatWall, makeShifter, parseZoned, toInputValue } from './time'
import { TradeUI, toast } from './trade'
import { current, px, setCurrent, setDigitsOverride } from './current'

// ---------- persisted settings ----------

// gold keeps the original keys, so earlier drawings and replay sessions stay
const SYM_SUFFIX = current().symbol === 'XAUUSD' ? '' : `.${current().symbol}`
const KEY = {
  zone: 'rc.v1.zone',
  drawings: `rc.v1.drawings${SYM_SUFFIX}`,
  indicators: 'rc.v1.indicators',
  chipsCollapsed: 'rc.v1.chipsCollapsed',
  replay: `rc.v1.replay${SYM_SUFFIX}`,
  speed: 'rc.v1.replaySpeed',
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const chartEl = $('chart')
const chartWrap = chartEl.parentElement as HTMLElement
const legendEl = $('legend')
const overlayEl = $('overlay')
const statusEl = $('status')
const statusInfo = document.createElement('span')
const attribution = document.createElement('a')
attribution.href = 'https://www.tradingview.com/'
attribution.target = '_blank'
attribution.rel = 'noopener'
attribution.textContent = 'Chart: TradingView Lightweight Charts™'
attribution.className = 'attribution'
statusEl.append(statusInfo, attribution)
const tfsEl = $('tfs')
const zoneEl = $<HTMLSelectElement>('zone')
const gotoForm = $<HTMLFormElement>('goto')
const gotoInput = $<HTMLInputElement>('goto-input')
const replayBtn = $<HTMLButtonElement>('replay-btn')
const replayBar = $('replay-bar')
const pickBar = $('pick-bar')
const pickLine = $('pick-line')
const pickMark = $('pick-mark')
const pickDim = $('pick-dim')
const pickMsg = $('pick-msg')
const pickStartBtn = pickBar.querySelector<HTMLButtonElement>('[data-p="start"]')!
const tradeEl = $('trade')
const btBtn = $<HTMLButtonElement>('bt-btn')
const btEl = $('bt')

const css = getComputedStyle(document.documentElement)
const color = (name: string) => css.getPropertyValue(name).trim()

// ---------- state ----------

let manifest: Manifest
let store: SeriesStore
/** every visit (and every duel round) starts on M15 */
const START_TF: TF = 'M15'
let tf: TF = START_TF
let zone = load<string>(KEY.zone, 'Asia/Jakarta')
if (!ZONES.some((z) => z.id === zone)) zone = 'UTC'
let shift = makeShifter(zone)
let busy = false

let replay: Replay | null = null
let picking = false
/** replay start being chosen: open time of the last candle that stays visible (null = not chosen yet) */
let pickTime: number | null = null
let pickDragging = false
let playing = false
let speed = load<number>(KEY.speed, 5)
/** bars currently on the chart (all loaded bars, or the replay-visible part) and their chart times */
let shown: Bar[] = []
let shownTimes: Time[] = []

/** duel mode: normalised bars per timeframe (null outside a duel) */
let duelBars: Record<TF, Bar[]> | null = null
let duelHard = false
const hideDate = () => !!replay?.hideDate || !!duelBars
const hideTime = () => !!duelBars && duelHard
const displayTime = (t: number) => (tf === 'D1' ? d1DisplayTime(t) : shift(t))

// ---------- chart ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

const chart = createChart(chartEl, {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: color('--bg') },
    textColor: color('--muted'),
    fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', sans-serif",
    panes: { separatorColor: color('--border') },
    // Logo hidden; TradingView attribution is in the status bar instead (Apache-2.0 NOTICE).
    attributionLogo: false,
  },
  grid: {
    vertLines: { color: '#141924' },
    horzLines: { color: '#141924' },
  },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: color('--border') },
  timeScale: {
    borderColor: color('--border'),
    timeVisible: true,
    secondsVisible: false,
    rightOffset: 10,
    // chart times are wall-clock seconds "as if UTC"; dates can be hidden for replay practice
    tickMarkFormatter: (time: Time, type: TickMarkType) => {
      const d = new Date((time as number) * 1000)
      if (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds) return hideTime() ? '' : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
      if (hideDate()) return ''
      if (type === TickMarkType.Year) return String(d.getUTCFullYear())
      if (type === TickMarkType.Month) return MONTHS[d.getUTCMonth()]
      return String(d.getUTCDate())
    },
  },
  localization: {
    timeFormatter: (time: Time) => {
      const wall = time as number
      if (hideTime()) return ''
      if (hideDate()) return tf === 'D1' ? '' : formatWall(wall).slice(11)
      return formatWall(wall, tf !== 'D1')
    },
  },
})

const candles = chart.addSeries(CandlestickSeries, {
  upColor: color('--up'),
  downColor: color('--down'),
  wickUpColor: color('--up'),
  wickDownColor: color('--down'),
  borderVisible: false,
  priceFormat: { type: 'price', precision: current().digits, minMove: 10 ** -current().digits },
  // replaced by explicit Bid/Ask lines below
  priceLineVisible: false,
  lastValueVisible: false,
})

// MT5 candles are Bid prices; Ask = Bid + spread.
const ASK_COLOR = '#4c8dff'
const bidLine = candles.createPriceLine({
  price: 0,
  color: color('--up'),
  lineWidth: 1,
  lineStyle: LineStyle.Dashed,
  axisLabelVisible: true,
  title: 'Bid',
})
const askLine = candles.createPriceLine({
  price: 0,
  color: ASK_COLOR,
  lineWidth: 1,
  lineStyle: LineStyle.Dashed,
  axisLabelVisible: true,
  title: 'Ask',
})

const volume = chart.addSeries(
  HistogramSeries,
  { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
  1,
)
chart.panes()[0].setStretchFactor(4)
chart.panes()[1].setStretchFactor(1)

// ---------- chart look (settings dialog) ----------
let look = loadLook()
const watermark = createTextWatermark(chart.panes()[0], { visible: false, horzAlign: 'center', vertAlign: 'center', lines: [] })
function updateWatermark() {
  const c = alpha(look.textColor, 0.14)
  watermark.applyOptions({
    visible: look.watermark,
    lines: [
      { text: duelBars ? 'DUEL' : current().symbol, color: c, fontSize: 56, fontStyle: 'bold' },
      { text: tf, color: c, fontSize: 28 },
    ],
  })
}
function setLook(l: typeof look) {
  look = l
  applyLook(chart, candles, volume, look)
  // an empty volume pane would keep its height: shrink it instead
  chart.panes()[1]?.setStretchFactor(look.volume ? 1 : 0.0001)
  updateWatermark()
  updateQuoteLines()
  if (shown.length) render()
}
const lookDialog = new ChartSettingsDialog(look, setLook)
const openChartSettings = () => lookDialog.open(look)
applyLook(chart, candles, volume, look)
if (!look.volume) chart.panes()[1]?.setStretchFactor(0.0001)

const drawings = new DrawingLayer(
  {
    toLogical: (t) => (store ? store.indexOfTime(t) : 0),
    toTime: (l) => (store ? store.timeOfIndex(l) : 0),
    // magnet: the candle as drawn (in replay the last one is still forming)
    bar: (l) => shown[l] ?? null,
  },
  chartEl,
)
candles.attachPrimitive(drawings)
drawings.load(load<Drawing[]>(KEY.drawings, []))
drawings.onChange = () => save(KEY.drawings, drawings.drawings)
const drawTools = new DrawTools($('tools'), chartWrap, drawings, {
  toInput: (t) => toInputValue(shift(t)),
  fromInput: (v) => parseZoned(v, zone),
  timeframes: TIMEFRAMES,
})

const indicators = new IndicatorManager({ chart, candles }, $('chips'), $('pane-chips'), $<HTMLDialogElement>('ind-dialog'))
indicators.onSave = (list) => save(KEY.indicators, list)
indicators.collapsed = load<boolean>(KEY.chipsCollapsed, false)
indicators.onCollapse = (c) => save(KEY.chipsCollapsed, c)

const trade = new TradeUI({
  root: tradeEl,
  chartHost: chartWrap,
  chart,
  candles,
  chartTimeOf: (t) => {
    const i = floorIndex(shown, t)
    return i < 0 ? null : (shownTimes[i] ?? null)
  },
  onChange: () => {
    updateQuoteLines()
    saveSession()
  },
  journal: {
    has: (t) => account.isJournaled(t),
    open: (t) => {
      const risk = t.sl === null ? null : Math.abs(t.entry - t.sl) * 100 * t.lots
      void account.openEntry({
        source: 'replay',
        replayId: replay?.serverId ?? null,
        trade: { ...t, r: risk ? t.pnl / risk : null },
        shot: chartShot,
      })
    },
  },
})

// ---------- account + journal (F5) ----------

/** Chart picture for the journal: WebP, scaled down if large. */
function chartShot(): Promise<Blob | null> {
  const src = chart.takeScreenshot()
  const scale = Math.min(1, 1400 / src.width)
  const c = document.createElement('canvas')
  c.width = Math.round(src.width * scale)
  c.height = Math.round(src.height * scale)
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  return new Promise((res) => c.toBlob((b) => res(b), 'image/webp', 0.82))
}

const account = new AccountUI({
  button: $<HTMLButtonElement>('acct-btn'),
  dialog: $<HTMLDialogElement>('acct-dialog'),
  entryDialog: $<HTMLDialogElement>('jr-dialog'),
  zone: () => zone,
  onLoadReplay: (session) => {
    if (btOpen()) setBacktest(false)
    const s = session as ReplaySession
    const sym = s.symbol ?? 'XAUUSD'
    if (sym !== current().symbol) {
      // another pair: store it as that pair's session and open the chart on it
      setCurrent(sym)
      save(sym === 'XAUUSD' ? 'rc.v1.replay' : `rc.v1.replay.${sym}`, s)
      sessionStorage.setItem('rc.resumeReplay', '1')
      location.reload()
      return
    }
    void startReplay(s.cursorTime, s)
  },
  onUseBacktest: (b, asCompare) => {
    setBacktest(true)
    bt?.loadSaved(b as never, asCompare)
  },
  onJournalChange: () => trade.invalidate(),
})

async function saveReplayToAccount() {
  if (!replay) return
  stopPlay()
  const label = formatWall(shift(replay.startTime))
  try {
    const r = await account.saveReplay(replay.session(), `Replay ${label}`)
    if (r && replay) {
      replay.serverId = r.id
      replay.name = r.name
      saveSession(true)
    }
  } catch (err) {
    toast((err as Error).message, 'bad')
  }
}

// ---------- backtest ----------

let bt: BacktestUI | null = null
let btTrades: BtTrade[] | null = null
const btMarkers = createSeriesMarkers(candles, [])
const btOpen = () => document.body.classList.contains('bt')

/** Entry arrows and exit dots of backtest trades inside the loaded window. */
function syncBtMarkers() {
  if (!btTrades || !btOpen() || replay || duelBars || !shown.length) return btMarkers.setMarkers([])
  const first = shown[0].time
  const end = shown[shown.length - 1].time + store.tfSec
  const out: SeriesMarker<Time>[] = []
  const at = (t: number) => (t >= first && t < end ? (shownTimes[floorIndex(shown, t)] ?? null) : null)
  for (const t of btTrades) {
    const a = at(t.openTime)
    const b = at(t.closeTime)
    if (a !== null)
      out.push(t.side === 'buy'
        ? { time: a, position: 'belowBar', shape: 'arrowUp', color: '#4c8dff', text: 'B' }
        : { time: a, position: 'aboveBar', shape: 'arrowDown', color: '#ef5350', text: 'S' })
    if (b !== null)
      out.push({ time: b, position: t.side === 'buy' ? 'aboveBar' : 'belowBar', shape: 'circle', color: t.pnl >= 0 ? '#26a69a' : '#ef5350', text: (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(0) })
  }
  out.sort((x, y) => (x.time as number) - (y.time as number))
  btMarkers.setMarkers(out)
}

function setBacktest(open: boolean) {
  if (open && replay) return toast('Exit replay first to run a backtest.', 'bad')
  if (open && !bt) {
    bt = new BacktestUI({
      root: btEl,
      zone: () => zone,
      span: dataSpan(manifest),
      onTrades: (t) => {
        btTrades = t
        syncBtMarkers()
      },
      onJump: async (t, stf) => {
        if (stf !== tf) await switchTF(stf)
        await goTo(t)
      },
      onClose: () => setBacktest(false),
      onSave: (r) => {
        void account
          .saveBacktest({ spec: r.spec, metrics: r.metrics, curve: r.curve, from: r.from, to: r.to }, r.spec.name || `Backtest ${r.spec.tf}`)
          .catch((err) => toast((err as Error).message, 'bad'))
      },
    })
  }
  document.body.classList.toggle('bt', open)
  btEl.hidden = !open
  btBtn.setAttribute('aria-pressed', String(open))
  syncBtMarkers()
}

// ---------- duel (F6) ----------

const duelPanelEl = $('duel-panel')
const duelQuickEl = $('duel-quick')
const pricePick = $('price-pick')
const duelMarkersApi = createSeriesMarkers(candles, [])
let duelMarks: DuelMarker[] = []
let savedDrawings: Drawing[] | null = null
let savedTF: TF = tf
let pickResolve: ((p: number | null) => void) | null = null
const duelLines = new Map<LineField, { line: ReturnType<typeof candles.createPriceLine>; spec: DuelLine }>()

function setDuelLines(list: DuelLine[]) {
  const want = new Set(list.map((l) => l.field))
  for (const [f, x] of duelLines) {
    if (!want.has(f)) {
      candles.removePriceLine(x.line)
      duelLines.delete(f)
    }
  }
  for (const spec of list) {
    // keep the line under the pointer where the user is dragging it
    const price = duelDrag?.field === spec.field && duelDrag.moved ? duelDrag.price : spec.price
    const opts = {
      price,
      color: spec.color,
      lineWidth: (spec.field === 'entry' ? 2 : 1) as 1 | 2,
      lineStyle: spec.solid ? LineStyle.Solid : LineStyle.Dashed,
      axisLabelVisible: true,
      title: spec.drag ? `${spec.title}  ⇕` : spec.title,
    }
    const x = duelLines.get(spec.field)
    if (x) {
      x.line.applyOptions(opts)
      x.spec = spec
    } else duelLines.set(spec.field, { line: candles.createPriceLine(opts), spec })
  }
}

// dragging the order / SL / TP lines, and a plain click that sets a limit/stop price
let duelDrag: { field: LineField; startY: number; moved: boolean; price: number } | null = null
let duelPress: { x: number; y: number } | null = null

function duelLocal(e: PointerEvent) {
  const r = chartEl.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top, inPane: e.clientY - r.top <= chart.panes()[0].getHeight() && e.clientX - r.left <= r.width }
}

function duelHit(y: number): LineField | null {
  let best: { f: LineField; d: number } | null = null
  for (const [f, x] of duelLines) {
    if (!x.spec.drag) continue
    const ly = candles.priceToCoordinate(x.line.options().price)
    if (ly === null) continue
    // SL/TP can sit on the entry: prefer them
    const d = Math.abs(ly - y) + (f === 'entry' ? 1.5 : 0)
    if (Math.abs(ly - y) <= 8 && (!best || d < best.d)) best = { f, d }
  }
  return best?.f ?? null
}

chartWrap.addEventListener(
  'pointerdown',
  (e) => {
    if (!duelBars || !duel.play || duel.play.revealed || e.button !== 0 || pickResolve) return
    const { x, y, inPane } = duelLocal(e)
    if (!inPane) return
    const f = duelHit(y)
    if (!f) {
      duelPress = { x, y }
      return
    }
    e.stopPropagation()
    e.preventDefault()
    duelDrag = { field: f, startY: y, moved: false, price: duelLines.get(f)!.line.options().price }
    chartWrap.setPointerCapture(e.pointerId)
    chart.applyOptions({ handleScroll: false, handleScale: false })
  },
  true,
)
chartWrap.addEventListener(
  'pointermove',
  (e) => {
    if (!duelBars || !duel.play || duel.play.revealed) return
    const { y } = duelLocal(e)
    const d = duelDrag
    if (!d) {
      const f = duelHit(y)
      if (f) chartWrap.style.cursor = 'ns-resize'
      else if (chartWrap.style.cursor === 'ns-resize') chartWrap.style.cursor = ''
      return
    }
    e.stopPropagation()
    if (!d.moved && Math.abs(y - d.startY) < 3) return
    d.moved = true
    const p = candles.coordinateToPrice(y)
    if (p === null) return
    d.price = Math.round(p * 100) / 100
    duel.dragLine(d.field, d.price)
  },
  true,
)
chartWrap.addEventListener(
  'pointerup',
  (e) => {
    const press = duelPress
    duelPress = null
    if (duelDrag) {
      e.stopPropagation()
      const d = duelDrag
      duelDrag = null
      if (chartWrap.hasPointerCapture(e.pointerId)) chartWrap.releasePointerCapture(e.pointerId)
      chart.applyOptions({ handleScroll: true, handleScale: true })
      if (d.moved) duel.dragLine(d.field, d.price)
      return
    }
    // a click that did not pan the chart and is not drawing: price for a limit/stop order
    if (!press || !duelBars || drawings.tool !== 'cursor') return
    const { x, y } = duelLocal(e)
    if (Math.hypot(x - press.x, y - press.y) > 4 || drawings.hitAt(x, y)) return
    const p = candles.coordinateToPrice(y)
    if (p !== null) duel.chartClick(p)
  },
  true,
)

/** A store over fixed bars (duel snapshot): no chunks, never loads. */
function duelStore(t: TF): SeriesStore {
  const s = new SeriesStore({ timeframes: { [t]: [] } } as unknown as Manifest, t)
  s.bars = duelBars![t]
  return s
}

function syncDuelMarkers() {
  if (!duelBars || !shown.length) return duelMarkersApi.setMarkers([])
  const out: SeriesMarker<Time>[] = []
  for (const m of duelMarks) {
    const i = floorIndex(shown, m.time)
    if (i >= 0) out.push({ time: shownTimes[i], position: m.position, shape: m.shape, color: m.color, text: m.text })
  }
  out.sort((a, b) => (a.time as number) - (b.time as number))
  duelMarkersApi.setMarkers(out)
}

function setDuelUI(on: boolean) {
  document.body.classList.toggle('duel', on)
  // normalised duel prices sit around 1000: two decimals for every pair
  const d = on ? 2 : current().digits
  setDigitsOverride(on ? 2 : null)
  candles.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: 10 ** -d } })
  drawings.setDigits(d)
  duelPanelEl.hidden = !on
  if (!on) duelQuickEl.hidden = true
  for (const el of [gotoInput, gotoForm.querySelector('button')!, replayBtn, btBtn]) (el as HTMLButtonElement).disabled = on
}

const duel = new DuelUI(duelPanelEl, duelQuickEl, {
  requireLogin: () => account.requireLogin(),
  enter: (bars, hardcore) => {
    if (replay) {
      // leave replay first; its session stays saved
      stopPlay()
      saveSession(true)
      trade.detach()
      replay = null
      setReplayUI(false)
    }
    if (btOpen()) setBacktest(false)
    if (!duelBars) {
      savedDrawings = drawings.drawings
      savedTF = tf
      drawings.onChange = () => {}
    }
    drawings.load([])
    duelBars = bars
    duelHard = hardcore
    duelMarks = []
    setDuelUI(true)
    chart.applyOptions({}) // re-run time formatters
    tf = START_TF
    syncTFButtons()
    store = duelStore(tf)
    render()
    showLatest(Math.min(currentSpan(), 160))
  },
  update: () => {
    store.bars = duelBars![tf]
    render({ incremental: true })
  },
  exit: () => {
    duelBars = null
    duelMarks = []
    setDuelLines([])
    duelMarkersApi.setMarkers([])
    setDuelUI(false)
    drawings.load(savedDrawings ?? [])
    drawTools.rebindChange(() => save(KEY.drawings, drawings.drawings))
    chart.applyOptions({})
    tf = savedTF
    syncTFButtons()
    void withBusy(async () => {
      store = new SeriesStore(manifest, tf)
      await store.loadAround(null)
      render()
      showLatest(160)
    })
  },
  setLines: (l) => setDuelLines(l),
  setMarkers: (m) => {
    duelMarks = m
    syncDuelMarkers()
  },
  pickPrice: (label) =>
    new Promise((res) => {
      pickResolve?.(null)
      pickResolve = res
      pricePick.textContent = `${label} · Esc to cancel`
      pricePick.hidden = false
      chartWrap.classList.add('picking')
    }),
})

function endPricePick(p: number | null) {
  const r = pickResolve
  pickResolve = null
  pricePick.hidden = true
  chartWrap.classList.remove('picking')
  r?.(p)
}

// price pick: capture phase so drawings / chart do not also react to the click
chartWrap.addEventListener(
  'pointerdown',
  (e) => {
    if (!pickResolve || e.button !== 0) return
    const rect = chartEl.getBoundingClientRect()
    const price = candles.coordinateToPrice(e.clientY - rect.top)
    e.stopPropagation()
    e.preventDefault()
    endPricePick(price === null ? null : Math.round(price * 100) / 100)
  },
  true,
)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pickResolve) endPricePick(null)
})
window.addEventListener('beforeunload', (e) => {
  if (duel.active && !duel.play?.revealed) e.preventDefault()
})

// ---------- rendering ----------

/** Identity of the bar window on the chart: incremental updates are only valid within one. */
let renderKey = ''
let renderedLen = 0
let renderedFirst: Time | null = null
let lastIndicatorRun = 0
let indicatorTimer = 0

let indicatorsIncremental = false

function runIndicators() {
  clearTimeout(indicatorTimer)
  indicatorTimer = 0
  lastIndicatorRun = performance.now()
  indicators.update(shown, shownTimes, store.tfSec, indicatorsIncremental)
  indicatorsIncremental = true
}

function render(opts: { incremental?: boolean } = {}) {
  shown = replay ? replay.visible(store) : store.bars
  const bars = shown
  const c: CandlestickData<Time>[] = new Array(bars.length)
  const v: HistogramData<Time>[] = new Array(bars.length)
  const upVol = alpha(look.up, 0.45)
  const downVol = alpha(look.down, 0.45)
  let prev = -Infinity
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    let t = displayTime(b.time)
    if (t <= prev) t = prev + 1 // DST fall-back can repeat wall-clock time
    prev = t
    const time = t as UTCTimestamp
    c[i] = { time, open: b.open, high: b.high, low: b.low, close: b.close }
    v[i] = { time, value: b.volume, color: b.close >= b.open ? upVol : downVol }
  }
  shownTimes = c.map((x) => x.time)

  const key = `${tf}|${zone}`
  const n = c.length
  const canAppend =
    opts.incremental && key === renderKey && renderedLen > 0 && n >= renderedLen && n - renderedLen <= 500 && c[0]?.time === renderedFirst
  if (canAppend) {
    // replay step: only the last candle changed and maybe a few were added
    for (let i = renderedLen - 1; i < n; i++) {
      candles.update(c[i])
      volume.update(v[i])
    }
  } else {
    candles.setData(c)
    volume.setData(v)
  }
  renderKey = key
  renderedLen = n
  renderedFirst = c[0]?.time ?? null

  // indicators are the expensive part: tail-only series updates on replay steps,
  // and throttled while replay is playing
  if (!canAppend) indicatorsIncremental = false
  if (opts.incremental && playing && performance.now() - lastIndicatorRun < 150) {
    if (!indicatorTimer) indicatorTimer = window.setTimeout(runIndicators, 150)
  } else runIndicators()

  updateQuoteLines()
  drawings.refresh()
  updateLegend()
  updateStatus()
  if (replay) {
    trade.refresh()
    updateClock()
  } else syncBtMarkers()
  if (duelBars) syncDuelMarkers()
}

const fmt = (n: number) => px(n)

/** Bid/Ask lines at the newest visible bar (the replay cursor in replay mode). */
function updateQuoteLines() {
  const last = shown[shown.length - 1]
  const show = look.bidAsk && !!last && (replay || duelBars ? true : store.atLatest)
  const bidColor = last && last.close >= last.open ? look.up : look.down
  bidLine.applyOptions({ price: last?.close ?? 0, color: bidColor, lineVisible: show, axisLabelVisible: show })
  askLine.applyOptions({ price: last ? last.close + last.spread : 0, lineVisible: show, axisLabelVisible: show })
}

function updateLegend(param?: MouseEventParams<Time>) {
  if (!shown.length) {
    legendEl.textContent = ''
    return
  }
  let i = shown.length - 1
  if (param?.logical !== undefined && param.point) i = Math.min(Math.round(param.logical), shown.length - 1)
  const b: Bar | undefined = shown[i]
  if (!b) return
  const prev = shown[i - 1]
  const chg = prev ? b.close - prev.close : b.close - b.open
  const pct = (chg / (prev ? prev.close : b.open)) * 100
  const cls = chg >= 0 ? 'up' : 'down'
  const wall = displayTime(b.time)
  const when = hideTime() ? '' : hideDate() ? (tf === 'D1' ? '' : formatWall(wall).slice(11)) : formatWall(wall, tf !== 'D1')
  legendEl.innerHTML = [
    `<span><b>${duelBars ? 'DUEL' : manifest.symbol}</b> · ${tf}${when ? ` · ${when}` : ''}</span>`,
    `<span><span class="k">O</span>${fmt(b.open)}</span>`,
    `<span><span class="k">H</span>${fmt(b.high)}</span>`,
    `<span><span class="k">L</span>${fmt(b.low)}</span>`,
    `<span><span class="k">C</span><span class="${cls}">${fmt(b.close)}</span></span>`,
    `<span><span class="k">Ask</span><span class="ask">${fmt(b.close + b.spread)}</span></span>`,
    `<span class="${cls}">${chg >= 0 ? '+' : ''}${fmt(chg)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`,
    `<span><span class="k">Vol</span>${b.volume.toLocaleString('en-US')}</span>`,
    `<span><span class="k">Spread</span>${fmt(b.spread)}</span>`,
  ].join('')
}

function updateStatus() {
  const zoneLabel = ZONES.find((z) => z.id === zone)?.label ?? zone
  if (duelBars) {
    statusInfo.textContent = `Duel ${tf} · prices normalised, date${duelHard ? ' and time' : ''} hidden · Ask = Bid + spread`
    return
  }
  if (replay) {
    statusInfo.textContent =
      `Replay ${tf} · ${hideDate() ? 'dates hidden' : `from ${formatWall(shift(replay.startTime))}`} · ` +
      `candle price = Bid, Ask = Bid + spread`
    return
  }
  const m1 = manifest.timeframes.M1
  const total = m1.reduce((s, c) => s + c.bars, 0)
  const from = formatWall(shift(m1[0].from), false)
  const to = formatWall(shift(m1[m1.length - 1].to), false)
  statusInfo.textContent =
    `Data ${from} → ${to} · ${total.toLocaleString('en-US')} M1 candles · ` +
    `loaded ${store.bars.length.toLocaleString('en-US')} ${tf} candles · zone ${tf === 'D1' ? 'NY 17:00 trading day' : zoneLabel} · ` +
    `candle price = Bid, Ask = Bid + spread`
}

function showOverlay(html: string | null) {
  overlayEl.hidden = html === null
  overlayEl.innerHTML = html ?? ''
}

// ---------- navigation ----------

let queue: Promise<unknown> = Promise.resolve()

/** Run data operations one at a time; user actions queue up instead of being dropped. */
function withBusy<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const p = queue.then(async () => {
    busy = true
    try {
      return await fn()
    } catch (err) {
      console.error(err)
      showOverlay(`Could not load data: ${(err as Error).message}`)
      return undefined
    } finally {
      busy = false
    }
  })
  queue = p
  return p
}

function setRange(center: number, span: number) {
  chart.timeScale().setVisibleLogicalRange({ from: center - span / 2, to: center + span / 2 })
}

function showLatest(span: number) {
  const n = shown.length
  chart.timeScale().setVisibleLogicalRange({ from: n - span * 0.9, to: n + span * 0.1 })
}

function currentSpan() {
  const r = chart.timeScale().getVisibleLogicalRange()
  return r ? Math.max(30, r.to - r.from) : 160
}

async function switchTF(next: TF) {
  if (duelBars) {
    tf = next
    syncTFButtons()
    store = duelStore(next)
    render()
    showLatest(Math.min(currentSpan(), 160))
    return
  }
  const r = chart.timeScale().getVisibleLogicalRange()
  let centerT: number | null = null
  let span = 160
  let followLatest = true
  if (store && r) {
    centerT = store.timeOfIndex((r.from + r.to) / 2)
    span = Math.max(30, r.to - r.from)
    followLatest = replay ? true : store.atLatest && r.to >= store.bars.length - 2
  }
  await withBusy(async () => {
    const s = new SeriesStore(manifest, next)
    await s.loadAround(replay ? replay.cursorTime : followLatest ? null : centerT)
    store = s
    tf = next
    syncTFButtons()
    render()
    if (followLatest || centerT === null) showLatest(span)
    else setRange(store.indexOfTime(centerT), span)
  })
}

async function goTo(t: number) {
  const span = currentSpan()
  await withBusy(async () => {
    await store.loadAround(t)
    render()
    const idx = store.indexOfTime(t)
    setRange(idx, span)
    const b = store.barAt(Math.floor(idx))
    if (b) chart.setCrosshairPosition(b.close, displayTime(b.time) as UTCTimestamp, candles)
  })
}

async function goLatest() {
  const span = currentSpan()
  if (duelBars) return showLatest(span)
  await withBusy(async () => {
    if (!replay && !store.atLatest) {
      await store.loadAround(null)
      render()
    }
    showLatest(span)
  })
}

/** Load neighbouring chunks when the user scrolls near the edge of what is loaded. */
function onRangeChange(r: LogicalRange | null) {
  // the chosen line follows scroll/zoom (again next frame, once the new coordinates are drawn)
  if (picking) {
    syncPick()
    requestAnimationFrame(() => picking && syncPick())
  }
  if (!r || busy || !store || duelBars) return
  const n = store.bars.length
  if (r.from < 200 && store.canLeft) {
    void withBusy(async () => {
      const added = await store.extendLeft()
      const cur = chart.timeScale().getVisibleLogicalRange() ?? r
      render()
      chart.timeScale().setVisibleLogicalRange({ from: cur.from + added, to: cur.to + added })
    })
  } else if (!replay && r.to > n - 200 && store.canRight) {
    void withBusy(async () => {
      const cur = chart.timeScale().getVisibleLogicalRange() ?? r
      await store.extendRight()
      render()
      chart.timeScale().setVisibleLogicalRange(cur)
    })
  }
}

// ---------- replay ----------

let lastSave = 0
let saveTimer = 0

/** Save at most once a second, with a trailing save so the last step is never lost. */
function saveSession(force = false) {
  if (!replay) return
  const now = performance.now()
  if (!force && now - lastSave < 1000) {
    if (!saveTimer) saveTimer = window.setTimeout(() => saveSession(true), 1000)
    return
  }
  clearTimeout(saveTimer)
  saveTimer = 0
  lastSave = now
  save(KEY.replay, replay.session())
}

window.addEventListener('pagehide', () => saveSession(true))
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession(true)
})

function updateClock() {
  const clock = replayBar.querySelector<HTMLElement>('[data-r="clock"]')!
  if (!replay) return
  const wall = shift(replay.cursorTime)
  clock.textContent = hideDate() ? formatWall(wall).slice(11) : formatWall(wall)
}

const HELP_KEY = 'rc.v1.replayHelpSeen'
const replayHelp = document.createElement('div')
replayHelp.className = 'replay-help'
replayHelp.hidden = true
replayHelp.innerHTML = `
  <h3>How replay works</h3>
  <ol>
    <li><b>Play</b> candles one by one with ▶ (<kbd>Space</kbd>) or <b>Step</b> (<kbd>Shift</kbd>+<kbd>→</kbd>). Set the speed next to it.</li>
    <li><b>Open a position</b> with SELL / BUY in the order panel. For a limit/stop order, right-click the chart at the price you want.</li>
    <li><b>SL and TP</b>: drag the position line up or down on the chart, or click the line and choose Set SL/TP. Every line can be dragged.</li>
    <li><b>Done</b>: Save to continue later, Exit replay to go back to the normal chart. History and stats are in the panel.</li>
  </ol>
  <button type="button" data-help="close">Got it</button>`
chartWrap.append(replayHelp)
replayHelp.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-help="close"]')) replayHelp.hidden = true
})

function showReplayHelp(force = false) {
  if (!force && load<boolean>(HELP_KEY, false)) return
  replayHelp.hidden = false
  save(HELP_KEY, true)
}

function setReplayUI(on: boolean) {
  if (!on) replayHelp.hidden = true
  document.body.classList.toggle('replay', on)
  replayBar.hidden = !on
  tradeEl.hidden = !on
  replayBtn.setAttribute('aria-pressed', String(on))
  for (const el of [gotoInput, gotoForm.querySelector('button')!, $('latest')]) (el as HTMLButtonElement).disabled = on
  const hide = replayBar.querySelector<HTMLInputElement>('[data-r="hide"]')!
  hide.checked = hideDate()
  syncPlayButton()
}

function syncPlayButton() {
  const b = replayBar.querySelector<HTMLButtonElement>('[data-r="play"]')!
  b.innerHTML = playing ? '⏸ <span class="rb-label">Pause</span>' : '▶ <span class="rb-label">Play</span>'
  b.setAttribute('aria-label', playing ? 'Pause' : 'Play')
  b.title = playing ? 'Pause (Space)' : 'Play (Space)'
}

// ---------- choosing the replay start: point, adjust, then confirm ----------

function setPicking(on: boolean, at: number | null = null) {
  picking = on
  pickTime = on ? at : null
  pickDragging = false
  pickBar.hidden = !on
  pickLine.hidden = true
  chartWrap.classList.toggle('picking', on)
  syncPick()
}

/** candle label as on the chart's time axis */
const candleLabel = (t: number) => formatWall(displayTime(t), tf !== 'D1')
/** index of the candle at x (clamped to the loaded bars), or null off the plot */
function indexAtX(x: number): number | null {
  if (x < 0 || x > chart.timeScale().width() || !store.bars.length) return null
  const l = chart.timeScale().coordinateToLogical(x)
  return l === null ? null : Math.max(0, Math.min(Math.round(l), store.bars.length - 1))
}
const pickIndex = () => (pickTime === null ? null : Math.floor(store.indexOfTime(pickTime) + 1e-6))

/** where the chosen line, the dimmed future and the bar text are */
function syncPick() {
  const i = picking ? pickIndex() : null
  const w = chart.timeScale().width()
  const x = i === null ? null : chart.timeScale().logicalToCoordinate(i as Logical)
  pickMark.hidden = x === null || x < 0 || x > w
  // dim from half a candle after the chosen one to the right edge of the plot
  const from = x === null ? w : Math.max(0, x + chart.timeScale().options().barSpacing / 2)
  pickDim.hidden = from >= w
  if (x !== null) {
    pickMark.style.left = `${x}px`
    pickMark.firstElementChild!.textContent = candleLabel(store.bars[i!]?.time ?? pickTime!)
    pickDim.style.left = `${from}px`
    pickDim.style.width = `${w - from}px`
  }
  pickStartBtn.hidden = pickTime === null
  pickMsg.innerHTML =
    pickTime === null
      ? '<b>Choose a start point:</b> click a candle. <small>Candles after it are hidden.</small>'
      : `Start from <b>${candleLabel(pickTime)}</b> <small>· drag the line or use ← → to adjust</small>`
}

function placePick(i: number) {
  const b = store.bars[Math.max(0, Math.min(i, store.bars.length - 1))]
  if (!b) return
  pickTime = b.time
  syncPick()
}

/** arrow keys: one candle (Shift: ten), and scroll along when the line leaves the screen */
function nudgePick(step: number) {
  const i = pickIndex()
  if (i === null) return
  placePick(i + step)
  const r = chart.timeScale().getVisibleLogicalRange()
  const j = pickIndex()!
  if (r && (j < r.from + 2 || j > r.to - 2)) {
    const span = r.to - r.from
    chart.timeScale().setVisibleLogicalRange({ from: j - span * 0.7, to: j + span * 0.3 })
  }
}

async function pickRandom() {
  const t = randomStart()
  await goTo(t)
  chart.clearCrosshairPosition()
  if (!picking) return
  placePick(Math.floor(store.indexOfTime(t)))
  pickStartBtn.focus() // Enter now starts, arrows still nudge
}

function confirmPick() {
  if (pickTime === null) return
  const i = pickIndex()
  const b = i === null ? null : store.bars[i]
  // start at the end of the chosen candle: it is the last one shown
  if (b) void startReplay(b.time + store.tfSec - 1)
}

function randomStart(): number {
  const m1 = manifest.timeframes.M1
  const from = m1[0].from + 7 * 86400 // leave history for indicators
  const to = m1[m1.length - 1].to - 2 * 86400 // leave something to replay
  return Math.floor(from + Math.random() * Math.max(0, to - from))
}

async function startReplay(t: number, session?: ReplaySession) {
  stopPlay()
  setPicking(false)
  const r = new Replay(manifest, { ...DEFAULT_CONFIG, contractSize: current().contract, quoteJpy: current().quote === 'JPY' })
  const span = currentSpan()
  await withBusy(async () => {
    if (session) await r.resume(session)
    else await r.start(t)
    await store.loadAround(r.cursorTime)
    replay = r
    trade.attach(r.account)
    setReplayUI(true)
    render()
    showLatest(Math.min(span, 200))
    saveSession(true)
  })
  showReplayHelp()
}

async function exitReplay() {
  stopPlay()
  saveSession(true)
  trade.detach()
  replay = null
  setReplayUI(false)
  await withBusy(async () => {
    await store.loadAround(null)
    render()
    showLatest(currentSpan())
  })
}

async function stepOnce(): Promise<boolean> {
  const r = replay
  if (!r) return false
  let moved = false
  await withBusy(async () => {
    moved = await r.step(store)
    if (moved) {
      render({ incremental: true })
      keepCursorInView()
      saveSession()
    }
  })
  if (!moved) toast('End of data, replay finished.')
  return moved
}

/** Scroll along when the newest candle reaches the right edge (like a live chart). */
function keepCursorInView() {
  const r = chart.timeScale().getVisibleLogicalRange()
  if (!r) return
  const n = shown.length
  if (n - 1 > r.to - 2 && n - 1 < r.to + 20) {
    const span = r.to - r.from
    chart.timeScale().setVisibleLogicalRange({ from: n - span * 0.85, to: n + span * 0.15 })
  }
}

let playTimer = 0

function stopPlay() {
  playing = false
  clearTimeout(playTimer)
  if (indicatorTimer) runIndicators()
  syncPlayButton()
}

function play() {
  if (!replay) return
  playing = true
  syncPlayButton()
  const tick = async () => {
    if (!playing) return
    const t0 = performance.now()
    const ok = await stepOnce()
    if (!ok) return stopPlay()
    playTimer = window.setTimeout(tick, Math.max(0, 1000 / speed - (performance.now() - t0)))
  }
  void tick()
}

function buildReplayControls() {
  replayBtn.addEventListener('click', () => {
    if (replay) return void exitReplay()
    if (btOpen()) setBacktest(false)
    if (picking) return setPicking(false)
    const saved = load<ReplaySession | null>(KEY.replay, null)
    if (!saved) return setPicking(true)
    void ask('Positions, orders and history from your last session are still saved.', { title: 'Resume replay?', ok: 'Resume', cancel: 'New session' }).then((ok) =>
      ok ? startReplay(saved.cursorTime, saved) : setPicking(true),
    )
  })

  pickBar.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-p]')?.dataset.p
    if (act === 'random') void pickRandom()
    if (act === 'start') confirmPick()
    if (act === 'cancel') setPicking(false)
  })

  // choose the start candle: capture phase on the wrapper runs before chart and drawing handlers.
  // Press = put the line there, drag = move it; nothing starts until "Mulai replay" / Enter.
  const plotX = (e: PointerEvent) => e.clientX - chartEl.getBoundingClientRect().left
  chartWrap.addEventListener(
    'pointerdown',
    (e) => {
      if (!picking || e.button !== 0 || (e.target as HTMLElement).closest('.pick-bar, .legend-stack')) return
      const i = indexAtX(plotX(e))
      if (i === null) return
      e.stopPropagation()
      e.preventDefault()
      pickDragging = true
      chartWrap.setPointerCapture(e.pointerId)
      placePick(i)
    },
    true,
  )
  chartWrap.addEventListener(
    'pointermove',
    (e) => {
      if (!picking) return
      const i = indexAtX(plotX(e))
      if (pickDragging) {
        e.stopPropagation()
        if (i !== null) placePick(i)
      }
      // hover line snaps to the candle under the cursor and shows its time
      const x = i === null ? null : chart.timeScale().logicalToCoordinate(i as Logical)
      pickLine.hidden = x === null || pickDragging || e.pointerType === 'touch'
      if (x !== null) {
        pickLine.style.left = `${x}px`
        pickLine.firstElementChild!.textContent = candleLabel(store.bars[i!].time)
      }
    },
    true,
  )
  const endDrag = () => (pickDragging = false)
  chartWrap.addEventListener('pointerup', endDrag)
  chartWrap.addEventListener('pointercancel', endDrag)
  chartWrap.addEventListener('pointerleave', () => (pickLine.hidden = true))

  replayBar.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-r]')?.dataset.r
    if (!replay) return
    if (act === 'play') playing ? stopPlay() : play()
    if (act === 'step') {
      stopPlay()
      void stepOnce()
    }
    if (act === 'restart') {
      const from = replay.startTime
      void ask('Positions and history of this session are cleared.', { title: 'Restart from the start point?', ok: 'Restart', danger: true }).then((ok) => {
        if (ok) void startReplay(from)
      })
    }
    if (act === 'exit') void exitReplay()
    if (act === 'save') void saveReplayToAccount()
    if (act === 'help') replayHelp.hidden = !replayHelp.hidden
  })
  const speedSel = replayBar.querySelector<HTMLSelectElement>('[data-r="speed"]')!
  for (const s of [1, 2, 5, 10, 20]) speedSel.add(new Option(`${s}×/sec`, String(s), false, s === speed))
  speedSel.addEventListener('change', () => {
    speed = Number(speedSel.value)
    save(KEY.speed, speed)
  })
  replayBar.querySelector<HTMLInputElement>('[data-r="hide"]')!.addEventListener('change', (e) => {
    if (!replay) return
    replay.hideDate = (e.target as HTMLInputElement).checked
    chart.applyOptions({}) // re-run time formatters
    render()
    saveSession(true)
  })

  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    if (picking) {
      if (e.key === 'Escape') setPicking(false)
      else if (e.key === 'Enter') {
        if (tag !== 'BUTTON') confirmPick() // a focused button does its own thing
      }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        nudgePick((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1))
      }
      return
    }
    if (tag === 'BUTTON') return
    if (!replay) return
    if (e.key === 'ArrowRight' && e.shiftKey) {
      e.preventDefault()
      stopPlay()
      void stepOnce()
    } else if (e.key === ' ') {
      e.preventDefault()
      playing ? stopPlay() : play()
    }
  })
}

// ---------- controls ----------

/** Right click on the chart: drawing actions, a line at this price, orders at this price in replay. */
function buildContextMenu() {
  chartWrap.addEventListener('contextmenu', (e) => {
    const rect = chartEl.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (x < 0 || y < 0 || x > rect.width || y > chart.panes()[0].getHeight()) return
    e.preventDefault()
    const price = candles.coordinateToPrice(y)
    const pt = drawings.pointAt(x, y)
    const hit = drawings.hitAt(x, y)
    const pxs = price === null ? '' : px(price)
    const items: MenuItem[] = []

    if (hit) {
      drawings.select(hit)
      items.push(
        { label: 'Duplicate drawing', hint: 'Ctrl+D', act: () => drawings.duplicate(hit) },
        { label: 'Delete drawing', hint: 'Del', danger: true, act: () => drawings.removeSelected() },
        'sep',
      )
    }

    if (duelBars && price !== null) {
      const d = duel.menuAt(price)
      if (d.length) items.push(...d.map((x) => ({ label: x.label, hint: 'order', act: x.act })), 'sep')
    }

    const acc = replay ? trade.account : null
    const q = acc?.quote()
    if (acc && q && price !== null) {
      const p = Math.round(price * 100) / 100
      // below the market a buy waits as a limit and a sell as a stop; above it is the other way round
      const below = p < q.bid
      items.push(
        { label: `${below ? 'Buy limit' : 'Sell limit'} at ${px(p)}`, hint: 'fill ticket', act: () => trade.prefill('limit', p) },
        { label: `${below ? 'Sell stop' : 'Buy stop'} at ${px(p)}`, hint: 'fill ticket', act: () => trade.prefill('stop', p) },
        'sep',
      )
    }

    if (pt && price !== null) {
      items.push(
        { label: `Horizontal line at ${pxs}`, act: () => drawings.addAt('hline', { t: pt.t, p: price }) },
        { label: `Copy price ${pxs}`, act: () => void navigator.clipboard?.writeText(pxs) },
      )
    }
    if (!replay && !duelBars && !btOpen()) {
      items.push({
        label: 'Start replay from this candle',
        act: () => {
          const l = chart.timeScale().coordinateToLogical(x)
          if (l === null) return
          const bar = store.bars[Math.max(0, Math.min(Math.round(l), store.bars.length - 1))]
          // same confirm step as the Replay button: the line can still be moved
          setPicking(true, bar.time)
        },
      })
    }
    items.push(
      'sep',
      { label: magnetLabel(drawings.magnet), hint: 'switch', act: () => drawTools.cycleMagnet() },
      { label: 'Chart settings…', act: openChartSettings },
      {
        label: 'Reset chart scale',
        act: () => {
          chart.priceScale('right').applyOptions({ autoScale: true })
          showLatest(currentSpan())
        },
      },
    )
    if (drawings.drawings.length) {
      items.push({ label: 'Delete all drawings', danger: true, act: () => void askClear().then((ok) => ok && drawings.clear()) })
    }
    openMenu(e.clientX, e.clientY, items)
  })
}

function syncTFButtons() {
  updateWatermark()
  drawings.setTF(tf)
  for (const b of tfsEl.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.tf === tf))
}

function buildControls() {
  for (const t of TIMEFRAMES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = t
    b.dataset.tf = t
    b.addEventListener('click', () => t !== tf && void switchTF(t))
    tfsEl.append(b)
  }
  syncTFButtons()

  for (const z of ZONES) zoneEl.add(new Option(z.label, z.id, false, z.id === zone))
  zoneEl.addEventListener('change', () => {
    const r = chart.timeScale().getVisibleLogicalRange()
    zone = zoneEl.value
    save(KEY.zone, zone)
    shift = makeShifter(zone)
    render()
    if (r) chart.timeScale().setVisibleLogicalRange(r)
  })

  gotoForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const t = parseZoned(gotoInput.value, tf === 'D1' ? 'UTC' : zone)
    if (t !== null) void goTo(t)
  })

  $('latest').addEventListener('click', () => void goLatest())
  $('cs-btn').addEventListener('click', openChartSettings)

  buildContextMenu()

  chart.subscribeCrosshairMove((p) => {
    updateLegend(p)
    const i = p.logical !== undefined && p.point ? Math.round(p.logical) : shown.length - 1
    indicators.legend(Math.min(Math.max(i, 0), shown.length - 1))
  })

  const indBtn = $('ind-btn')
  const indMenu = $('ind-menu')
  const renderMenu = indicators.buildMenu(indMenu)
  const setMenu = (open: boolean) => {
    if (open) renderMenu()
    indMenu.hidden = !open
    indBtn.setAttribute('aria-expanded', String(open))
    if (open) {
      // keep the menu inside the viewport on narrow screens
      indMenu.style.left = '0px'
      const r = indMenu.getBoundingClientRect()
      const overflow = r.right - (document.documentElement.clientWidth - 8)
      if (overflow > 0) indMenu.style.left = `${-Math.min(overflow, r.left - 8)}px`
    }
  }
  indBtn.addEventListener('click', () => setMenu(indMenu.hasAttribute('hidden')))
  document.addEventListener('pointerdown', (e) => {
    if (!indMenu.hasAttribute('hidden') && !(e.target as HTMLElement).closest('.ind-wrap')) setMenu(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !indMenu.hasAttribute('hidden')) setMenu(false)
  })
  chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange)
  buildReplayControls()
  btBtn.addEventListener('click', () => setBacktest(!btOpen()))
}

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__rc = {
    chart,
    getStore: () => store,
    getReplay: () => replay,
    getShown: () => shown,
    drawings,
    indicators,
    trade,
    stepOnce,
    startReplay,
    getBacktest: () => bt,
    setBacktest,
    duel,
  }
}

// ---------- instrument picker ----------

function buildSymbolPicker(list: SymbolInfo[]) {
  const el = $<HTMLSelectElement>('symbol')
  const items = list.length ? list : [{ symbol: current().symbol, label: current().label }]
  el.innerHTML = items.map((x) => `<option value="${x.symbol}" ${x.symbol === current().symbol ? 'selected' : ''}>${x.symbol}</option>`).join('')
  el.title = current().label
  el.addEventListener('change', () => {
    if (duel.active) {
      el.value = current().symbol
      return
    }
    if (replay) saveSession(true)
    // every pair has its own drawings, replay session and price format: start the page fresh
    setCurrent(el.value)
    location.reload()
  })
}

// ---------- boot ----------

async function boot() {
  showOverlay('Loading data…')
  try {
    const list = await loadSymbols().catch((): SymbolInfo[] => [])
    if (list.length && !list.some((x) => x.symbol === current().symbol)) {
      // remembered pair has no data any more: fall back to the first one
      setCurrent(list[0].symbol)
      location.reload()
      return
    }
    buildSymbolPicker(list)
    manifest = await loadManifest(current().symbol)
  } catch {
    showOverlay(
      'No data yet. From the repo folder run:' +
        '<code>python tools/export_mt5.py</code><code>python tools/build_data.py --strict</code>',
    )
    return
  }
  drawings.setDigits(current().digits)
  indicators.load(load<IndicatorConfig[]>(KEY.indicators, []))
  buildControls()
  store = new SeriesStore(manifest, tf)
  try {
    await store.loadAround(null)
  } catch (err) {
    showOverlay(`Could not load data: ${(err as Error).message}`)
    return
  }
  render()
  showLatest(160)
  if (sessionStorage.getItem('rc.resumeReplay')) {
    // a replay from the account on another pair: the page reloaded onto that pair
    sessionStorage.removeItem('rc.resumeReplay')
    const s = load<ReplaySession | null>(KEY.replay, null)
    if (s) void startReplay(s.cursorTime, s)
  }
  void account.init().then(() => {
    const q = new URLSearchParams(location.search)
    const play = q.get('play')
    const n = Number(q.get('round'))
    if (play && n > 0) {
      // came from the duel page: play this round, keep the URL clean for reloads
      history.replaceState(null, '', location.pathname)
      void account.requireLogin().then((ok) => {
        if (ok) void duel.startRound(play.toUpperCase(), n)
      })
    }
  })
  gotoInput.value = toInputValue(displayTime(store.bars[store.bars.length - 1].time))
  showOverlay(null)
}

void boot()
