import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  type CandlestickData,
  type HistogramData,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import './style.css'
import { SeriesStore, TIMEFRAMES, loadManifest, type Bar, type Manifest, type TF } from './data'
import { DrawingLayer, type Drawing, type Tool } from './drawings'
import { IndicatorManager } from './indicators/manager'
import type { IndicatorConfig } from './indicators/registry'
import { ZONES, d1DisplayTime, formatWall, makeShifter, parseZoned, toInputValue } from './time'

// ---------- persisted settings ----------

const KEY = { tf: 'rc.v1.tf', zone: 'rc.v1.zone', drawings: 'rc.v1.drawings', indicators: 'rc.v1.indicators', chipsCollapsed: 'rc.v1.chipsCollapsed' }

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
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const chartEl = $('chart')
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

const css = getComputedStyle(document.documentElement)
const color = (name: string) => css.getPropertyValue(name).trim()

// ---------- chart ----------

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
  timeScale: { borderColor: color('--border'), timeVisible: true, secondsVisible: false, rightOffset: 10 },
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

// ---------- state ----------

let manifest: Manifest
let store: SeriesStore
let tf: TF = load<TF>(KEY.tf, 'M15')
if (!TIMEFRAMES.includes(tf)) tf = 'M15'
let zone = load<string>(KEY.zone, 'Asia/Jakarta')
if (!ZONES.some((z) => z.id === zone)) zone = 'UTC'
let shift = makeShifter(zone)
let busy = false

const displayTime = (t: number) => (tf === 'D1' ? d1DisplayTime(t) : shift(t))

const drawings = new DrawingLayer(
  {
    toLogical: (t) => (store ? store.indexOfTime(t) : 0),
    toTime: (l) => (store ? store.timeOfIndex(l) : 0),
  },
  chartEl,
)
candles.attachPrimitive(drawings)
drawings.load(load<Drawing[]>(KEY.drawings, []))
drawings.onChange = () => save(KEY.drawings, drawings.drawings)

const indicators = new IndicatorManager({ chart, candles }, $('chips'), $('pane-chips'), $<HTMLDialogElement>('ind-dialog'))
indicators.onSave = (list) => save(KEY.indicators, list)
indicators.collapsed = load<boolean>(KEY.chipsCollapsed, false)
indicators.onCollapse = (c) => save(KEY.chipsCollapsed, c)

// ---------- rendering ----------

function render() {
  const bars = store.bars
  const c: CandlestickData<Time>[] = new Array(bars.length)
  const v: HistogramData<Time>[] = new Array(bars.length)
  const upVol = 'rgba(38,166,154,0.45)'
  const downVol = 'rgba(239,83,80,0.45)'
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
  candles.setData(c)
  volume.setData(v)
  indicators.update(bars, c.map((x) => x.time), store.tfSec)
  updateQuoteLines()
  drawings.refresh()
  updateLegend()
  updateStatus()
}

const fmt = (n: number) => n.toFixed(2)

/** Bid/Ask lines only make sense at the newest bar; hide them while viewing an older window. */
function updateQuoteLines() {
  const last = store.bars[store.bars.length - 1]
  const show = store.atLatest && !!last
  const bidColor = last && last.close >= last.open ? color('--up') : color('--down')
  bidLine.applyOptions({
    price: last?.close ?? 0,
    color: bidColor,
    lineVisible: show,
    axisLabelVisible: show,
  })
  askLine.applyOptions({
    price: last ? last.close + last.spread : 0,
    lineVisible: show,
    axisLabelVisible: show,
  })
}

function updateLegend(param?: MouseEventParams<Time>) {
  if (!store?.bars.length) {
    legendEl.textContent = ''
    return
  }
  let i = store.bars.length - 1
  if (param?.logical !== undefined && param.point) i = Math.round(param.logical)
  const b: Bar | undefined = store.bars[i]
  if (!b) return
  const prev = store.bars[i - 1]
  const chg = prev ? b.close - prev.close : b.close - b.open
  const pct = (chg / (prev ? prev.close : b.open)) * 100
  const cls = chg >= 0 ? 'up' : 'down'
  const when = formatWall(displayTime(b.time), tf !== 'D1')
  legendEl.innerHTML = [
    `<span><b>${manifest.symbol}</b> · ${tf} · ${when}</span>`,
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
  const m1 = manifest.timeframes.M1
  const total = m1.reduce((s, c) => s + c.bars, 0)
  const from = formatWall(shift(m1[0].from), false)
  const to = formatWall(shift(m1[m1.length - 1].to), false)
  const zoneLabel = ZONES.find((z) => z.id === zone)?.label ?? zone
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
  const n = store.bars.length
  chart.timeScale().setVisibleLogicalRange({ from: n - span * 0.9, to: n + span * 0.1 })
}

async function switchTF(next: TF) {
  const r = chart.timeScale().getVisibleLogicalRange()
  let centerT: number | null = null
  let span = 160
  let followLatest = true
  if (store && r) {
    centerT = store.timeOfIndex((r.from + r.to) / 2)
    span = Math.max(30, r.to - r.from)
    followLatest = store.atLatest && r.to >= store.bars.length - 2
  }
  await withBusy(async () => {
    const s = new SeriesStore(manifest, next)
    await s.loadAround(followLatest ? null : centerT)
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
  const r = chart.timeScale().getVisibleLogicalRange()
  const span = r ? Math.max(30, r.to - r.from) : 160
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
  const r = chart.timeScale().getVisibleLogicalRange()
  const span = r ? Math.max(30, r.to - r.from) : 160
  await withBusy(async () => {
    if (!store.atLatest) {
      await store.loadAround(null)
      render()
    }
    showLatest(span)
  })
}

/** Load neighbouring chunks when the user scrolls near the edge of what is loaded. */
function onRangeChange(r: LogicalRange | null) {
  if (!r || busy || !store) return
  const n = store.bars.length
  if (r.from < 200 && store.canLeft) {
    void withBusy(async () => {
      const added = await store.extendLeft()
      const cur = chart.timeScale().getVisibleLogicalRange() ?? r
      render()
      chart.timeScale().setVisibleLogicalRange({ from: cur.from + added, to: cur.to + added })
    })
  } else if (r.to > n - 200 && store.canRight) {
    void withBusy(async () => {
      const cur = chart.timeScale().getVisibleLogicalRange() ?? r
      await store.extendRight()
      render()
      chart.timeScale().setVisibleLogicalRange(cur)
    })
  }
}

// ---------- controls ----------

function syncTFButtons() {
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

  const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('#tools [data-tool]')]
  const syncTools = (t: Tool) => {
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === t))
  }
  drawings.onToolChange = syncTools
  for (const b of toolButtons) b.addEventListener('click', () => drawings.setTool(b.dataset.tool as Tool))
  syncTools('cursor')
  $('delete-sel').addEventListener('click', () => drawings.removeSelected())
  $('clear-all').addEventListener('click', () => {
    if (drawings.drawings.length && confirm('Hapus semua gambar di chart?')) drawings.clear()
  })

  chart.subscribeCrosshairMove((p) => {
    updateLegend(p)
    const i = p.logical !== undefined && p.point ? Math.round(p.logical) : store.bars.length - 1
    indicators.legend(Math.min(Math.max(i, 0), store.bars.length - 1))
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
}

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__rc = { chart, getStore: () => store, drawings, indicators }
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
  gotoInput.value = toInputValue(displayTime(store.bars[store.bars.length - 1].time))
  showOverlay(null)
}

void boot()
