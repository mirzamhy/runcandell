/** Account dialog (guest login, saved replays/backtests) and the trade journal. */
import { ApiError, api, type BacktestItem, type JournalEntry, type JournalTrade, type ReplayItem, type User } from './api'
import { formatWall, makeShifter } from './time'
import { toast } from './trade'
import { ask } from './shared/ask'
import { mountGoogleButton } from './shared/google'
import { px } from './current'

type Tab = 'journal' | 'replays' | 'backtests' | 'account'
const TABS: [Tab, string][] = [
  ['journal', 'Jurnal'],
  ['replays', 'Sesi replay'],
  ['backtests', 'Backtest'],
  ['account', 'Akun'],
]
export const SETUPS = ['Breakout', 'Pullback', 'Reversal', 'Retest S/R', 'Range', 'Ikut tren', 'Berita']
export const EMOTIONS = ['Tenang', 'Yakin', 'Ragu', 'Takut', 'Serakah', 'FOMO', 'Balas dendam', 'Bosan']
const REASON: Record<string, string> = { tp: 'TP', sl: 'SL', manual: 'Manual', stopout: 'Stop-out', signal: 'Sinyal', time: 'Waktu', end: 'Akhir data' }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const usd = (n: number, sign = false) => (sign && n > 0 ? '+' : '') + money.format(n)
const cls = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')
const pct = (n: number) => `${(n * 100).toFixed(0)}%`

/** Identity of a trade inside one session, to know whether it already has a journal entry. */
export const tradeKey = (t: Pick<JournalTrade, 'openTime' | 'closeTime' | 'entry' | 'side'>) => `${t.side}|${t.openTime}|${t.closeTime}|${t.entry}`

export interface JournalStats {
  trades: number
  winRate: number
  net: number
  avgR: number
  rows: { key: string; trades: number; winRate: number; net: number; avgR: number }[]
}

