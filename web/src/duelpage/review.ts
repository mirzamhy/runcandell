/**
 * Trade review for a finished duel round: the real candles around the cut, where each player
 * entered and left, where SL/TP sat, and a few plain notes on what price did. Opens as a dialog
 * on the duel page.
 */
import { CandlestickSeries, LineStyle, createChart, createSeriesMarkers, type IChartApi, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts'
import { duelApi, type DuelReview, type ReviewTF } from '../api'
import { instrument } from '../instruments'
import { formatWall } from '../time'
import type { Bar } from '../types'

type Trade = DuelReview['trades'][number]

const TFS: ReviewTF[] = ['M1', 'M5', 'M15', 'H1']
const TF_SEC: Record<ReviewTF, number> = { M1: 60, M5: 300, M15: 900, H1: 3600 }
const REASON: Record<string, string> = {
  tp: 'Hit TP',
  sl: 'Hit SL',
  time: 'Closed at the end of the run',
  skip: 'Skipped',
  timeout: 'Too late (skip)',
  stopout: 'Stop-out',
  unfilled: 'Order never filled',
}
const COLOR = { buy: '#4c8dff', sell: '#ef5350', sl: '#ef5350', tp: '#26a69a', exit: '#c9c3e6', cut: '#9d8cff' }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const fmtR = (r: number) => `${r > 0 ? '+' : ''}${r.toFixed(2)}R`
const tone = (n: number) => (!n ? '' : n > 0 ? 'pos' : 'neg')
const local = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' })
/** "2024-03-12 08:15 UTC" plus the reader's own clock, e.g. "15:15 GMT+7" */
const when = (t: number) => `${formatWall(t)} UTC <small>(${esc(local.format(new Date(t * 1000)))})</small>`
function dur(sec: number) {
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

interface State {
  code: string
  round: number
  tf: ReviewTF
  who: string | null
  data: DuelReview | null
  chart: IChartApi | null
}

/** Open the review of one round; `who` picks whose trade is shown first (default: yours). */
export function openReview(code: string, round: number, who?: string) {
  const dlg = document.createElement('dialog')
  dlg.className = 'rv'
  dlg.innerHTML = `
    <header class="rv-head">
      <h2 data-o="title">Round ${round}</h2>
      <button type="button" class="rv-x" data-rv="close" aria-label="Close">✕</button>
    </header>
    <p class="rv-where" data-o="where">Loading the real chart…</p>
    <div class="rv-bar">
      <div class="rv-seg" role="group" aria-label="Timeframe">${TFS.map((t) => `<button type="button" data-rv="tf" data-v="${t}">${t}</button>`).join('')}</div>
      <div class="rv-seg" role="group" aria-label="Whose trade" data-o="who"></div>
    </div>
    <div class="rv-chart" data-o="chart"></div>
    <div class="rv-detail" data-o="detail"></div>`
  document.body.append(dlg)
  const s: State = { code, round, tf: 'M5', who: who ?? null, data: null, chart: null }
  const close = () => {
    s.chart?.remove()
    dlg.remove()
  }
  dlg.addEventListener('close', close)
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close()
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-rv]')
    if (!el) return
    if (el.dataset.rv === 'close') dlg.close()
    if (el.dataset.rv === 'tf' && el.dataset.v !== s.tf) void load(dlg, s, el.dataset.v as ReviewTF)
    if (el.dataset.rv === 'who') {
      s.who = el.dataset.v!
      draw(dlg, s)
    }
  })
  dlg.showModal()
  void load(dlg, s, s.tf)
}

async function load(dlg: HTMLDialogElement, s: State, tf: ReviewTF) {
  const q = (k: string) => dlg.querySelector<HTMLElement>(`[data-o="${k}"]`)!
  for (const b of dlg.querySelectorAll<HTMLElement>('[data-rv="tf"]')) b.setAttribute('aria-pressed', String(b.dataset.v === tf))
  try {
    s.data = await duelApi.review(s.code, s.round, tf)
    s.tf = tf
  } catch (err) {
    q('where').textContent = (err as Error).message
    return
  }
  const d = s.data
  if (!s.who || !d.trades.some((t) => t.nickname === s.who)) s.who = (d.trades.find((t) => t.me) ?? d.trades[0])?.nickname ?? null
  const label = instrument(d.symbol).label
  q('title').innerHTML = `Round ${d.round}/${d.rounds} · ${esc(d.symbol)} <small>${esc(label)}</small>`
  q('where').innerHTML =
    `Real ${esc(d.symbol)} data, ${d.tf} candles from ${when(d.from)} to ${when(d.to)}. ` +
    `The chart was cut at <b>${when(d.cutTime)}</b> (Bid ${d.bid.toFixed(d.digits)}, Ask ${d.ask.toFixed(d.digits)}) ` +
    `and each trade could run until ${when(d.runEnd)}. Chart times are UTC.`
  draw(dlg, s)
}

