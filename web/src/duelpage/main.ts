/**
 * Duel page: lobby (create, join, my duels, record) and one duel's VS screen with its rounds.
 * Rounds are played on the chart page (chart.html?play=CODE&round=N), which comes back here.
 */
import { api, duelApi, statsApi, type DuelDetail, type DuelListItem, type DuelPlayer, type DuelRoundResult, type Stats, type User } from '../api'
import { mountLogos, setFavicon } from '../shared/brand'
import { formatWall } from '../time'
import { EYES_SIGIL } from '../home/mask'
import '../shared/theme.css'
import '../shared/shell.css'
import './duel.css'

mountLogos()
setFavicon()

const app = document.getElementById('app')!
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const fmtR = (r: number | null | undefined) => (r === null || r === undefined ? '–' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`)
const tone = (n: number | null | undefined) => (!n ? '' : n > 0 ? 'pos' : 'neg')
const REASON: Record<string, string> = { tp: 'TP', sl: 'SL', time: 'Waktu habis', skip: 'Skip', timeout: 'Telat', stopout: 'Stop-out', unfilled: 'Order tak tersentuh' }
const SIDE: Record<string, string> = { buy: 'BUY', sell: 'SELL', skip: 'SKIP' }

let me: User | null = null

function toast(text: string, kind: 'good' | 'bad' = 'good') {
  const t = document.createElement('div')
  t.className = `dp-toast ${kind}`
  t.textContent = text
  document.getElementById('toasts')!.append(t)
  setTimeout(() => t.remove(), 3800)
}

const playUrl = (code: string, n: number) => `/chart.html?play=${encodeURIComponent(code)}&round=${n}`
const duelUrl = (code: string) => `/duel.html?code=${encodeURIComponent(code)}`

// ---------- lobby ----------

const CHOICES = {
  rounds: { label: 'Jumlah ronde', values: [1, 3, 5, 7, 10], def: 5, fmt: (v: number) => String(v) },
  analysisSec: { label: 'Waktu analisa per ronde', values: [30, 60, 90, 120, 180, 300], def: 90, fmt: (v: number) => (v < 60 ? `${v} dtk` : `${v / 60} mnt`) },
  runMinutes: { label: 'Harga dijalankan ke depan', values: [30, 60, 90, 120, 240], def: 120, fmt: (v: number) => (v < 60 ? `${v} mnt` : `${v / 60} jam`) },
}

function chips(name: keyof typeof CHOICES) {
  const c = CHOICES[name]
  return `<fieldset class="dp-field"><legend>${c.label}</legend><div class="dp-chips">${c.values
    .map((v) => `<label class="dp-chip"><input type="radio" name="${name}" value="${v}"${v === c.def ? ' checked' : ''} /><span>${c.fmt(v)}</span></label>`)
    .join('')}</div></fieldset>`
}

function recordHtml(s: Stats | null) {
  if (!s) return ''
  const m = s.me
  const cell = (v: string, k: string, cls = '') => `<div class="dp-stat"><b class="${cls}">${v}</b><span>${k}</span></div>`
  return `<section class="dp-record">
    ${cell(fmtR(m.totalR), 'Total R', tone(m.totalR))}
    ${cell(String(m.duels), 'Duel selesai')}
    ${cell(m.winRate === null ? '–' : `${Math.round(m.winRate * 100)}%`, 'Ronde untung')}
    ${cell(m.rank ? `#${m.rank}` : '–', 'Peringkat minggu ini')}
  </section>`
}

function listCard(d: DuelListItem) {
  const mine = d.players.find((p) => p.nickname === me?.nickname) ?? d.players[0]
  const other = d.players.find((p) => p !== mine)
  const status = d.status === 'done' ? 'Selesai' : d.nextRound ? `Ronde ${d.nextRound}/${d.rounds}` : d.mode === 'async' && d.players.length < 2 ? 'Menunggu lawan' : 'Menunggu lawan selesai'
  return `<a class="dp-card ${d.status === 'done' ? 'done' : ''}" href="${duelUrl(d.code)}">
    <span class="dp-card-vs"><b>${esc(mine?.nickname ?? '?')}</b><i>VS</i><b>${d.mode === 'solo' ? 'Latihan' : esc(other?.nickname ?? '???')}</b></span>
    <span class="dp-card-meta"><code>${d.code}</code> · ${d.rounds} ronde · ${status}</span>
    <span class="dp-card-r ${tone(mine?.totalR)}">${fmtR(mine?.totalR)}</span>
  </a>`
}

async function renderLobby() {
  const [list, stats] = await Promise.all([duelApi.list().then((r) => r.items), statsApi.get().catch(() => null)])
  const open = list.filter((d) => d.status !== 'done')
  const done = list.filter((d) => d.status === 'done')
  app.innerHTML = `
    <section class="dp-hero">
      <div class="dp-hero-text">
        <p class="dp-kicker">1 lawan 1 · harga disamarkan</p>
        <h1>Candle Duel</h1>
        <p>Chart dipotong di titik acak. Kamu dan lawan dapat potongan yang sama, analisa, lalu pilih BUY, SELL, atau skip. Skor dalam R, yang paling tinggi menang.</p>
      </div>
      <div class="dp-hero-vs" aria-hidden="true"><span class="a"></span><b>VS</b><span class="b"></span></div>
    </section>
    ${recordHtml(stats)}
    <div class="dp-grid">
      <form class="dp-panel dp-create" data-f="create">
        <h2>Duel baru</h2>
        <fieldset class="dp-field"><legend>Lawan</legend>
          <div class="dp-modes">
            <label class="dp-mode"><input type="radio" name="mode" value="async" checked /><span><b>Tantang teman</b><small>Dapat link untuk dikirim. Main kapan saja, hasil dibuka setelah dua-duanya selesai.</small></span></label>
            <label class="dp-mode"><input type="radio" name="mode" value="solo" /><span><b>Latihan sendiri</b><small>Tanpa lawan. Hasil masuk rekor, tidak masuk leaderboard lawan.</small></span></label>
          </div></fieldset>
        ${chips('rounds')}${chips('analysisSec')}${chips('runMinutes')}
        <label class="dp-toggle"><input type="checkbox" name="hardcore" /><span><b>Hardcore</b> jam juga disembunyikan</span></label>
        <button type="submit" class="dp-cta">Buat duel</button>
      </form>
      <div class="dp-col">
        <form class="dp-panel" data-f="join">
          <h2>Punya kode?</h2>
          <div class="dp-join"><input name="code" required maxlength="8" autocomplete="off" spellcheck="false" placeholder="ABCD2345" aria-label="Kode duel" /><button type="submit" class="dp-btn">Buka</button></div>
        </form>
        <section class="dp-panel">
          <h2>Aturan</h2>
          <ol class="dp-rules">
            <li><b>Potongan acak.</b> Harga dinormalisasi, tanggal disembunyikan. Semua timeframe boleh dibuka.</li>
            <li><b>Analisa dengan waktu.</b> Habis waktu = skip.</li>
            <li><b>Entry di harga potong.</b> SL wajib, TP opsional.</li>
            <li><b>Skor R.</b> Kena SL = -1R. Spread dihitung.</li>
          </ol>
        </section>
      </div>
    </div>
    <section class="dp-list">
      <h2>Duel berjalan <small>${open.length}</small></h2>
      ${open.length ? `<div class="dp-cards">${open.map(listCard).join('')}</div>` : '<p class="dp-empty">Belum ada. Buat duel di atas.</p>'}
      ${done.length ? `<h2>Selesai <small>${done.length}</small></h2><div class="dp-cards">${done.map(listCard).join('')}</div>` : ''}
    </section>`
}

// ---------- one duel: VS screen ----------

function playerStats(p: DuelPlayer | undefined, rounds: DuelRoundResult[]) {
  const mine = p ? rounds.map((r) => r.results.find((x) => x.nickname === p.nickname)).filter((x) => !!x) : []
  const traded = mine.filter((x) => x.side !== 'skip')
  return {
    played: mine.length,
    wins: mine.filter((x) => x.r > 0).length,
    best: traded.length ? Math.max(...traded.map((x) => x.r)) : null,
    total: p?.totalR ?? (mine.length ? mine.reduce((a, x) => a + x.r, 0) : null),
  }
}

function fighter(p: DuelPlayer | undefined, side: 'a' | 'b', rounds: DuelRoundResult[], total: number, placeholder: string) {
  const s = playerStats(p, rounds)
  const row = (k: string, v: string, cls = '') => `<li><span>${k}</span><b class="${cls}">${v}</b></li>`
  return `<div class="vs-fighter ${side}${p ? '' : ' empty'}">
    <div class="vs-avatar"><span>${p ? esc(p.nickname.slice(0, 1).toUpperCase()) : '?'}</span></div>
    <h3>${p ? esc(p.nickname) : placeholder}</h3>
    ${p?.nickname === me?.nickname ? '<p class="vs-you">kamu</p>' : ''}
    <ul class="vs-stats">
      ${row('Total', fmtR(s.total), tone(s.total))}
      ${row('Ronde dimainkan', `${s.played}/${total}`)}
      ${row('Ronde untung', String(s.wins))}
      ${row('Terbaik', fmtR(s.best), tone(s.best))}
    </ul>
  </div>`
}

function roundCard(r: DuelRoundResult, names: string[], done: boolean) {
  const cell = (n: string) => {
    const x = r.results.find((y) => y.nickname === n)
    if (!x) return `<li class="wait"><span>${esc(n)}</span><b>${done ? '–' : '?'}</b></li>`
    return `<li class="${tone(x.r)}"><span>${esc(n)}</span><em>${SIDE[x.side] ?? x.side} · ${REASON[x.reason] ?? x.reason}</em><b>${fmtR(x.r)}</b></li>`
  }
  return `<article class="dp-round"><header>Ronde ${r.round}${done && r.realTime ? `<small>${formatWall(r.realTime)} UTC</small>` : ''}</header><ul>${names.map(cell).join('')}</ul></article>`
}

async function renderDuel(code: string) {
  const d: DuelDetail = await duelApi.get(code)
  const total = typeof d.rounds === 'number' ? d.rounds : d.rounds.length
  const params = `${total} ronde · analisa ${d.analysisSec < 60 ? `${d.analysisSec} dtk` : `${d.analysisSec / 60} mnt`} · jalan ${d.runMinutes} mnt${d.hardcore ? ' · hardcore' : ''}`
  const back = '<a class="dp-back" href="/duel.html">← Semua duel</a>'
  const link = `${location.origin}${duelUrl(d.code)}`
  const share = d.mode === 'async' ? `<div class="dp-share"><input readonly value="${esc(link)}" aria-label="Link duel" /><button type="button" class="dp-btn" data-a="copy" data-link="${esc(link)}">Salin link</button></div>` : ''

  if (!d.member) {
    const host = d.players[0]
    app.innerHTML = `${back}
      <section class="vs-stage">
        ${fighter(host, 'a', [], total, '')}
        <div class="vs-mid"><b class="vs-word">VS</b><p>${params}</p>
          ${d.joinable ? `<button type="button" class="dp-cta" data-a="join" data-code="${d.code}">Terima tantangan</button>` : '<p class="dp-empty">Duel ini sudah penuh atau latihan pribadi.</p>'}</div>
        ${fighter(undefined, 'b', [], total, me ? esc(me.nickname) : 'Kamu')}
      </section>`
    return
  }

  const rounds = d.rounds as DuelRoundResult[]
  const done = d.status === 'done'
  const a = d.players.find((p) => p.nickname === me?.nickname) ?? d.players[0]
  const b = d.players.find((p) => p !== a)
  let banner = ''
  if (done) {
    if (d.mode === 'solo' || !b) banner = `<p class="vs-banner solo">Latihan selesai</p>`
    else {
      const ra = a.totalR ?? 0
      const rb = b.totalR ?? 0
      banner = ra === rb ? '<p class="vs-banner draw">Seri</p>' : ra > rb ? '<p class="vs-banner win">Victory</p>' : '<p class="vs-banner lose">Defeat</p>'
    }
  }
  const waiting =
    !done && !d.nextRound ? `<p class="vs-note">Kamu sudah selesai. ${d.mode === 'async' && d.players.length < 2 ? 'Kirim link ke lawan.' : 'Menunggu lawan selesai, hasilnya dibuka setelah itu.'}</p>` : ''
  const play = d.nextRound ? `<a class="dp-cta" href="${playUrl(d.code, d.nextRound)}">${d.nextRound === 1 ? 'Mulai ronde 1' : `Lanjut ronde ${d.nextRound}`}</a>` : ''
  const names = d.players.map((p) => p.nickname)
  app.innerHTML = `${back}
    <section class="vs-stage${done ? ' is-done' : ''}">
      ${fighter(a, 'a', rounds, total, '')}
      <div class="vs-mid">
        ${banner}
        <b class="vs-word">VS</b>
        <p class="vs-code"><code>${d.code}</code> · ${d.mode === 'solo' ? 'latihan' : 'tantangan'}</p>
        <p>${params}</p>
        ${play}${waiting}
      </div>
      ${fighter(b, 'b', rounds, total, d.mode === 'solo' ? 'Latihan' : 'Menunggu lawan')}
    </section>
    ${share}
    <section class="dp-list">
      <h2>Ronde</h2>
      ${rounds.length ? `<div class="dp-rounds">${rounds.map((r) => roundCard(r, names, done)).join('')}</div>` : '<p class="dp-empty">Belum ada ronde dimainkan.</p>'}
      ${done ? '' : '<p class="dp-empty">Hasil lawan baru terlihat setelah semua pemain selesai.</p>'}
    </section>`
}

// ---------- events ----------

app.addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target as HTMLFormElement
  const btn = f.querySelector<HTMLButtonElement>('button[type="submit"]')!
  const fd = new FormData(f)
  btn.disabled = true
  try {
    if (f.dataset.f === 'create') {
      btn.textContent = 'Memilih titik potong…'
      const { code } = await duelApi.create({
        mode: fd.get('mode') as 'solo' | 'async',
        rounds: Number(fd.get('rounds')),
        analysisSec: Number(fd.get('analysisSec')),
        runMinutes: Number(fd.get('runMinutes')),
        hardcore: fd.get('hardcore') === 'on',
      })
      location.href = duelUrl(code)
    } else location.href = duelUrl(String(fd.get('code')).trim().toUpperCase())
  } catch (err) {
    toast((err as Error).message, 'bad')
    btn.disabled = false
    btn.textContent = f.dataset.f === 'create' ? 'Buat duel' : 'Buka'
  }
})

app.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')
  if (!el) return
  try {
    if (el.dataset.a === 'copy')
      await navigator.clipboard.writeText(el.dataset.link!).then(
        () => toast('Link disalin. Kirim ke lawanmu.'),
        () => toast('Salin manual dari kotak link.', 'bad'),
      )
    if (el.dataset.a === 'join') {
      await duelApi.join(el.dataset.code!)
      await renderDuel(el.dataset.code!)
    }
  } catch (err) {
    toast((err as Error).message, 'bad')
  }
})

function showMe(u: User) {
  const box = document.getElementById('me')!
  box.hidden = false
  box.querySelector('.avatar')!.innerHTML = EYES_SIGIL
  document.getElementById('me-name')!.textContent = u.nickname
  void statsApi
    .get()
    .then((s) => (document.getElementById('me-rank')!.textContent = s.me?.rank ? `Peringkat #${s.me.rank}` : 'Tamu'))
    .catch(() => {})
  document.getElementById('logout')!.addEventListener('click', () => void api.logout().finally(() => (location.href = '/')))
}

async function boot() {
  const code = new URLSearchParams(location.search).get('code')
  try {
    me = (await api.me()).user
  } catch {
    // not signed in: the arena page has the sign-up, then comes back here
    sessionStorage.setItem('rc.next', location.pathname + location.search)
    app.innerHTML = `<section class="dp-gate"><h1>Candle Duel</h1><p>Buat akun tamu dulu (cukup nickname), lalu kamu langsung kembali ke sini${code ? ` untuk duel <code>${esc(code.toUpperCase())}</code>` : ''}.</p><a class="dp-cta" href="/#daftar">Buat akun</a></section>`
    return
  }
  showMe(me)
  try {
    if (code) await renderDuel(code.toUpperCase())
    else await renderLobby()
  } catch (err) {
    app.innerHTML = `<p class="dp-empty">${esc((err as Error).message)}</p><a class="dp-back" href="/duel.html">← Semua duel</a>`
  }
}
void boot()
