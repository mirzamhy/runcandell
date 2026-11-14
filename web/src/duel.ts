/** Playing a duel round on the chart: the decision bar with the analysis timer, and the reveal. The lobby is duel.html. */
import { duelApi, type DecideResult, type Snapshot } from './api'
import { toast } from './trade'
import type { Bar, TF } from './types'
import { ask } from './shared/ask'

const fmtR = (r: number | null | undefined) => (r === null || r === undefined ? '–' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`)
const cls = (n: number | null | undefined) => (!n ? '' : n > 0 ? 'pos' : 'neg')
const REASON: Record<string, string> = { tp: 'TP', sl: 'SL', time: 'Waktu habis', skip: 'Skip', timeout: 'Telat (skip)', stopout: 'Stop-out' }
const SIDE: Record<string, string> = { buy: 'BUY', sell: 'SELL', skip: 'SKIP' }

export interface DuelMarker {
  time: number
  text: string
  color: string
  position: 'aboveBar' | 'belowBar'
  shape: 'arrowUp' | 'arrowDown' | 'circle'
}

export interface DuelHost {
  requireLogin(): Promise<boolean>
  /** switch the chart to these (normalised) bars */
  enter(bars: Record<TF, Bar[]>, hardcore: boolean): void
  /** bars were extended in place (reveal) */
  update(): void
  exit(): void
  setLines(l: { entry: number | null; sl: number | null; tp: number | null }): void
  setMarkers(m: DuelMarker[]): void
  /** resolve with the price of the next click on the chart (null if cancelled) */
  pickPrice(label: string): Promise<number | null>
}

interface Play {
  code: string
  snap: Snapshot
  bars: Record<TF, Bar[]>
  side: 'buy' | 'sell' | null
  deadline: number
  timer: number
  submitting: boolean
  revealed: DecideResult | null
}

export class DuelUI {
  play: Play | null = null

  constructor(
    private readonly bar: HTMLElement,
    private readonly host: DuelHost,
  ) {
    bar.addEventListener('click', (e) => void this.onBarClick(e))
    bar.addEventListener('input', () => this.syncRisk())
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
    this.play = { code, snap, bars, side: null, deadline: performance.now() + snap.remaining * 1000, timer: 0, submitting: false, revealed: null }
    this.host.enter(bars, snap.hardcore)
    this.host.setLines({ entry: null, sl: null, tp: null })
    this.host.setMarkers([])
    this.renderBar()
    this.play.timer = window.setInterval(() => this.tick(), 250)
    this.tick()
  }

  private renderBar() {
    const p = this.play
    if (!p) return
    const s = p.snap
    if (p.revealed) {
      const o = p.revealed.outcome
      const last = s.round === s.rounds
      this.bar.innerHTML = `
        <span class="duel-round">Ronde ${s.round}/${s.rounds}</span>
        <span class="duel-result ${cls(o.r)}"><b>${fmtR(o.r)}</b> · ${SIDE[o.side]} · ${REASON[o.reason] ?? o.reason}</span>
        ${p.revealed.totalR !== null ? `<span class="bt-muted">Total ${fmtR(p.revealed.totalR)}</span>` : ''}
        <span class="spacer"></span>
        <button type="button" class="primary" data-b="${last ? 'summary' : 'next'}">${last ? 'Lihat hasil duel' : `Ronde ${s.round + 1} →`}</button>
        <button type="button" data-b="quit">Ke halaman duel</button>`
      return
    }
    const entryHint = `Bid ${s.cut.close.toFixed(2)} · Ask ${(s.cut.close + s.cut.spread).toFixed(2)}`
    this.bar.innerHTML = `
      <span class="duel-round">Ronde ${s.round}/${s.rounds}</span>
      <span class="duel-timer" data-b="timer">--</span>
      <button type="button" class="duel-side buy" data-b="buy" aria-pressed="${p.side === 'buy'}">BUY</button>
      <button type="button" class="duel-side sell" data-b="sell" aria-pressed="${p.side === 'sell'}">SELL</button>
      <label class="duel-in">SL <input type="number" step="0.01" data-b="sl" ${p.side ? '' : 'disabled'} /></label>
      <button type="button" class="duel-pick" data-b="pick-sl" title="Klik chart untuk SL" ${p.side ? '' : 'disabled'}>⌖</button>
      <label class="duel-in">TP <input type="number" step="0.01" data-b="tp" placeholder="opsional" ${p.side ? '' : 'disabled'} /></label>
      <button type="button" class="duel-pick" data-b="pick-tp" title="Klik chart untuk TP" ${p.side ? '' : 'disabled'}>⌖</button>
      <span class="duel-risk bt-muted" data-b="risk">${entryHint} · SL min ${s.minStop.toFixed(2)}</span>
      <span class="spacer"></span>
      <button type="button" class="primary" data-b="send" ${p.side ? '' : 'disabled'}>Kirim</button>
      <button type="button" data-b="skip">Skip</button>`
  }

  private inputs() {
    const sl = this.bar.querySelector<HTMLInputElement>('[data-b="sl"]')
    const tp = this.bar.querySelector<HTMLInputElement>('[data-b="tp"]')
    const num = (el: HTMLInputElement | null) => (el && el.value.trim() !== '' && Number.isFinite(+el.value) ? +el.value : null)
    return { sl: num(sl), tp: num(tp), slEl: sl, tpEl: tp }
  }

  private entry(): number | null {
    const p = this.play
    if (!p?.side) return null
    return p.side === 'buy' ? p.snap.cut.close + p.snap.cut.spread : p.snap.cut.close
  }

  private syncRisk() {
    const p = this.play
    if (!p || p.revealed) return
    const { sl, tp } = this.inputs()
    const e = this.entry()
    this.host.setLines({ entry: e, sl, tp })
    const out = this.bar.querySelector('[data-b="risk"]')
    if (!out || e === null) return
    const parts = [`Entry ${e.toFixed(2)}`]
    if (sl !== null) {
      const d = Math.abs(e - sl)
      parts.push(`1R = ${d.toFixed(2)}${d < p.snap.minStop ? ` (min ${p.snap.minStop.toFixed(2)})` : ''}`)
      if (tp !== null && d > 0) parts.push(`TP = ${(Math.abs(tp - e) / d).toFixed(2)}R`)
    } else parts.push(`SL min ${p.snap.minStop.toFixed(2)}`)
    out.textContent = parts.join(' · ')
  }

  private tick() {
    const p = this.play
    if (!p || p.revealed) return
    const left = Math.max(0, (p.deadline - performance.now()) / 1000)
    const el = this.bar.querySelector<HTMLElement>('[data-b="timer"]')
    if (el) {
      el.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`
      el.classList.toggle('low', left < 10)
    }
    if (left <= 0 && !p.submitting) {
      // time is up: send what is filled in (the server still allows a few seconds), else skip
      const { sl } = this.inputs()
      void this.submit(p.side && sl !== null ? p.side : 'skip', true)
    }
  }

  private async onBarClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-b]')
    const p = this.play
    if (!el || !p) return
    const a = el.dataset.b
    if (a === 'buy' || a === 'sell') {
      const keep = this.inputs()
      const flip = p.side && p.side !== a
      p.side = a
      this.renderBar()
      const { slEl, tpEl } = this.inputs()
      const e0 = this.entry()!
      const dir = a === 'buy' ? 1 : -1
      // sensible starting stop: 1.5 × the minimum distance
      slEl!.value = !flip && keep.sl !== null ? String(keep.sl) : (e0 - dir * p.snap.minStop * 1.5).toFixed(2)
      if (!flip && keep.tp !== null) tpEl!.value = String(keep.tp)
      this.syncRisk()
      this.tick()
    }
    if (a === 'pick-sl' || a === 'pick-tp') {
      const price = await this.host.pickPrice(a === 'pick-sl' ? 'Klik chart untuk SL' : 'Klik chart untuk TP')
      const { slEl, tpEl } = this.inputs()
      const target = a === 'pick-sl' ? slEl : tpEl
      if (price !== null && target) {
        target.value = price.toFixed(2)
        this.syncRisk()
      }
    }
    if (a === 'send' && p.side) await this.submit(p.side, false)
    if (a === 'skip' && (await ask('Ronde ini dihitung 0R.', { title: 'Skip ronde?', ok: 'Skip' }))) await this.submit('skip', false)
    if (a === 'next') await this.startRound(p.code, p.snap.round + 1)
    if (a === 'summary' || a === 'quit') {
      const code = p.code
      this.quit()
      this.open(code)
    }
  }

  private async submit(side: 'buy' | 'sell' | 'skip', auto: boolean) {
    const p = this.play
    if (!p || p.submitting) return
    const { sl, tp } = this.inputs()
    if (side !== 'skip' && sl === null) return toast('SL wajib diisi.', 'bad')
    p.submitting = true
    try {
      const res = await duelApi.decide(p.code, p.snap.round, side === 'skip' ? { side } : { side, sl, tp })
      clearInterval(p.timer)
      p.revealed = res
      if (auto && res.outcome.reason === 'timeout') toast('Waktu habis: ronde dihitung skip.', 'bad')
      await this.reveal(res)
    } catch (err) {
      p.submitting = false
      toast((err as Error).message, 'bad')
      // a rejected decision at the buzzer becomes a skip
      if (auto) void this.submit('skip', false)
    }
  }

  /** Play the hidden candles forward, then show the result. */
  private async reveal(res: DecideResult) {
    const p = this.play!
    const o = res.outcome
    this.host.setLines({ entry: o.entry, sl: o.sl, tp: o.tp })
    this.renderBar()
    const total = res.future.length
    const stepMs = Math.max(15, Math.min(70, 4000 / Math.max(1, total)))
    for (const m of res.future) {
      if (this.play !== p) return
      appendMinute(p.bars, m, res.breaks)
      this.host.update()
      await new Promise((r) => setTimeout(r, stepMs))
    }
    const marks: DuelMarker[] = []
    if (o.side !== 'skip') {
      marks.push(
        o.side === 'buy'
          ? { time: p.snap.cut.time, text: 'B', color: '#4c8dff', position: 'belowBar', shape: 'arrowUp' }
          : { time: p.snap.cut.time, text: 'S', color: '#ef5350', position: 'aboveBar', shape: 'arrowDown' },
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
    this.bar.innerHTML = ''
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
