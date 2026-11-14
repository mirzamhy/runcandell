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
import { DuelUI, type DuelMarker } from './duel'
import type { BtTrade } from './backtest/run'
import { SeriesStore, TIMEFRAMES, dataSpan, loadManifest, type Bar, type Manifest, type TF } from './data'
import { ChartSettingsDialog, alpha, applyLook, loadLook } from './chartsettings'
import { openMenu, type MenuItem } from './ctxmenu'
import { DrawingLayer, type Drawing } from './drawings'
import { DrawTools, magnetLabel } from './drawtools'
import { DEFAULT_CONFIG } from './engine/account'
import { IndicatorManager } from './indicators/manager'
import type { IndicatorConfig } from './indicators/registry'
import { Replay, floorIndex, type ReplaySession } from './replay'
import { ZONES, d1DisplayTime, formatWall, makeShifter, parseZoned, toInputValue } from './time'
import { TradeUI, toast } from './trade'

// ---------- persisted settings ----------

const KEY = {
  tf: 'rc.v1.tf',
  zone: 'rc.v1.zone',
  drawings: 'rc.v1.drawings',
  indicators: 'rc.v1.indicators',
  chipsCollapsed: 'rc.v1.chipsCollapsed',
  replay: 'rc.v1.replay',
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
const tradeEl = $('trade')
const btBtn = $<HTMLButtonElement>('bt-btn')
const btEl = $('bt')

const css = getComputedStyle(document.documentElement)
const color = (name: string) => css.getPropertyValue(name).trim()

// ---------- state ----------

let manifest: Manifest
let store: SeriesStore
let tf: TF = load<TF>(KEY.tf, 'M15')
if (!TIMEFRAMES.includes(tf)) tf = 'M15'
let zone = load<string>(KEY.zone, 'Asia/Jakarta')
if (!ZONES.some((z) => z.id === zone)) zone = 'UTC'
let shift = makeShifter(zone)
let busy = false

let replay: Replay | null = null
let picking = false
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
  priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
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
      { text: duelBars ? 'DUEL' : 'XAUUSD', color: c, fontSize: 56, fontStyle: 'bold' },
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
  if (open && replay) return toast('Keluar dari replay dulu untuk backtest.', 'bad')
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

const duelBarEl = $('duel-bar')
const pricePick = $('price-pick')
const duelMarkersApi = createSeriesMarkers(candles, [])
let duelMarks: DuelMarker[] = []
let savedDrawings: Drawing[] | null = null
let savedTF: TF = tf
let pickResolve: ((p: number | null) => void) | null = null
const duelLines = (['entry', 'sl', 'tp'] as const).map((k) =>
  candles.createPriceLine({
    price: 0,
    color: k === 'entry' ? '#c9d1d9' : k === 'sl' ? '#ef5350' : '#26a69a',
    lineWidth: 1,
    lineStyle: k === 'entry' ? LineStyle.Solid : LineStyle.Dashed,
    axisLabelVisible: false,
    lineVisible: false,
    title: k === 'entry' ? 'Entry' : k.toUpperCase(),
  }),
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

const duelBtn = $<HTMLButtonElement>('duel-btn')
new ResizeObserver(() => chartWrap.style.setProperty('--duel-h', `${duelBarEl.offsetHeight || 44}px`)).observe(duelBarEl)

function setDuelUI(on: boolean) {
  document.body.classList.toggle('duel', on)
  duelBarEl.hidden = !on
  for (const el of [gotoInput, gotoForm.querySelector('button')!, replayBtn, btBtn, duelBtn]) (el as HTMLButtonElement).disabled = on
}

const duel = new DuelUI(duelBarEl, {
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
    for (const l of duelLines) l.applyOptions({ lineVisible: false, axisLabelVisible: false })
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
  setLines: (l) => {
    const v = [l.entry, l.sl, l.tp]
    duelLines.forEach((line, i) => {
      const p = v[i]
      line.applyOptions(p === null ? { lineVisible: false, axisLabelVisible: false } : { price: p, lineVisible: true, axisLabelVisible: true })
    })
  },
  setMarkers: (m) => {
    duelMarks = m
    syncDuelMarkers()
  },
  pickPrice: (label) =>
    new Promise((res) => {
      pickResolve?.(null)
      pickResolve = res
      pricePick.textContent = `${label} · Esc batal`
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

const fmt = (n: number) => n.toFixed(2)

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
    `<span><b>${manifest.symbol}</b> · ${tf}${when ? ` · ${when}` : ''}</span>`,
    `<span><span class="k">O</span>${fmt(b.open)}</span>`,
    `<span><span class="k">H</span>${fmt(b.high)}</span>`,
    `<span><span class="k">L</span>${fmt(b.low)}</span>`,
    `<span><span class="k">C</span><span class="${cls}">${fmt(b.close)}</span></span>`,
    `<span><span class="k">Ask</span><span class="ask">${fmt(b.close + b.spread)}</span></span>`,
    `<span class="${cls}">${chg >= 0 ? '+' : ''}${fmt(chg)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`,
    `<span><span class="k">Vol</span>${b.volume.toLocaleString('id-ID')}</span>`,
    `<span><span class="k">Spread</span>${fmt(b.spread)}</span>`,
  ].join('')
}

function updateStatus() {
  const zoneLabel = ZONES.find((z) => z.id === zone)?.label ?? zone
  if (duelBars) {
    statusInfo.textContent = `Duel ${tf} · harga dinormalisasi, tanggal${duelHard ? ' dan jam' : ''} disembunyikan · Ask = Bid + spread`
    return
  }
  if (replay) {
    statusInfo.textContent =
      `Replay ${tf} · ${hideDate() ? 'tanggal disembunyikan' : `mulai ${formatWall(shift(replay.startTime))}`} · ` +
      `harga candle = Bid, Ask = Bid + spread`
    return
  }
  const m1 = manifest.timeframes.M1
  const total = m1.reduce((s, c) => s + c.bars, 0)
  const from = formatWall(shift(m1[0].from), false)
  const to = formatWall(shift(m1[m1.length - 1].to), false)
  statusInfo.textContent =
    `Data ${from} → ${to} · ${total.toLocaleString('id-ID')} candle M1 · ` +
    `dimuat ${store.bars.length.toLocaleString('id-ID')} candle ${tf} · zona ${tf === 'D1' ? 'hari trading NY 17:00' : zoneLabel} · ` +
    `harga candle = Bid, Ask = Bid + spread`
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
      showOverlay(`Gagal memuat data: ${(err as Error).message}`)
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
    save(KEY.tf, tf)
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
  <h3>Cara pakai replay</h3>
  <ol>
    <li><b>Putar</b> candle satu per satu dengan ▶ (<kbd>Spasi</kbd>) atau <b>Maju 1</b> (<kbd>Shift</kbd>+<kbd>→</kbd>). Atur kecepatan di sebelahnya.</li>
    <li><b>Buka posisi</b> dengan SELL / BUY di panel order. Untuk order limit/stop: klik kanan chart di harga yang diinginkan.</li>
    <li><b>SL dan TP</b>: tarik garis posisi di chart ke atas/bawah, atau klik garisnya lalu pilih Pasang SL/TP. Semua garis bisa digeser.</li>
    <li><b>Selesai</b>: Simpan untuk lanjut nanti, Keluar replay untuk kembali ke chart biasa. Riwayat dan statistik ada di panel.</li>
  </ol>
  <button type="button" data-help="close">Mengerti</button>`
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
  b.innerHTML = playing ? '⏸ <span class="rb-label">Jeda</span>' : '▶ <span class="rb-label">Putar</span>'
  b.setAttribute('aria-label', playing ? 'Jeda' : 'Putar')
  b.title = playing ? 'Jeda (Spasi)' : 'Putar (Spasi)'
}

function setPicking(on: boolean) {
  picking = on
  pickBar.hidden = !on
  pickLine.hidden = true
  chartWrap.classList.toggle('picking', on)
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
  const r = new Replay(manifest, { ...DEFAULT_CONFIG })
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
  if (!moved) toast('Data habis, replay selesai.')
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
    if (saved && confirm('Lanjutkan sesi replay sebelumnya?\n\nOK = lanjutkan, Batal = mulai sesi baru.')) {
      return void startReplay(saved.cursorTime, saved)
    }
    setPicking(true)
  })

  pickBar.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-p]')?.dataset.p
    if (act === 'random') void startReplay(randomStart())
    if (act === 'cancel') setPicking(false)
  })

  // pick the start candle: capture phase on the wrapper runs before chart and drawing handlers
  chartWrap.addEventListener(
    'pointerdown',
    (e) => {
      if (!picking || e.button !== 0) return
      const rect = chartEl.getBoundingClientRect()
      const x = e.clientX - rect.left
      if (x < 0 || x > chart.timeScale().width()) return
      e.stopPropagation()
      e.preventDefault()
      const l = chart.timeScale().coordinateToLogical(x)
      if (l === null) return
      const i = Math.max(0, Math.min(Math.round(l), store.bars.length - 1))
      const bar = store.bars[i]
      // start at the end of the clicked candle: it is the last one shown
      void startReplay(bar.time + store.tfSec - 1)
    },
    true,
  )
  chartWrap.addEventListener('pointermove', (e) => {
    if (!picking) return
    const rect = chartWrap.getBoundingClientRect()
    const x = e.clientX - rect.left
    pickLine.hidden = x > chart.timeScale().width()
    pickLine.style.left = `${x}px`
  })

  replayBar.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-r]')?.dataset.r
    if (!replay) return
    if (act === 'play') playing ? stopPlay() : play()
    if (act === 'step') {
      stopPlay()
      void stepOnce()
    }
    if (act === 'restart' && confirm('Ulang dari titik awal? Posisi dan riwayat sesi ini dihapus.')) void startReplay(replay.startTime)
    if (act === 'exit') void exitReplay()
    if (act === 'save') void saveReplayToAccount()
    if (act === 'help') replayHelp.hidden = !replayHelp.hidden
  })
  const speedSel = replayBar.querySelector<HTMLSelectElement>('[data-r="speed"]')!
  for (const s of [1, 2, 5, 10, 20]) speedSel.add(new Option(`${s}×/detik`, String(s), false, s === speed))
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
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return
    if (picking && e.key === 'Escape') setPicking(false)
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
    const px = price === null ? '' : price.toFixed(2)
    const items: MenuItem[] = []

    if (hit) {
      drawings.select(hit)
      items.push(
        { label: 'Duplikat gambar', hint: 'Ctrl+D', act: () => drawings.duplicate(hit) },
        { label: 'Hapus gambar', hint: 'Del', danger: true, act: () => drawings.removeSelected() },
        'sep',
      )
    }

    const acc = replay ? trade.account : null
    const q = acc?.quote()
    if (acc && q && price !== null) {
      const p = Math.round(price * 100) / 100
      // below the market a buy waits as a limit and a sell as a stop; above it is the other way round
      const below = p < q.bid
      items.push(
        { label: `${below ? 'Buy limit' : 'Sell limit'} di ${p.toFixed(2)}`, hint: 'isi tiket', act: () => trade.prefill('limit', p) },
        { label: `${below ? 'Sell stop' : 'Buy stop'} di ${p.toFixed(2)}`, hint: 'isi tiket', act: () => trade.prefill('stop', p) },
        'sep',
      )
    }

    if (pt && price !== null) {
      items.push(
        { label: `Garis horizontal di ${px}`, act: () => drawings.addAt('hline', { t: pt.t, p: price }) },
        { label: `Salin harga ${px}`, act: () => void navigator.clipboard?.writeText(px) },
      )
    }
    if (!replay && !duelBars && !btOpen()) {
      items.push({
        label: 'Mulai replay dari candle ini',
        act: () => {
          const l = chart.timeScale().coordinateToLogical(x)
          if (l === null) return
          const bar = store.bars[Math.max(0, Math.min(Math.round(l), store.bars.length - 1))]
          void startReplay(bar.time + store.tfSec - 1)
        },
      })
    }
    items.push(
      'sep',
      { label: magnetLabel(drawings.magnet), hint: 'ganti', act: () => drawTools.cycleMagnet() },
      { label: 'Pengaturan chart…', act: openChartSettings },
      {
        label: 'Reset skala chart',
        act: () => {
          chart.priceScale('right').applyOptions({ autoScale: true })
          showLatest(currentSpan())
        },
      },
    )
    if (drawings.drawings.length) {
      items.push({ label: 'Hapus semua gambar', danger: true, act: () => confirm('Hapus semua gambar di chart?') && drawings.clear() })
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
  duelBtn.addEventListener('click', () => duel.open())
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

// ---------- boot ----------

async function boot() {
  showOverlay('Memuat data…')
  try {
    manifest = await loadManifest()
  } catch {
    showOverlay(
      'Data belum ada. Dari folder repo jalankan:' +
        '<code>python tools/export_mt5.py</code><code>python tools/build_data.py --strict</code>',
    )
    return
  }
  drawings.setDigits(2)
  indicators.load(load<IndicatorConfig[]>(KEY.indicators, []))
  buildControls()
  store = new SeriesStore(manifest, tf)
  try {
    await store.loadAround(null)
  } catch (err) {
    showOverlay(`Gagal memuat data: ${(err as Error).message}`)
    return
  }
  render()
  showLatest(160)
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