/** where the trade sits in the candles: furthest in profit and against it, and what came after */
function excursions(bars: Bar[], t: Trade, tfSec: number) {
  if (t.entry === null || t.entryTime === null || t.sl === null) return null
  const risk = Math.abs(t.entry - t.sl)
  if (!risk) return null
  const end = t.exitTime ?? Infinity
  const inTrade = bars.filter((b) => b.time + tfSec > t.entryTime! && b.time <= end)
  const after = bars.filter((b) => t.exitTime !== null && b.time > t.exitTime)
  const dir = t.side === 'buy' ? 1 : -1
  const best = (list: Bar[]) => (list.length ? Math.max(...list.map((b) => (dir > 0 ? b.high - t.entry! : t.entry! - b.low))) / risk : null)
  const worst = (list: Bar[]) => (list.length ? Math.max(...list.map((b) => (dir > 0 ? t.entry! - b.low : b.high - t.entry!))) / risk : null)
  const tpAfter = t.tp !== null && after.some((b) => (dir > 0 ? b.high >= t.tp! : b.low <= t.tp!))
  return { mfe: best(inTrade), mae: worst(inTrade), afterBest: best(after), tpAfter }
}

function notes(d: DuelReview, t: Trade) {
  const out: string[] = []
  const px = (v: number) => v.toFixed(d.digits)
  if (t.side === 'skip') {
    out.push(t.reason === 'timeout' ? 'No order was sent in time, so the round counted as a skip.' : 'You stayed out of this one.')
    return out
  }
  if (t.reason === 'unfilled' && t.price !== null) {
    const after = d.bars.filter((b) => b.time > d.cutTime)
    const near = t.side === 'buy' ? Math.min(...after.map((b) => b.low)) : Math.max(...after.map((b) => b.high))
    if (Number.isFinite(near)) out.push(`Price never reached the order at ${px(t.price)}. The closest it got was ${px(near)}, ${px(Math.abs(near - t.price))} away.`)
    return out
  }
  const x = excursions(d.bars, t, TF_SEC[d.tf])
  if (!x) return out
  if (x.mfe !== null) out.push(`Furthest in profit while open: ${fmtR(x.mfe)}. Furthest against you: ${fmtR(-(x.mae ?? 0))}.`)
  if (t.reason === 'sl' && x.mfe !== null && x.mfe >= 1) out.push(`It was ${fmtR(x.mfe)} in profit before turning round and hitting the stop. A break-even or partial exit would have kept some of it.`)
  if (t.reason === 'sl' && x.tpAfter) out.push('After stopping you out, price went on to reach your TP. The direction was right; the stop was too close for the noise.')
  if (t.reason === 'tp' && x.afterBest !== null && x.afterBest > Math.abs((t.tp ?? 0) - t.entry!) / Math.abs(t.entry! - t.sl!) + 1)
    out.push(`After your TP, price kept going to ${fmtR(x.afterBest)} from your entry. A wider target or a trailing stop could have caught more.`)
  if (t.reason === 'time') out.push('Neither SL nor TP was reached within the run, so it closed at the last price.')
  if (d.tf !== 'M1') out.push(`These figures come from ${d.tf} candles; switch to M1 for the exact path.`)
  return out
}

