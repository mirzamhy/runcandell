/**
 * Playing a duel round on the chart: order panel on the right, BUY/SELL on the chart,
 * draggable order / SL / TP lines, the analysis timer, and the reveal. The lobby is duel.html.
 */
import { duelApi, type DecideResult, type Snapshot } from './api'
import { checkDecision, pendingTypeFor, type DuelOrderType } from './engine/duel'
import { ask } from './shared/ask'
import { toast } from './trade'
import type { Bar, TF } from './types'

const fmtR = (r: number | null | undefined) => (r === null || r === undefined ? '–' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`)
const cls = (n: number | null | undefined) => (!n ? '' : n > 0 ? 'pos' : 'neg')
const REASON: Record<string, string> = {
  tp: 'Kena TP',
  sl: 'Kena SL',
  time: 'Waktu habis',
  skip: 'Skip',
  timeout: 'Telat (skip)',
  stopout: 'Stop-out',
  unfilled: 'Order tidak tersentuh',
}
const TYPE: Record<DuelOrderType, string> = { market: 'Market', limit: 'Limit', stop: 'Stop' }
const COLOR = { buy: '#4c8dff', sell: '#ef5350', sl: '#ef5350', tp: '#26a69a' }
const round2 = (x: number) => Math.round(x * 100) / 100

export interface DuelMarker {
  time: number
  text: string
  color: string
  position: 'aboveBar' | 'belowBar'
  shape: 'arrowUp' | 'arrowDown' | 'circle'
}

export type LineField = 'entry' | 'sl' | 'tp'

export interface DuelLine {
  field: LineField
  price: number
  title: string
  color: string
  solid: boolean
  /** can be dragged on the chart */
  drag: boolean
}

export interface DuelHost {
  requireLogin(): Promise<boolean>
  /** switch the chart to these (normalised) bars */
  enter(bars: Record<TF, Bar[]>, hardcore: boolean): void
  /** bars were extended in place (reveal) */
  update(): void
  exit(): void
  setLines(l: DuelLine[]): void
  setMarkers(m: DuelMarker[]): void
  /** resolve with the price of the next click on the chart (null if cancelled) */
  pickPrice(label: string): Promise<number | null>
}

interface Draft {
  side: 'buy' | 'sell' | null
  type: DuelOrderType
  /** order price (limit/stop only) */
  price: number | null
  sl: number | null
  tp: number | null
}

interface Play {
  code: string
  snap: Snapshot
  bars: Record<TF, Bar[]>
  draft: Draft
  deadline: number
  timer: number
  submitting: boolean
  revealed: DecideResult | null
}

export class DuelUI {
  play: Play | null = null

  /**
   * @param panel right-hand order panel
   * @param quick BUY / SELL buttons on the chart
   */
  constructor(
    private readonly panel: HTMLElement,
    private readonly quick: HTMLElement,
    private readonly host: DuelHost,
  ) {
    panel.addEventListener('click', (e) => void this.onClick(e))
    quick.addEventListener('click', (e) => void this.onClick(e))
    panel.addEventListener('change', (e) => this.onInput(e))
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).matches('input')) this.onInput(e)
    })
  }

  get active() {
    return !!this.play
  }

  /** the duel page: lobby, or one duel's VS screen and results */
  open(code?: string) {
    location.href = code ? `/duel.html?code=${encodeURIComponent(code)}` : '/duel.html'
  }

  // ---------- a round ----------

  async startRound(code: string, n: number) {
    let snap: Snapshot
    try {
      snap = await duelApi.start(code, n)
    } catch (err) {
      toast((err as Error).message, 'bad')
      // round already played or not allowed: show the duel instead
      setTimeout(() => this.open(code), 1500)
      return
    }
    // copies: the reveal appends to these
    const bars = Object.fromEntries(Object.entries(snap.bars).map(([k, v]) => [k, [...v]])) as Record<TF, Bar[]>
    this.play = {
      code,
      snap,
      bars,
      draft: { side: null, type: 'market', price: null, sl: null, tp: null },
      deadline: performance.now() + snap.remaining * 1000,
      timer: 0,
      submitting: false,
      revealed: null,
    }
    this.host.enter(bars, snap.hardcore)
    this.host.setMarkers([])
    this.render()
    this.play.timer = window.setInterval(() => this.tick(), 250)
    this.tick()
  }

  // ---------- draft: one order, edited from the panel or the chart ----------

  private bid() {
    return this.play!.snap.cut.close
  }
  private ask() {
    const c = this.play!.snap.cut
    return c.close + c.spread
  }

  /** where the order fills: Ask/Bid now for market, the order price for limit/stop */
  private entry(d = this.play!.draft): number | null {
    if (!d.side) return null
    if (d.type === 'market') return d.side === 'buy' ? this.ask() : this.bid()
    return d.price
  }

  private stopDist() {
    return this.play!.snap.minStop
  }

  /** starting SL 2x the minimum stop, TP at 2R */
  private bracket(entry: number, side: 'buy' | 'sell') {
    const dir = side === 'buy' ? 1 : -1
    const risk = this.stopDist() * 2
    return { sl: round2(entry - dir * risk), tp: round2(entry + dir * risk * 2) }
  }

  /** a sensible pending price for a type: two minimum stops away from the market, on its side */
  private defaultPrice(side: 'buy' | 'sell', type: 'limit' | 'stop') {
    const now = side === 'buy' ? this.ask() : this.bid()
    const below = (type === 'limit') === (side === 'buy')
    return round2(now + (below ? -1 : 1) * this.stopDist() * 2)
  }

  private setSide(side: 'buy' | 'sell') {
    const d = this.play!.draft
    if (d.side === side && d.sl !== null) return this.sync()
    d.side = side
    if (d.type !== 'market') {
      if (d.price === null) d.price = this.defaultPrice(side, d.type)
      d.type = pendingTypeFor(this.play!.snap.cut, side, d.price)
    }
    Object.assign(d, this.bracket(this.entry()!, side))
    this.render()
  }

  private setType(type: DuelOrderType) {
    const d = this.play!.draft
    if (!d.side) d.side = 'buy'
    const before = this.entry()
    d.type = type
    if (type === 'market') d.price = null
    else if (d.price === null || pendingTypeFor(this.play!.snap.cut, d.side, d.price) !== type) d.price = this.defaultPrice(d.side, type)
    this.moveBracket(before)
    this.render()
  }

  /** set the order price (chart click, drag, input); limit vs stop follows from where it sits */
  private setPrice(price: number) {
    const p = this.play!
    const d = p.draft
    if (!d.side) d.side = 'buy'
    const before = this.entry()
    d.price = round2(price)
    const now = d.side === 'buy' ? this.ask() : this.bid()
    if (Math.abs(d.price - now) < 0.005) {
      d.type = 'market'
      d.price = null
    } else d.type = pendingTypeFor(p.snap.cut, d.side, d.price)
    this.moveBracket(before)
    this.render()
  }

  /** SL/TP keep their distance when the entry moves, like dragging a bracket order */
  private moveBracket(before: number | null) {
    const d = this.play!.draft
    const after = this.entry()
    if (after === null) return
    if (before === null || d.sl === null) {
      Object.assign(d, this.bracket(after, d.side!))
      return
    }
    const shift = after - before
    d.sl = round2(d.sl + shift)
    if (d.tp !== null) d.tp = round2(d.tp + shift)
  }

  /** a line was dragged on the chart */
  dragLine(field: LineField, price: number) {
    const p = this.play
    if (!p || p.revealed || !p.draft.side) return
    if (field === 'entry') return this.setPrice(price)
    p.draft[field] = round2(price)
    this.sync()
  }

  /** a plain click on the chart: sets the price of a limit/stop order */
  chartClick(price: number) {
    const p = this.play
    if (!p || p.revealed || p.submitting || !p.draft.side || p.draft.type === 'market') return false
    this.setPrice(price)
    return true
  }

  /** right-click menu entries at a price */
  menuAt(price: number): { label: string; act: () => void }[] {
    const p = this.play
    if (!p || p.revealed || p.submitting) return []
    const px = round2(price)
    return (['buy', 'sell'] as const).map((side) => ({
      label: `${side === 'buy' ? 'Buy' : 'Sell'} ${pendingTypeFor(p.snap.cut, side, px)} di ${px.toFixed(2)}`,
      act: () => {
        p.draft.side = side
        p.draft.sl = null
        this.setPrice(px)
      },
    }))
  }

  private error(): string | null {
    const p = this.play!
    const d = p.draft
    if (!d.side) return null
    return checkDecision({ side: d.side, type: d.type, price: d.price, sl: d.sl, tp: d.tp }, p.snap.cut, p.snap.minStop)
  }

  // ---------- rendering ----------

  private render() {
    const p = this.play
    if (!p) return
    if (p.revealed) return this.renderResult()
    const s = p.snap
    const d = p.draft
    const seg = (t: DuelOrderType) => `<button type="button" data-b="type" data-v="${t}" aria-pressed="${d.type === t}">${TYPE[t]}</button>`
    const field = (k: 'price' | 'sl' | 'tp', label: string, hint: string) => {
      const v = d[k]
      return `
        <label class="dp-f" data-f="${k}">
          <span>${label}<small data-o="${k}"></small></span>
          <span class="dp-in">
            <input type="number" step="0.01" inputmode="decimal" data-i="${k}" value="${v === null ? '' : v.toFixed(2)}" placeholder="${hint}" ${d.side ? '' : 'disabled'} />
            <button type="button" class="dp-pick" data-b="pick" data-v="${k}" title="Klik chart untuk ${label}" aria-label="Klik chart untuk ${label}" ${d.side ? '' : 'disabled'}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5" /><path d="M10 1v5M10 14v5M1 10h5M14 10h5" /></svg>
            </button>
            ${k === 'tp' && v !== null ? '<button type="button" class="dp-pick" data-b="clear-tp" title="Tanpa TP" aria-label="Tanpa TP">×</button>' : ''}
          </span>
        </label>`
    }
    this.panel.innerHTML = `
      <header class="dp-head">
        <span class="dp-round">Ronde ${s.round}/${s.rounds}</span>
        <span class="dp-timer" data-o="timer">--:--</span>
      </header>
      <div class="dp-bs">
        <button type="button" class="sell" data-b="sell" aria-pressed="${d.side === 'sell'}"><small>SELL</small><b>${this.bid().toFixed(2)}</b></button>
        <span class="dp-spread" title="Spread">${s.cut.spread.toFixed(2)}</span>
        <button type="button" class="buy" data-b="buy" aria-pressed="${d.side === 'buy'}"><small>BUY</small><b>${this.ask().toFixed(2)}</b></button>
      </div>
      <div class="dp-seg" role="group" aria-label="Jenis order">${seg('market')}${seg('limit')}${seg('stop')}</div>
      ${d.type === 'market' ? '' : field('price', 'Harga order', 'klik chart')}
      ${field('sl', 'Stop loss', 'wajib')}
      ${field('tp', 'Take profit', 'opsional')}
      <div class="dp-rr" role="group" aria-label="TP cepat">
        <span>TP</span>
        ${[1, 1.5, 2, 3].map((r) => `<button type="button" data-b="rr" data-v="${r}" ${d.side ? '' : 'disabled'}>${r}R</button>`).join('')}
      </div>
      <p class="dp-sum" data-o="sum"></p>
      <p class="dp-err" data-o="err" role="alert"></p>
      <button type="button" class="dp-send ${d.side ?? ''}" data-b="send" data-o="send">Pilih BUY atau SELL</button>
      <button type="button" class="dp-skip" data-b="skip">Skip ronde (0R)</button>
      <p class="dp-help">Geser garis order, SL, dan TP di chart. Klik kanan chart untuk order limit/stop di harga itu. SL minimal ${s.minStop.toFixed(2)}.</p>`
    this.sync()
  }

  /** everything that depends on the draft values, without rebuilding the panel */
  private sync() {
    const p = this.play
    if (!p || p.revealed) return
    const d = p.draft
    const e = this.entry()
    const err = this.error()
    const q = <T extends HTMLElement>(sel: string) => this.panel.querySelector<T>(sel)

    for (const k of ['price', 'sl', 'tp'] as const) {
      const el = q<HTMLInputElement>(`[data-i="${k}"]`)
      if (el && document.activeElement !== el) el.value = d[k] === null ? '' : d[k]!.toFixed(2)
    }
    const risk = e !== null && d.sl !== null ? Math.abs(e - d.sl) : null
    const set = (k: string, t: string) => {
      const el = q(`[data-o="${k}"]`)
      if (el) el.textContent = t
    }
    set('price', d.type === 'market' ? '' : ` · ${d.side === 'buy' ? 'Buy' : 'Sell'} ${d.type}`)
    set('sl', risk !== null ? ` · 1R = ${risk.toFixed(2)}` : '')
    set('tp', risk && d.tp !== null && e !== null ? ` · ${(Math.abs(d.tp - e) / risk).toFixed(2)}R` : '')
    const pending = d.type !== 'market'
    set(
      'sum',
      !d.side
        ? 'Pilih arah dulu: tombol di atas atau di chart.'
        : `${d.side.toUpperCase()} ${TYPE[d.type].toUpperCase()} ${e === null ? '' : `di ${e.toFixed(2)}`}${pending ? '. Kalau harga tidak menyentuh order sampai waktu habis, ronde dihitung 0R.' : '.'}`,
    )
    set('err', err ?? '')
    const send = q<HTMLButtonElement>('[data-o="send"]')
    if (send) {
      send.disabled = !d.side || !!err || p.submitting
      send.className = `dp-send ${d.side ?? ''}`
      send.textContent = !d.side ? 'Pilih BUY atau SELL' : `Kirim ${d.side.toUpperCase()} ${TYPE[d.type].toUpperCase()}`
    }
    this.renderQuick()
    this.drawLines()
  }

  private renderQuick() {
    const p = this.play
    if (!p || p.revealed) {
      this.quick.hidden = true
      return
    }
    const d = p.draft
    this.quick.hidden = false
    const hint = d.side && d.type !== 'market' && d.price === null ? '<span class="dq-hint">Klik chart untuk harga order</span>' : ''
    this.quick.innerHTML = `
      <button type="button" class="sell" data-b="sell" aria-pressed="${d.side === 'sell'}"><small>SELL</small>${this.bid().toFixed(2)}</button>
      <span class="dq-spread">${p.snap.cut.spread.toFixed(2)}</span>
      <button type="button" class="buy" data-b="buy" aria-pressed="${d.side === 'buy'}"><small>BUY</small>${this.ask().toFixed(2)}</button>${hint}`
  }

  private drawLines() {
    const p = this.play!
    const d = p.draft
    const e = this.entry()
    if (!d.side || e === null) return this.host.setLines([])
    const risk = d.sl === null ? 0 : Math.abs(e - d.sl)
    const lines: DuelLine[] = [
      {
        field: 'entry',
        price: e,
        title: `${d.side.toUpperCase()} ${d.type === 'market' ? 'MARKET' : d.type.toUpperCase()}`,
        color: COLOR[d.side],
        solid: d.type === 'market',
        drag: true,
      },
    ]
    if (d.sl !== null) lines.push({ field: 'sl', price: d.sl, title: `SL −1R (${risk.toFixed(2)})`, color: COLOR.sl, solid: false, drag: true })
    if (d.tp !== null)
      lines.push({ field: 'tp', price: d.tp, title: `TP ${risk ? `+${(Math.abs(d.tp - e) / risk).toFixed(2)}R` : ''}`, color: COLOR.tp, solid: false, drag: true })
    this.host.setLines(lines)
  }

  private renderResult() {
    const p = this.play!
    const s = p.snap
    const res = p.revealed!
    const o = res.outcome
    const last = s.round === s.rounds
    const type = (o.type ?? 'market') as DuelOrderType
    const row = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`
    this.panel.innerHTML = `
      <header class="dp-head"><span class="dp-round">Ronde ${s.round}/${s.rounds}</span><span class="dp-done">Selesai</span></header>
      <div class="dp-res ${cls(o.r)}">
        <b>${fmtR(o.r)}</b>
        <span>${o.side === 'skip' ? 'Skip' : `${o.side.toUpperCase()} ${TYPE[type].toUpperCase()}`} · ${REASON[o.reason] ?? o.reason}</span>
        ${res.symbol ? `<span class="dp-pair">Pair ronde ini: <b>${res.symbol}</b></span>` : ''}
      </div>
      <dl class="dp-dl">
        ${o.price !== null && o.price !== undefined ? row('Harga order', o.price.toFixed(2)) : ''}
        ${o.entry !== null ? row('Entry', o.entry.toFixed(2)) : ''}
        ${o.exit !== null ? row('Exit', o.exit.toFixed(2)) : ''}
        ${o.sl !== null ? row('SL', o.sl.toFixed(2)) : ''}
        ${o.tp !== null ? row('TP', o.tp.toFixed(2)) : ''}
        ${res.totalR !== null ? row('Total duel', `<span class="${cls(res.totalR)}">${fmtR(res.totalR)}</span>`) : ''}
      </dl>
      <button type="button" class="dp-send next" data-b="${last ? 'summary' : 'next'}">${last ? 'Lihat hasil duel' : `Ronde ${s.round + 1} →`}</button>
      <button type="button" class="dp-skip" data-b="quit">Ke halaman duel</button>`
    this.quick.hidden = true
  }

  private tick() {
    const p = this.play
    if (!p || p.revealed) return
    const left = Math.max(0, (p.deadline - performance.now()) / 1000)
    const el = this.panel.querySelector<HTMLElement>('[data-o="timer"]')
    if (el) {
      el.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`
      el.classList.toggle('low', left < 10)
    }
    if (left <= 0 && !p.submitting) {
      // time is up: send a valid order (the server still allows a few seconds), else skip
      void this.submit(p.draft.side && !this.error() ? 'order' : 'skip', true)
    }
  }

  // ---------- events ----------

  private onInput(e: Event) {
    const el = e.target as HTMLInputElement
    const k = el.dataset.i as 'price' | 'sl' | 'tp' | undefined
    const p = this.play
    if (!k || !p || p.revealed) return
    const v = el.value.trim() === '' ? null : Number(el.value)
    if (v !== null && !Number.isFinite(v)) return
    if (k === 'price') {
      if (v !== null) this.setPrice(v)
      return
    }
    p.draft[k] = v === null ? null : round2(v)
    if (k === 'tp') this.render()
    else this.sync()
  }

  private async onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-b]')
    const p = this.play
    if (!el || !p) return
    const a = el.dataset.b
    const v = el.dataset.v
    if (p.revealed) {
      if (a === 'next') await this.startRound(p.code, p.snap.round + 1)
      if (a === 'summary' || a === 'quit') {
        const code = p.code
        this.quit()
        this.open(code)
      }
      return
    }
    if (a === 'buy' || a === 'sell') this.setSide(a)
    if (a === 'type') this.setType(v as DuelOrderType)
    if (a === 'rr' && p.draft.side && p.draft.sl !== null) {
      const e0 = this.entry()!
      const risk = Math.abs(e0 - p.draft.sl)
      p.draft.tp = round2(e0 + (p.draft.side === 'buy' ? 1 : -1) * risk * Number(v))
      this.sync()
    }
    if (a === 'clear-tp') {
      p.draft.tp = null
      this.render()
    }
    if (a === 'pick') {
      const k = v as 'price' | 'sl' | 'tp'
      const price = await this.host.pickPrice(k === 'price' ? 'Klik chart untuk harga order' : `Klik chart untuk ${k.toUpperCase()}`)
      if (price === null || this.play !== p || p.revealed) return
      if (k === 'price') this.setPrice(price)
      else {
        p.draft[k] = round2(price)
        this.render()
      }
    }
    if (a === 'send') await this.submit('order', false)
    if (a === 'skip' && (await ask('Ronde ini dihitung 0R.', { title: 'Skip ronde?', ok: 'Skip' }))) await this.submit('skip', false)
  }

  private async submit(what: 'order' | 'skip', auto: boolean) {
    const p = this.play
    if (!p || p.submitting || p.revealed) return
    const d = p.draft
    if (what === 'order') {
      const err = this.error()
      if (!d.side || err) return toast(err ?? 'Pilih BUY atau SELL.', 'bad')
    }
    p.submitting = true
    this.sync()
    try {
      const res = await duelApi.decide(
        p.code,
        p.snap.round,
        what === 'skip' ? { side: 'skip' } : { side: d.side!, type: d.type, price: d.type === 'market' ? null : d.price, sl: d.sl, tp: d.tp },
      )
      clearInterval(p.timer)
      p.revealed = res
      if (auto && res.outcome.reason === 'timeout') toast('Waktu habis: ronde dihitung skip.', 'bad')
      await this.reveal(res)
    } catch (err) {
      p.submitting = false
      this.sync()
      toast((err as Error).message, 'bad')
      // a rejected decision at the buzzer becomes a skip
      if (auto) void this.submit('skip', false)
    }
  }

  /** Play the hidden candles forward, then show the result. */
  private async reveal(res: DecideResult) {
    const p = this.play!
    const o = res.outcome
    const lines: DuelLine[] = []
    const at = o.entry ?? o.price ?? null
    if (o.side !== 'skip' && at !== null)
      lines.push({ field: 'entry', price: at, title: o.entry === null ? 'Order (tidak tersentuh)' : 'Entry', color: COLOR[o.side], solid: true, drag: false })
    if (o.sl !== null) lines.push({ field: 'sl', price: o.sl, title: 'SL', color: COLOR.sl, solid: false, drag: false })
    if (o.tp !== null) lines.push({ field: 'tp', price: o.tp, title: 'TP', color: COLOR.tp, solid: false, drag: false })
    this.host.setLines(lines)
    this.render()
    // a full day is 1440 minutes: play it in about 5 s, several minutes per frame
    const total = res.future.length
    const frames = Math.min(total, 200)
    const per = Math.max(1, Math.ceil(total / Math.max(1, frames)))
    for (let i = 0; i < total; i += per) {
      if (this.play !== p) return
      for (const m of res.future.slice(i, i + per)) appendMinute(p.bars, m, res.breaks)
      this.host.update()
      await new Promise((r) => setTimeout(r, 25))
    }
    const marks: DuelMarker[] = []
    if (o.side !== 'skip' && o.entry !== null) {
      // market orders enter at the cut; a limit/stop fills later, its entry line shows where
      if ((o.type ?? 'market') === 'market')
        marks.push(
          o.side === 'buy'
            ? { time: p.snap.cut.time, text: 'B', color: COLOR.buy, position: 'belowBar', shape: 'arrowUp' }
            : { time: p.snap.cut.time, text: 'S', color: COLOR.sell, position: 'aboveBar', shape: 'arrowDown' },
        )
      if (o.exitTime !== null)
        marks.push({ time: o.exitTime, text: fmtR(o.r), color: o.r >= 0 ? '#26a69a' : '#ef5350', position: o.side === 'buy' ? 'aboveBar' : 'belowBar', shape: 'circle' })
    }
    this.host.setMarkers(marks)
  }

  quit() {
    const p = this.play
    if (!p) return
    clearInterval(p.timer)
    this.play = null
    this.panel.innerHTML = ''
    this.quick.innerHTML = ''
    this.quick.hidden = true
    this.host.exit()
  }
}

/** Add one revealed M1 candle to every timeframe, opening a new candle where the server says one starts. */
export function appendMinute(bars: Record<TF, Bar[]>, m: Bar, breaks: Partial<Record<TF, number[]>>) {
  for (const tf of Object.keys(bars) as TF[]) {
    const arr = bars[tf]
    if (tf === 'M1') {
      arr.push({ ...m })
      continue
    }
    const last = arr[arr.length - 1]
    const start = (breaks[tf] ?? []).filter((t) => t <= m.time && (!last || t > last.time)).pop()
    if (!last || start !== undefined) arr.push({ ...m, time: start ?? m.time })
    else {
      if (m.high > last.high) last.high = m.high
      if (m.low < last.low) last.low = m.low
      last.close = m.close
      last.volume += m.volume
      last.spread = m.spread
    }
  }
}