/** Personal statistics over journal entries that carry a trade, grouped by `keyOf`. */
export function journalStats(items: JournalEntry[], keyOf: (e: JournalEntry) => string): JournalStats {
  const withTrade = items.filter((e) => e.trade)
  const agg = (list: JournalEntry[]) => {
    const rs = list.map((e) => e.trade!.r).filter((r): r is number => typeof r === 'number')
    return {
      trades: list.length,
      winRate: list.length ? list.filter((e) => e.trade!.pnl > 0).length / list.length : 0,
      net: Math.round(list.reduce((s, e) => s + e.trade!.pnl, 0) * 100) / 100,
      avgR: rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : NaN,
    }
  }
  const groups = new Map<string, JournalEntry[]>()
  for (const e of withTrade) {
    const k = keyOf(e) || '—'
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  return {
    ...agg(withTrade),
    rows: [...groups].map(([key, list]) => ({ key, ...agg(list) })).sort((a, b) => b.trades - a.trades),
  }
}

export interface AccountUIOptions {
  button: HTMLButtonElement
  dialog: HTMLDialogElement
  entryDialog: HTMLDialogElement
  zone: () => string
  onLoadReplay: (session: unknown) => void
  onUseBacktest: (b: BacktestItem & { curve: { t: number[]; v: number[] } }, asCompare: boolean) => void
  /** journal state changed (entries added/removed): lets the trade list update its buttons */
  onJournalChange: () => void
}

export class AccountUI {
  user: User | null = null
  private tab: Tab = 'journal'
  private journal: JournalEntry[] = []
  private journalKeys = new Set<string>()
  private filter = ''
  private recoveryShown: string | null = null
  /** a new Google user still choosing a nickname */
  private gPending: { credential: string; suggestion: string } | null = null
  private loginWaiters: ((ok: boolean) => void)[] = []
  private readonly body: HTMLElement

  constructor(private readonly o: AccountUIOptions) {
    const d = o.dialog
    d.innerHTML = `
      <header class="acct-head">
        <div class="bt-tabs" role="tablist"></div>
        <button type="button" class="bt-x" data-a="close" aria-label="Tutup">×</button>
      </header>
      <div class="acct-body"></div>`
    this.body = d.querySelector('.acct-body')!
    d.addEventListener('click', (e) => void this.onClick(e))
    d.addEventListener('submit', (e) => void this.onSubmit(e))
    d.addEventListener('change', (e) => {
      const el = e.target as HTMLSelectElement
      if (el.dataset.a !== 'filter') return
      this.filter = el.value
      this.body.innerHTML = this.journalHtml()
    })
    d.addEventListener('close', () => this.resolveLogin())
    d.addEventListener('pointerdown', (e) => {
      if (e.target === d) d.close()
    })
    o.button.addEventListener('click', () => this.open())
    this.syncButton()
  }

  /** Check the session cookie; quiet when the server is down. */
  async init() {
    try {
      this.user = (await api.me()).user
      await this.loadJournal()
    } catch {
      this.user = null
    }
    this.syncButton()
  }

  private syncButton() {
    this.o.button.textContent = this.user ? this.user.nickname : 'Masuk'
    this.o.button.title = this.user ? 'Akun, jurnal, sesi tersimpan' : 'Masuk untuk menyimpan jurnal dan sesi'
  }

  open(tab: Tab = this.user ? this.tab : 'account') {
    this.tab = this.user ? tab : 'account'
    if (!this.o.dialog.open) this.o.dialog.showModal()
    void this.render()
  }

  /** Resolves true once the user is logged in (opens the login form if needed). */
  requireLogin(): Promise<boolean> {
    if (this.user) return Promise.resolve(true)
    this.open('account')
    return new Promise((res) => this.loginWaiters.push(res))
  }

  private resolveLogin() {
    const w = this.loginWaiters
    this.loginWaiters = []
    for (const f of w) f(!!this.user)
  }

  isJournaled(t: Pick<JournalTrade, 'openTime' | 'closeTime' | 'entry' | 'side'>) {
    return this.journalKeys.has(tradeKey(t))
  }

  private async loadJournal() {
    this.journal = (await api.journal()).items
    this.journalKeys = new Set(this.journal.filter((e) => e.trade).map((e) => tradeKey(e.trade!)))
    this.o.onJournalChange()
  }

  // ---------- render ----------

  private async render() {
    const tabs = this.o.dialog.querySelector('.bt-tabs')!
    tabs.innerHTML = (this.user ? TABS : TABS.filter(([t]) => t === 'account'))
      .map(([t, l]) => `<button type="button" role="tab" data-tab="${t}" aria-selected="${t === this.tab}">${l}</button>`)
      .join('')
    this.body.innerHTML = '<p class="bt-empty">Memuat…</p>'
    try {
      if (this.tab === 'account') {
        this.body.innerHTML = this.accountHtml()
        this.mountGoogle()
      }
      else if (this.tab === 'journal') {
        await this.loadJournal()
        this.body.innerHTML = this.journalHtml()
      } else if (this.tab === 'replays') this.body.innerHTML = this.replaysHtml((await api.replays()).items)
      else this.body.innerHTML = this.backtestsHtml((await api.backtests()).items)
    } catch (e) {
      this.body.innerHTML = `<p class="bt-empty">${esc((e as Error).message)}</p>`
      if (e instanceof ApiError && e.status === 401) this.loggedOut()
    }
  }

  private fmt(t: number, time = true) {
    const shift = makeShifter(this.o.zone())
    return formatWall(shift(t), time)
  }

  /** Google buttons in the account tab; their cards go away when Google login is off. */
  private mountGoogle() {
    for (const el of this.body.querySelectorAll<HTMLElement>('[data-g]')) {
      const card = el.closest<HTMLElement>('.bt-card')!
      void mountGoogleButton(el, (c) => void this.onGoogle(c)).then((ok) => {
        if (!ok) card.remove()
      })
    }
  }

  private async onGoogle(credential: string) {
    try {
      const r = await api.google(credential)
      if ('needNickname' in r) {
        this.gPending = { credential, suggestion: r.suggestion }
        return this.render()
      }
      await this.signedIn(r.linked ? 'Akun Google tertaut.' : `Masuk sebagai ${r.user.nickname}.`)
    } catch (err) {
      toast((err as Error).message, 'bad')
    }
  }

  /** after any sign-in: fresh user (with its Google link), journal, header button */
  private async signedIn(message: string) {
    this.gPending = null
    this.user = (await api.me()).user
    await this.loadJournal()
    this.syncButton()
    toast(message, 'good')
    await this.render()
    this.resolveLogin()
  }

  private accountHtml(): string {
    if (!this.user && this.gPending)
      return `
        <div class="acct-cols">
          <form class="bt-card" data-f="gnick">
            <h4>Satu langkah lagi</h4>
            <p class="bt-hint">Pilih nickname untuk arena. Nama asli dan email Google tidak ditampilkan ke pemain lain.</p>
            <label class="bt-f"><span>Nickname</span><input name="nickname" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" autocomplete="nickname" value="${esc(this.gPending.suggestion)}" /></label>
            <button type="submit" class="primary">Buat akun</button>
            <button type="button" data-a="g-cancel">Batal</button>
          </form>
        </div>`
    if (!this.user)
      return `
        <div class="acct-cols">
          <form class="bt-card" data-f="login">
            <h4>Masuk</h4>
            <label class="bt-f"><span>Email / nickname</span><input name="login" required autocomplete="username" spellcheck="false" autocapitalize="off" /></label>
            <label class="bt-f"><span>Password</span><input name="password" type="password" required autocomplete="current-password" /></label>
            <button type="submit" class="primary">Masuk</button>
          </form>
          <form class="bt-card" data-f="register">
            <h4>Daftar</h4>
            <label class="bt-f"><span>Nickname</span><input name="nickname" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" autocomplete="nickname" placeholder="huruf, angka, _" /></label>
            <label class="bt-f"><span>Email</span><input name="email" type="email" required autocomplete="email" spellcheck="false" autocapitalize="off" /></label>
            <label class="bt-f"><span>Password</span><input name="password" type="password" required minlength="8" maxlength="200" autocomplete="new-password" placeholder="minimal 8 karakter" /></label>
            <button type="submit" class="primary">Buat akun</button>
          </form>
          <section class="bt-card">
            <h4>Masuk cepat</h4>
            <p class="bt-hint">Pakai akun Google, tanpa password.</p>
            <div class="g-btn" data-g="login"></div>
          </section>
        </div>
        <details class="acct-more">
          <summary>Akun tamu dan kode pemulihan</summary>
          <div class="acct-cols">
            <form class="bt-card" data-f="guest">
              <h4>Akun tamu</h4>
              <p class="bt-hint">Cukup nickname. Kamu dapat kode pemulihan untuk masuk dari perangkat lain; email dan password bisa ditambah nanti.</p>
              <label class="bt-f"><span>Nickname</span><input name="nickname" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" autocomplete="nickname" placeholder="huruf, angka, _" /></label>
              <button type="submit">Buat akun tamu</button>
            </form>
            <form class="bt-card" data-f="recover">
              <h4>Kode pemulihan</h4>
              <p class="bt-hint">Masukkan kode yang kamu simpan waktu membuat akun tamu.</p>
              <label class="bt-f"><span>Kode</span><input name="code" required autocomplete="off" spellcheck="false" placeholder="rc-…" /></label>
              <button type="submit">Masuk</button>
            </form>
          </div>
        </details>`
    const code = this.recoveryShown
    return `
      <div class="acct-cols">
        <section class="bt-card">
          <h4>Masuk sebagai ${esc(this.user.nickname)}</h4>
          ${
            code
              ? `<div class="acct-code"><p><b>Simpan kode pemulihan ini.</b> Ini satu-satunya cara masuk lagi dari perangkat lain, dan tidak akan ditampilkan lagi.</p>
                 <code>${esc(code)}</code><button type="button" data-a="copy">Salin</button></div>`
              : '<p class="bt-hint">Kode pemulihan lama hilang? Buat yang baru; kode lama langsung tidak berlaku.</p><button type="button" data-a="new-code">Buat kode pemulihan baru</button>'
          }
        </section>
        <section class="bt-card">
          <h4>Google</h4>
          ${
            this.user.google
              ? `<p class="bt-hint">Terhubung${this.user.google.email ? ` ke <b>${esc(this.user.google.email)}</b>` : ''}. Dari perangkat lain cukup masuk dengan Google.</p>`
              : '<p class="bt-hint">Tautkan akun Google supaya bisa masuk dari perangkat lain tanpa kode pemulihan.</p><div class="g-btn" data-g="link"></div>'
          }
        </section>
        ${
          this.user.login
            ? `<form class="bt-card" data-f="password">
                <h4>Email &amp; password</h4>
                <p class="bt-hint">Masuk pakai <b>${esc(this.user.login.email)}</b>. Ganti password: perangkat lain otomatis keluar.</p>
                <label class="bt-f"><span>Password lama</span><input name="current" type="password" required autocomplete="current-password" /></label>
                <label class="bt-f"><span>Password baru</span><input name="password" type="password" required minlength="8" maxlength="200" autocomplete="new-password" /></label>
                <button type="submit">Ganti password</button>
              </form>`
            : `<form class="bt-card" data-f="password">
                <h4>Email &amp; password</h4>
                <p class="bt-hint">Tambahkan supaya bisa masuk dari perangkat mana saja tanpa kode pemulihan.</p>
                <label class="bt-f"><span>Email</span><input name="email" type="email" required autocomplete="email" spellcheck="false" autocapitalize="off" /></label>
                <label class="bt-f"><span>Password</span><input name="password" type="password" required minlength="8" maxlength="200" autocomplete="new-password" placeholder="minimal 8 karakter" /></label>
                <button type="submit" class="primary">Simpan</button>
              </form>`
        }
        <section class="bt-card">
          <h4>Keluar</h4>
          <p class="bt-hint">${this.user.login || this.user.google ? 'Masuk lagi kapan saja pakai email atau Google.' : 'Pastikan kode pemulihan sudah disimpan sebelum keluar.'}</p>
          <button type="button" data-a="logout">Keluar</button>
        </section>
      </div>`
  }

  private journalHtml(): string {
    const items = this.filter ? this.journal.filter((e) => e.setup === this.filter) : this.journal
    if (!this.journal.length)
      return '<p class="bt-empty">Jurnal masih kosong. Saat replay, buka tab <b>Riwayat</b> di panel trading dan klik <b>Jurnal</b> di trade yang sudah selesai.</p>'
    const all = journalStats(items, (e) => e.setup)
    const byEmotion = journalStats(items, (e) => e.emotion)
    const table = (title: string, s: JournalStats) => `
      <section class="bt-card"><h4>${title}</h4><div class="bt-scroll"><table class="bt-table">
        <thead><tr><th></th><th>Trade</th><th>Win</th><th>Rata R</th><th>Net</th></tr></thead>
        <tbody>${s.rows.map((r) => `<tr><td>${esc(r.key)}</td><td>${r.trades}</td><td>${pct(r.winRate)}</td><td>${Number.isFinite(r.avgR) ? r.avgR.toFixed(2) + 'R' : '–'}</td><td class="${cls(r.net)}">${usd(r.net, true)}</td></tr>`).join('') || '<tr><td colspan="5" class="bt-muted">Belum ada trade.</td></tr>'}</tbody>
      </table></div></section>`
    const setups = [...new Set(this.journal.map((e) => e.setup).filter(Boolean))]
    const cards = items
      .map((e) => {
        const t = e.trade
        const head = t
          ? `<b class="${t.side === 'buy' ? 'pos' : 'neg'}">${t.side.toUpperCase()} ${t.lots.toFixed(2)}</b> ${px(t.entry)} → ${px(t.exit)} · ${REASON[t.reason] ?? t.reason}
             · <b class="${cls(t.pnl)}">${usd(t.pnl, true)}</b>${t.r !== null ? ` · ${t.r.toFixed(2)}R` : ''}`
          : '<b>Catatan</b>'
        const when = t ? this.fmt(t.openTime) : this.fmt(e.created_at)
        return `<article class="jr-card">
          ${e.hasShot ? `<a href="${api.shotUrl(e.id)}" target="_blank" rel="noopener" class="jr-shot"><img src="${api.shotUrl(e.id)}" alt="Screenshot chart" loading="lazy" /></a>` : ''}
          <div class="jr-main">
            <div class="jr-top"><span>${head}</span><span class="bt-muted">${when}${e.source === 'replay' ? ' · replay' : ''}</span></div>
            <div class="jr-tags">${e.setup ? `<span class="chip">${esc(e.setup)}</span>` : ''}${e.emotion ? `<span class="chip emo">${esc(e.emotion)}</span>` : ''}${e.tags.map((g) => `<span class="chip tag">#${esc(g)}</span>`).join('')}</div>
            ${e.note ? `<p class="jr-note">${esc(e.note)}</p>` : ''}
            <div class="jr-act"><button type="button" class="bt-link" data-a="edit" data-id="${e.id}">Ubah</button><button type="button" class="bt-link" data-a="del-j" data-id="${e.id}">Hapus</button></div>
          </div></article>`
      })
      .join('')
    return `
      <div class="jr-bar">
        <label>Setup <select data-a="filter"><option value="">Semua</option>${setups.map((s) => `<option${s === this.filter ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <button type="button" data-a="note">+ Catatan bebas</button>
      </div>
      <div class="bt-tiles">
        <div class="bt-tile"><span>Trade dijurnal</span><b>${all.trades}</b></div>
        <div class="bt-tile"><span>Win rate</span><b>${pct(all.winRate)}</b></div>
        <div class="bt-tile"><span>Net</span><b class="${cls(all.net)}">${usd(all.net, true)}</b></div>
        <div class="bt-tile"><span>Rata-rata R</span><b class="${cls(all.avgR)}">${Number.isFinite(all.avgR) ? all.avgR.toFixed(2) + 'R' : '–'}</b></div>
      </div>
      <div class="acct-cols">${table('Per setup', all)}${table('Per emosi', byEmotion)}</div>
      <div class="jr-list">${cards}</div>`
  }

  private replaysHtml(items: ReplayItem[]): string {
    if (!items.length) return '<p class="bt-empty">Belum ada sesi tersimpan. Saat replay, klik <b>Simpan</b> di bar replay.</p>'
    return `<table class="bt-table"><thead><tr><th>Nama</th><th>Mulai</th><th>Posisi replay</th><th>Trade</th><th>Saldo</th><th>Disimpan</th><th></th></tr></thead><tbody>
      ${items
        .map(
          (r) => `<tr><td>${esc(r.name)}</td><td>${this.fmt(r.start_time)}</td><td>${this.fmt(r.cursor_time)}</td><td>${r.trades}</td>
          <td>${usd(r.balance)}</td><td>${this.fmt(r.updated_at)}</td>
          <td><button type="button" class="bt-link" data-a="load-replay" data-id="${r.id}">Lanjutkan</button><button type="button" class="bt-link" data-a="del-replay" data-id="${r.id}">Hapus</button></td></tr>`,
        )
        .join('')}</tbody></table>`
  }

  private backtestsHtml(items: BacktestItem[]): string {
    if (!items.length) return '<p class="bt-empty">Belum ada backtest tersimpan. Di panel Backtest, tab Hasil, klik <b>Simpan ke akun</b>.</p>'
    return `<table class="bt-table"><thead><tr><th>Nama</th><th>Rentang</th><th>Trade</th><th>Win</th><th>PF</th><th>DD</th><th>Net</th><th></th></tr></thead><tbody>
      ${items
        .map((b) => {
          const m = b.metrics
          return `<tr><td>${esc(b.name)}</td><td>${this.fmt(b.from, false)} s/d ${this.fmt(b.to, false)}</td><td>${m.trades}</td><td>${pct(m.winRate)}</td>
            <td>${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}</td><td class="neg">-${(m.maxDdPct * 100).toFixed(1)}%</td><td class="${cls(m.net)}">${usd(m.net, true)}</td>
            <td><button type="button" class="bt-link" data-a="use-bt" data-id="${b.id}">Pakai strategi</button><button type="button" class="bt-link" data-a="cmp-bt" data-id="${b.id}">Jadikan A</button><button type="button" class="bt-link" data-a="del-bt" data-id="${b.id}">Hapus</button></td></tr>`
        })
        .join('')}</tbody></table>`
  }

  // ---------- events ----------

  private loggedOut() {
    this.user = null
    this.journal = []
    this.journalKeys.clear()
    this.recoveryShown = null
    this.gPending = null
    this.syncButton()
    this.o.onJournalChange()
  }

  private async onSubmit(e: Event) {
    e.preventDefault()
    const f = e.target as HTMLFormElement
    const btn = f.querySelector<HTMLButtonElement>('button[type="submit"]')!
    btn.disabled = true
    try {
      if (f.dataset.f === 'gnick' && this.gPending) {
        await api.google(this.gPending.credential, (f.elements.namedItem('nickname') as HTMLInputElement).value.trim())
        return await this.signedIn('Akun dibuat. Selamat datang di arena.')
      }
      const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value
      if (f.dataset.f === 'login' || f.dataset.f === 'register') {
        const r =
          f.dataset.f === 'login'
            ? await api.login(val('login').trim(), val('password'))
            : await api.register({ nickname: val('nickname').trim(), email: val('email').trim(), password: val('password') })
        await this.signedIn(f.dataset.f === 'login' ? `Masuk sebagai ${r.user.nickname}.` : 'Akun dibuat. Selamat datang di arena.')
        return this.o.dialog.close()
      }
      if (f.dataset.f === 'password') {
        const changing = !!this.user?.login
        await api.setPassword(changing ? { current: val('current'), password: val('password') } : { email: val('email').trim(), password: val('password') })
        this.user = (await api.me()).user
        toast(changing ? 'Password diganti. Perangkat lain sudah keluar.' : 'Email dan password tersimpan.', 'good')
        return await this.render()
      }
      if (f.dataset.f === 'guest') {
        const r = await api.guest((f.elements.namedItem('nickname') as HTMLInputElement).value)
        this.user = r.user
        this.recoveryShown = r.recoveryCode
      } else {
        this.user = (await api.recover((f.elements.namedItem('code') as HTMLInputElement).value)).user
        toast(`Masuk sebagai ${this.user.nickname}.`, 'good')
      }
      await this.loadJournal()
      this.syncButton()
      if (this.recoveryShown) await this.render()
      else this.o.dialog.close()
      this.resolveLogin()
    } catch (err) {
      toast((err as Error).message, 'bad')
    } finally {
      btn.disabled = false
    }
  }

  private async onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tab],[data-a]')
    if (!el) return
    if (el.dataset.tab) {
      this.tab = el.dataset.tab as Tab
      return this.render()
    }
    const a = el.dataset.a
    const id = Number(el.dataset.id)
    try {
      if (a === 'close') this.o.dialog.close()
      if (a === 'g-cancel') {
        this.gPending = null
        await this.render()
      }
      if (a === 'copy' && this.recoveryShown) {
        await navigator.clipboard.writeText(this.recoveryShown).then(
          () => toast('Kode disalin.', 'good'),
          () => toast('Tidak bisa menyalin otomatis. Salin manual.', 'bad'),
        )
      }
      if (a === 'new-code' && (await ask('Kode lama langsung tidak berlaku.', { title: 'Buat kode baru?', ok: 'Buat kode baru' }))) {
        this.recoveryShown = (await api.newRecovery()).recoveryCode
        await this.render()
      }
      if (a === 'logout') {
        await api.logout()
        this.loggedOut()
        await this.render()
      }
      if (a === 'note') return this.openEntry({ source: 'manual' })
      if (a === 'edit') {
        const entry = this.journal.find((x) => x.id === id)
        if (entry) this.openEntry({ source: entry.source, trade: entry.trade, edit: entry })
      }
      if (a === 'del-j' && (await ask('Entri ini hilang permanen.', { title: 'Hapus entri jurnal?', ok: 'Hapus', danger: true }))) {
        await api.deleteJournal(id)
        await this.render()
      }
      if (a === 'load-replay') {
        const r = await api.replay(id)
        this.o.dialog.close()
        this.o.onLoadReplay({ ...(r.session as object), serverId: r.id, name: r.name })
      }
      if (a === 'del-replay' && (await ask('Sesi replay ini hilang dari akun.', { title: 'Hapus sesi?', ok: 'Hapus', danger: true }))) {
        await api.deleteReplay(id)
        await this.render()
      }
      if (a === 'use-bt' || a === 'cmp-bt') {
        const b = await api.backtest(id)
        this.o.dialog.close()
        this.o.onUseBacktest(b, a === 'cmp-bt')
      }
      if (a === 'del-bt' && (await ask('Hasil backtest ini hilang dari akun.', { title: 'Hapus backtest?', ok: 'Hapus', danger: true }))) {
        await api.deleteBacktest(id)
        await this.render()
      }
    } catch (err) {
      toast((err as Error).message, 'bad')
      if (err instanceof ApiError && err.status === 401) this.loggedOut()
    }
  }

  // ---------- saving from other panels ----------

  async saveReplay(session: { serverId?: number | null; name?: string }, defaultName: string): Promise<{ id: number; name: string } | null> {
    if (!(await this.requireLogin())) return null
    const name = session.serverId ? session.name || defaultName : prompt('Nama sesi:', session.name || defaultName)?.trim()
    if (!name) return null
    const { serverId, ...rest } = session
    const r = await api.saveReplay(name, { ...rest, name }, serverId ?? undefined)
    toast(serverId ? 'Sesi diperbarui di akun.' : 'Sesi disimpan ke akun.', 'good')
    return { id: r.id, name }
  }

  async saveBacktest(b: { spec: unknown; metrics: unknown; curve: unknown; from: number; to: number }, defaultName: string) {
    if (!(await this.requireLogin())) return
    const name = prompt('Nama backtest:', defaultName)?.trim()
    if (!name) return
    await api.saveBacktest({ name: name.slice(0, 80), ...b })
    toast('Backtest disimpan ke akun.', 'good')
  }

  // ---------- journal entry form ----------

  /**
   * Add or edit a journal entry. `shot` grabs the chart as an image when the user ticks the box.
   */
  async openEntry(o: { source: JournalEntry['source']; trade?: JournalTrade | null; replayId?: number | null; edit?: JournalEntry; shot?: () => Promise<Blob | null> }) {
    if (!(await this.requireLogin())) return
    const d = this.o.entryDialog
    const e = o.edit
    const t = o.trade ?? null
    const known = [...new Set([...SETUPS, ...this.journal.map((x) => x.setup).filter(Boolean)])]
    d.innerHTML = `
      <form method="dialog" class="jr-form">
        <h3>${e ? 'Ubah jurnal' : 'Jurnal trade'}</h3>
        ${
          t
            ? `<p class="jr-trade"><b class="${t.side === 'buy' ? 'pos' : 'neg'}">${t.side.toUpperCase()} ${t.lots.toFixed(2)}</b> ${px(t.entry)} → ${px(t.exit)}
               · ${REASON[t.reason] ?? t.reason} · <b class="${cls(t.pnl)}">${usd(t.pnl, true)}</b>${t.r !== null ? ` · ${t.r.toFixed(2)}R` : ''}<br /><span class="bt-muted">${this.fmt(t.openTime)} → ${this.fmt(t.closeTime)}</span></p>`
            : ''
        }
        <label class="bt-f"><span>Setup</span><input name="setup" list="jr-setups" maxlength="40" value="${esc(e?.setup ?? '')}" placeholder="Breakout, Pullback…" /></label>
        <datalist id="jr-setups">${known.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>
        <fieldset class="jr-emo"><legend>Emosi saat entry</legend>
          ${EMOTIONS.map((m) => `<label><input type="radio" name="emotion" value="${m}"${e?.emotion === m ? ' checked' : ''} /> ${m}</label>`).join('')}
        </fieldset>
        <label class="jr-text"><span>Alasan entry & pelajaran</span><textarea name="note" rows="5" maxlength="4000" placeholder="Kenapa masuk? Apa yang benar / salah?">${esc(e?.note ?? '')}</textarea></label>
        <label class="bt-f"><span>Tag</span><input name="tags" maxlength="200" value="${esc(e?.tags.join(', ') ?? '')}" placeholder="london, news (pisah koma)" /></label>
        ${!e && o.shot ? '<label class="bt-f bt-check"><input type="checkbox" name="shot" checked /> Lampirkan screenshot chart sekarang</label>' : ''}
        <div class="jr-buttons"><button value="cancel" formnovalidate>Batal</button><button value="ok" class="primary">Simpan</button></div>
      </form>`
    const form = d.querySelector('form')!
    d.showModal()
    const result = await new Promise<string>((res) => d.addEventListener('close', () => res(d.returnValue), { once: true }))
    if (result !== 'ok') return
    const fd = new FormData(form)
    const fields = {
      setup: String(fd.get('setup') ?? '').trim(),
      emotion: String(fd.get('emotion') ?? ''),
      note: String(fd.get('note') ?? '').trim(),
      tags: String(fd.get('tags') ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^#/, ''))
        .filter(Boolean)
        .slice(0, 10),
    }
    try {
      if (e) await api.updateJournal(e.id, fields)
      else {
        const { id } = await api.addJournal({ ...fields, source: o.source, trade: t, replayId: o.replayId ?? null })
        if (fd.get('shot') && o.shot) {
          const img = await o.shot()
          if (img) await api.uploadShot(id, img).catch((err) => toast(`Screenshot gagal: ${(err as Error).message}`, 'bad'))
        }
      }
      toast('Jurnal disimpan.', 'good')
      await this.loadJournal()
      if (this.o.dialog.open) await this.render()
    } catch (err) {
      toast((err as Error).message, 'bad')
    }
  }
}