function draw(dlg: HTMLDialogElement, s: State) {
  const d = s.data
  if (!d) return
  const q = (k: string) => dlg.querySelector<HTMLElement>(`[data-o="${k}"]`)!
  const t = d.trades.find((x) => x.nickname === s.who) ?? null
  q('who').innerHTML =
    d.trades.length > 1
      ? d.trades.map((x) => `<button type="button" data-rv="who" data-v="${esc(x.nickname)}" aria-pressed="${x.nickname === s.who}">${esc(x.nickname)}${x.me ? ' (you)' : ''}</button>`).join('')
      : ''

  // ---- chart ----
  s.chart?.remove()
  const box = q('chart')
  box.innerHTML = ''
  const css = getComputedStyle(document.documentElement)
  const chart = createChart(box, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: css.getPropertyValue('--muted').trim() || '#a39bc6', fontFamily: 'Space Grotesk, sans-serif', attributionLogo: false },
    grid: { vertLines: { color: 'rgba(217,252,237,0.05)' }, horzLines: { color: 'rgba(217,252,237,0.05)' } },
    rightPriceScale: { borderColor: 'rgba(217,252,237,0.12)' },
    timeScale: { borderColor: 'rgba(217,252,237,0.12)', timeVisible: true, secondsVisible: false },
  })
  s.chart = chart
  const series = chart.addSeries(CandlestickSeries, {
    upColor: '#2fd4b0',
    downColor: '#ff6b5e',
    borderVisible: false,
    wickUpColor: '#2fd4b0',
    wickDownColor: '#ff6b5e',
    priceFormat: { type: 'price', precision: d.digits, minMove: 1 / 10 ** d.digits },
  })
  series.setData(d.bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })))
  const step = TF_SEC[d.tf]
  const floor = (time: number) => (Math.floor(time / step) * step) as UTCTimestamp
  const line = (price: number | null, color: string, title: string, style: LineStyle, width: 1 | 2 = 1) =>
    price !== null && series.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true })
  // the decision candle gets its own mark unless the entry arrow already sits on it
  const enteredAtCut = t?.entryTime !== null && t?.entryTime !== undefined && floor(t.entryTime) === floor(d.cutTime)
  const marks: SeriesMarker<Time>[] = enteredAtCut ? [] : [{ time: floor(d.cutTime), position: 'aboveBar', color: COLOR.cut, shape: 'square', text: 'Decision' }]
  if (t && t.side !== 'skip') {
    const side = t.side as 'buy' | 'sell'
    if (t.entry !== null) line(t.entry, COLOR[side], `${side.toUpperCase()} entry`, LineStyle.Solid, 2)
    else line(t.price, COLOR[side], `${side.toUpperCase()} ${t.type} (not filled)`, LineStyle.Dashed, 2)
    line(t.sl, COLOR.sl, 'SL', LineStyle.Dashed)
    line(t.tp, COLOR.tp, 'TP', LineStyle.Dashed)
    line(t.exit, COLOR.exit, 'Exit', LineStyle.Dotted)
    if (t.entryTime !== null && t.entry !== null)
      marks.push(
        side === 'buy'
          ? { time: floor(t.entryTime), position: 'belowBar', color: COLOR.buy, shape: 'arrowUp', text: `Buy ${t.entry.toFixed(d.digits)}` }
          : { time: floor(t.entryTime), position: 'aboveBar', color: COLOR.sell, shape: 'arrowDown', text: `Sell ${t.entry.toFixed(d.digits)}` },
      )
    if (t.exitTime !== null && t.exit !== null)
      marks.push({ time: floor(t.exitTime), position: side === 'buy' ? 'aboveBar' : 'belowBar', color: t.r >= 0 ? COLOR.tp : COLOR.sl, shape: 'circle', text: `Exit ${fmtR(t.r)}` })
  }
  // markers on the same candle must stay in time order
  createSeriesMarkers(series, marks.sort((a, b) => (a.time as number) - (b.time as number)))
  const until = t?.exitTime ?? d.runEnd
  chart.timeScale().setVisibleRange({ from: (d.cutTime - 40 * step) as UTCTimestamp, to: (until + 15 * step) as UTCTimestamp })

  // ---- facts ----
  if (!t) {
    q('detail').innerHTML = '<p class="rv-empty">No trades in this round.</p>'
    return
  }
  const px = (v: number | null) => (v === null ? '–' : v.toFixed(d.digits))
  const row = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`
  const risk = t.entry !== null && t.sl !== null ? Math.abs(t.entry - t.sl) : t.price !== null && t.sl !== null ? Math.abs(t.price - t.sl) : null
  const base = t.entry ?? t.price
  const planned = risk && t.tp !== null && base !== null ? Math.abs(t.tp - base) / risk : null
  const rows =
    t.side === 'skip'
      ? row('Decision', 'Skip')
      : [
          row('Order', `${t.side.toUpperCase()} ${t.type.toUpperCase()}${t.price !== null ? ` at ${px(t.price)}` : ''}`),
          row('Entry', t.entry === null ? 'not filled' : `${px(t.entry)} · ${t.entryTime === null ? '' : when(t.entryTime)}`),
          row('Exit', t.exit === null ? '–' : `${px(t.exit)} · ${t.exitTime === null ? '' : when(t.exitTime)}`),
          row('Stop loss', `${px(t.sl)}${risk ? ` <small>(${px(risk)} away = 1R)</small>` : ''}`),
          row('Take profit', t.tp === null ? 'none' : `${px(t.tp)}${planned ? ` <small>(planned ${planned.toFixed(2)}R)</small>` : ''}`),
          t.entryTime !== null && t.exitTime !== null ? row('Time in trade', dur(t.exitTime - t.entryTime)) : '',
        ].join('')
  const list = notes(d, t)
  q('detail').innerHTML = `
    <div class="rv-result ${tone(t.r)}"><b>${fmtR(t.r)}</b><span>${esc(t.nickname)}${t.me ? ' (you)' : ''} · ${REASON[t.reason] ?? esc(t.reason)}</span></div>
    <dl class="rv-facts">${rows}</dl>
    ${list.length ? `<h3>What price did</h3><ul class="rv-notes">${list.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}`
}
