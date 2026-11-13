/** Duel client: lobby dialog, the decision bar with the analysis timer, and the reveal. */
import { ApiError, duelApi, type DecideResult, type DuelDetail, type DuelListItem, type DuelRoundResult, type Snapshot } from './api'
import { formatWall } from './time'
import { toast } from './trade'
import type { Bar, TF } from './types'

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
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
  private view: { kind: 'home' } | { kind: 'detail'; code: string } = { kind: 'home' }
  private readonly body: HTMLElement

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly bar: HTMLElement,
    private readonly host: DuelHost,
  ) {
    dialog.innerHTML = `
      <header class="acct-head"><b>Duel</b><button type="button" class="bt-x" data-d="close" aria-label="Tutup">×</button></header>
      <div class="acct-body"></div>`
    this.body = dialog.querySelector('.acct-body')!
    dialog.addEventListener('click', (e) => void this.onDialogClick(e))
    dialog.addEventListener('submit', (e) => void this.onSubmit(e))
    dialog.addEventListener('pointerdown', (e) => {
      if (e.target === dialog) dialog.close()
    })
    bar.addEventListener('click', (e) => void this.onBarClick(e))
    bar.addEventListener('input', () => this.syncRisk())
  }

  get active() {
    return !!this.play
  }

  async open(code?: string) {
    if (!(await this.host.requireLogin())) return
    this.view = code ? { kind: 'detail', code: code.toUpperCase() } : { kind: 'home' }
    if (!this.dialog.open) this.dialog.showModal()
    await this.render()
  }

  // ---------- lobby ----------

  private async render() {
    this.body.innerHTML = '<p class="bt-empty">Memuat…</p>'
    try {
      if (this.view.kind === 'home') this.body.innerHTML = this.homeHtml((await duelApi.list()).items)
      else this.body.innerHTML = this.detailHtml(await duelApi.get(this.view.code))
    } catch (e) {
      this.body.innerHTML = `<p class="bt-empty">${esc((e as Error).message)}</p>`
    }
  }

  private homeHtml(items: DuelListItem[]): string {
    const sel = (name: string, values: number[], def: number, fmt: (v: number) => string) =>
      `<select name="${name}">${values.map((v) => `<option value="${v}"${v === def ? ' selected' : ''}>${fmt(v)}</option>`).join('')}</select>`
    const rows = items
      .map((d) => {
        const me = d.players[0]
        const status = d.status === 'done' ? 'Selesai' : d.nextRound ? `Ronde ${d.nextRound}/${d.rounds}` : 'Menunggu lawan'
        return `<tr><td><code>${d.code}</code></td><td>${d.mode === 'solo' ? 'Latihan' : 'Lawan'}</td><td>${d.players.map((p) => esc(p.nickname)).join(' vs ')}</td>
          <td>${status}</td><td class="${cls(me?.totalR)}">${fmtR(me?.totalR)}</td>
          <td><button type="button" class="bt-link" data-d="detail" data-code="${d.code}">Buka</button></td></tr>`
      })
      .join('')
    return `
      <div class="acct-cols">
        <form class="bt-card" data-f="create">
          <h4>Duel baru</h4>
          <div class="bt-f"><span>Lawan</span><div class="bt-seg">
            <label class="seg-opt"><input type="radio" name="mode" value="async" checked /> Kirim link ke teman</label>
            <label class="seg-opt"><input type="radio" name="mode" value="solo" /> Latihan sendiri</label></div></div>
          <label class="bt-f"><span>Ronde</span>${sel('rounds', [1, 3, 5, 7, 10], 5, (v) => `${v} ronde`)}</label>
          <label class="bt-f"><span>Waktu analisa</span>${sel('analysisSec', [30, 60, 90, 120, 180, 300], 90, (v) => (v < 60 ? `${v} detik` : `${v / 60} menit`))}</label>
          <label class="bt-f"><span>Jendela run</span>${sel('runMinutes', [30, 60, 90, 120, 240], 120, (v) => `${v} menit ke depan`)}</label>
          <label class="bt-f bt-check"><input type="checkbox" name="hardcore" /> Hardcore: jam juga disembunyikan</label>
          <button type="submit" class="primary">Buat duel</button>
        </form>
        <form class="bt-card" data-f="join">
          <h4>Gabung duel</h4>
          <p class="bt-hint">Masukkan kode dari temanmu.</p>
          <label class="bt-f"><span>Kode</span><input name="code" required maxlength="8" autocomplete="off" spellcheck="false" placeholder="ABCD2345" style="text-transform:uppercase" /></label>
          <button type="submit">Buka</button>
        </form>
        <section class="bt-card">
          <h4>Aturan</h4>
          <ul class="bt-notes">
            <li>Chart dipotong di titik acak. Harga dinormalisasi dan tanggal disembunyikan.</li>
            <li>Semua timeframe boleh dipakai. Analisa sebelum waktu habis.</li>
            <li>Buy atau sell di harga potong dengan SL wajib (TP opsional), atau skip.</li>
            <li>Skor dalam R: kena SL = -1R. Spread dihitung. Waktu habis = skip.</li>
          </ul>
        </section>
      </div>
      <h4>Duel saya</h4>
      ${rows ? `<table class="bt-table"><thead><tr><th>Kode</th><th>Jenis</th><th>Pemain</th><th>Status</th><th>Total kamu</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="bt-muted">Belum ada duel.</p>'}`
  }

  private detailHtml(d: DuelDetail): string {
    const link = `${location.origin}${location.pathname}?duel=${d.code}`
    const params = `${typeof d.rounds === 'number' ? d.rounds : d.rounds.length} ronde · analisa ${d.analysisSec} detik · run ${d.runMinutes} menit${d.hardcore ? ' · hardcore' : ''}`
    const back = '<button type="button" class="bt-link" data-d="home">← Semua duel</button>'
    if (!d.member) {
      return `${back}<section class="bt-card"><h4>Duel ${d.code}</h4><p>Dibuat oleh ${esc(d.players[0]?.nickname ?? '?')} · ${params}</p>
        ${d.joinable ? `<button type="button" class="primary" data-d="join" data-code="${d.code}">Gabung dan main</button>` : '<p class="bt-muted">Duel ini sudah penuh atau latihan pribadi.</p>'}</section>`
    }
    const rounds = d.rounds as DuelRoundResult[]
    const names = d.players.map((p) => p.nickname)
    const done = d.status === 'done'
    const table = `<table class="bt-table"><thead><tr><th>Ronde</th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}${done ? '<th>Tanggal asli</th>' : ''}</tr></thead><tbody>
      ${rounds
        .map(
          (r) => `<tr><td>${r.round}</td>${names
            .map((n) => {
              const x = r.results.find((y) => y.nickname === n)
              return `<td class="${cls(x?.r)}">${x ? `${SIDE[x.side] ?? x.side} · ${REASON[x.reason] ?? x.reason} · ${fmtR(x.r)}` : done ? '–' : '<span class="bt-muted">?</span>'}</td>`
            })
            .join('')}${done ? `<td>${r.realTime ? formatWall(r.realTime) + ' UTC' : ''}</td>` : ''}</tr>`,
        )
        .join('')}
      <tr class="total"><td>Total</td>${d.players.map((p) => `<td class="${cls(p.totalR)}"><b>${p.totalR === null || p.totalR === undefined ? (p.finished ? 'selesai' : '…') : fmtR(p.totalR)}</b></td>`).join('')}${done ? '<td></td>' : ''}</tr>
      </tbody></table>`
    let winner = ''
    if (done && d.players.length === 2) {
      const [a, b] = d.players
      winner = (a.totalR ?? 0) === (b.totalR ?? 0) ? '<p class="duel-win">Seri.</p>' : `<p class="duel-win">Pemenang: <b>${esc((a.totalR ?? 0) > (b.totalR ?? 0) ? a.nickname : b.nickname)}</b></p>`
    }
    const waiting = !done && !d.nextRound ? `<p class="bt-hint">Kamu sudah selesai. ${d.mode === 'async' && d.players.length < 2 ? 'Kirim link ini ke lawan:' : 'Menunggu lawan selesai.'}</p>` : ''
    return `${back}
      <section class="bt-card">
        <h4>Duel ${d.code} <span class="bt-muted">${d.mode === 'solo' ? 'latihan' : 'lawan'}</span></h4>
        <p class="bt-hint">${params}</p>
        ${d.mode === 'async' ? `<div class="duel-link"><input readonly value="${esc(link)}" aria-label="Link duel" /><button type="button" data-d="copy" data-link="${esc(link)}">Salin link</button></div>` : ''}
        ${waiting}${winner}
        ${d.nextRound ? `<button type="button" class="primary" data-d="play" data-code="${d.code}" data-n="${d.nextRound}">${d.nextRound === 1 ? 'Mulai ronde 1' : `Lanjut ronde ${d.nextRound}`}</button>` : ''}
        ${done ? '' : '<p class="bt-hint">Hasil lawan baru terlihat setelah semua pemain selesai.</p>'}
      </section>
      ${table}`
  }

  private async onSubmit(e: Event) {
    e.preventDefault()
    const f = e.target as HTMLFormElement
    const btn = f.querySelector<HTMLButtonElement>('button[type="submit"]')!
    btn.disabled = true
    try {
      const fd = new FormData(f)
      if (f.dataset.f === 'create') {
        btn.textContent = 'Memilih titik potong…'
        const { code } = await duelApi.create({
          mode: fd.get('mode') as 'solo' | 'async',
          rounds: Number(fd.get('rounds')),
          analysisSec: Number(fd.get('analysisSec')),
          runMinutes: Number(fd.get('runMinutes')),
          hardcore: fd.get('hardcore') === 'on',
        })
        this.view = { kind: 'detail', code }
      } else this.view = { kind: 'detail', code: String(fd.get('code')).trim().toUpperCase() }
      await this.render()
    } catch (err) {
      toast((err as Error).message, 'bad')
      btn.disabled = false
      btn.textContent = f.dataset.f === 'create' ? 'Buat duel' : 'Buka'
    }
  }

  private async onDialogClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-d]')
    if (!el) return
    const a = el.dataset.d
    try {
      if (a === 'close') this.dialog.close()
      if (a === 'home') {
        this.view = { kind: 'home' }
        await this.render()
      }
      if (a === 'detail') {
        this.view = { kind: 'detail', code: el.dataset.code! }
        await this.render()
      }
      if (a === 'copy')
        await navigator.clipboard.writeText(el.dataset.link!).then(
          () => toast('Link disalin. Kirim ke lawanmu.', 'good'),
          () => toast('Salin manual dari kotak link.', 'bad'),
        )
      if (a === 'join') {
        await duelApi.join(el.dataset.code!)
        await this.render()
      }
      if (a === 'play') {
        this.dialog.close()
        await this.startRound(el.dataset.code!, Number(el.dataset.n))
      }
    } catch (err) {
      toast((err as Error).message, 'bad')
    }
  }

  // ---------- a round ----------

  async startRound(code: string, n: number) {
    let snap: Snapshot
    try {
      snap = await duelApi.start(code, n)
    } catch (err) {
      toast((err as Error).message, 'bad')
      if (err instanceof ApiError && err.status === 409) void this.open(code)
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
        <button type="button" data-b="quit">Keluar</button>`
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
    if (a === 'skip' && confirm('Skip ronde ini (0R)?')) await this.submit('skip', false)
    if (a === 'next') await this.startRound(p.code, p.snap.round + 1)
    if (a === 'summary' || a === 'quit') {
      const code = p.code
      this.quit()
      if (a === 'summary') void this.open(code)
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
