/** Arena home: guest login, then the dashboard (duel, chart, leaderboard). */
import { ApiError, api, duelApi, statsApi, type DuelListItem, type Stats, type User } from '../api'
import type { Arena3D } from './arena3d'
import { EYES_SIGIL, maskSvg } from './mask'
import './home.css'

// old share links pointed at "/?duel=CODE": the duel lives on the chart page now
const params = new URLSearchParams(location.search)
if (params.get('duel')) location.replace(`/chart.html?duel=${encodeURIComponent(params.get('duel')!)}`)

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const fmtR = (r: number) => `${r > 0 ? '+' : ''}${r.toFixed(1)}R`
const tone = (r: number) => (r > 0 ? 'pos' : r < 0 ? 'neg' : '')

for (const el of document.querySelectorAll('.logo')) el.innerHTML = maskSvg()
for (const el of document.querySelectorAll('.mask-fallback')) el.innerHTML = maskSvg()
for (const el of document.querySelectorAll('.sigil, .avatar')) el.innerHTML = EYES_SIGIL

// three.js is the bulk of this page: load it after the UI is up
let arena: Arena3D | null = null
let slot: HTMLElement | null = null
void import('./arena3d')
  .then(({ Arena3D }) => {
    arena = new Arena3D($<HTMLCanvasElement>('arena3d'))
    arena.follow(slot)
    arena.start()
  })
  .catch(() => document.body.classList.add('no-gl')) // no WebGL: flat SVG mask instead

type View = 'login' | 'dash'
function show(view: View) {
  document.body.dataset.view = view
  scrollTo(0, 0)
  slot = $(view === 'login' ? 'slot-login' : 'slot-dash')
  arena?.follow(slot)
}

// ---------- login ----------

const guestForm = $<HTMLFormElement>('guest-form')
const recoverForm = $<HTMLFormElement>('recover-form')
const codeBox = $('code-box')
const loginErr = $('login-err')

function loginPane(p: 'guest' | 'recover' | 'code') {
  guestForm.hidden = p !== 'guest'
  recoverForm.hidden = p !== 'recover'
  codeBox.hidden = p !== 'code'
  loginErr.hidden = true
  ;(p === 'guest' ? guestForm : recoverForm).querySelector('input')?.focus()
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-to]')) b.addEventListener('click', () => loginPane(b.dataset.to as 'guest' | 'recover'))

async function submit(form: HTMLFormElement, run: () => Promise<void>) {
  const btn = form.querySelector<HTMLButtonElement>('button[type=submit]')!
  btn.disabled = true
  loginErr.hidden = true
  try {
    await run()
  } catch (e) {
    loginErr.textContent = e instanceof ApiError ? e.message : 'Gagal. Coba lagi.'
    loginErr.hidden = false
  } finally {
    btn.disabled = false
  }
}

let pending: User | null = null
guestForm.addEventListener('submit', (e) => {
  e.preventDefault()
  void submit(guestForm, async () => {
    const r = await api.guest((guestForm.elements.namedItem('nickname') as HTMLInputElement).value.trim())
    pending = r.user
    $('code-value').textContent = r.recoveryCode
    loginPane('code')
  })
})
recoverForm.addEventListener('submit', (e) => {
  e.preventDefault()
  void submit(recoverForm, async () => {
    const r = await api.recover((recoverForm.elements.namedItem('code') as HTMLInputElement).value.trim())
    void enter(r.user)
  })
})
$('code-copy').addEventListener('click', () => {
  void navigator.clipboard.writeText($('code-value').textContent ?? '').then(
    () => ($('code-copy').textContent = 'Tersalin'),
    () => ($('code-copy').textContent = 'Salin manual (blok teksnya)'),
  )
})
$('code-done').addEventListener('click', () => {
  if (pending) void enter(pending)
})

// ---------- dashboard ----------

$('logout').addEventListener('click', () => {
  void api.logout().finally(() => {
    guestForm.reset()
    recoverForm.reset()
    loginPane('guest')
    show('login')
  })
})

const joinForm = $<HTMLFormElement>('join-form')
joinForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const code = (joinForm.elements.namedItem('code') as HTMLInputElement).value.trim().toUpperCase()
  if (code) location.href = `/chart.html?duel=${encodeURIComponent(code)}`
})

function renderStats(s: Stats | null) {
  const m = s?.me
  const cell = (v: string, label: string, cls = '') => `<div class="stat"><b class="${cls}">${v}</b><span>${label}</span></div>`
  $('stats').innerHTML = m
    ? cell(fmtR(m.totalR), 'Total R semua duel', tone(m.totalR)) +
      cell(m.winRate === null ? '–' : `${Math.round(m.winRate * 100)}%`, `Win rate (${m.trades} trade)`) +
      cell(String(m.duels), 'Duel selesai') +
      cell(m.rank ? `#${m.rank}` : '–', 'Peringkat 7 hari')
    : '<p class="empty">Statistik belum bisa dimuat.</p>'
  $('me-rank').textContent = m?.rank ? `Peringkat #${m.rank}` : 'Tamu'
  const board = s?.board ?? []
  $('lb').innerHTML = board.length
    ? board
        .map(
          (x) =>
            `<li class="${x.me ? 'me' : ''}"><span>${x.rank}</span><span>${esc(x.nickname)}</span><span class="n">${x.duels} duel</span><span class="r ${tone(x.totalR)}">${fmtR(x.totalR)}</span></li>`,
        )
        .join('') +
      (m?.rank && m.rank > 10 && m.weekR !== null
        ? `<li class="me"><span>${m.rank}</span><span>${esc($('me-name').textContent ?? '')}</span><span class="n"></span><span class="r ${tone(m.weekR)}">${fmtR(m.weekR)}</span></li>`
        : '')
    : '<li class="empty">Belum ada duel selesai minggu ini. Jadi yang pertama.</li>'
}

function renderActive(items: DuelListItem[]) {
  const open = items.filter((d) => d.nextRound !== null).slice(0, 5)
  $('active').hidden = !open.length
  $('active-list').innerHTML = open
    .map((d) => {
      const vs = d.mode === 'solo' ? 'Solo' : d.players.length < 2 ? 'Menunggu lawan' : `vs ${esc(d.players.map((p) => p.nickname).join(' / '))}`
      return `<li><a href="/chart.html?duel=${d.code}"><span><b>${d.code}</b> · ${vs}</span><span class="meta">Ronde ${d.nextRound}/${d.rounds} · lanjut</span></a></li>`
    })
    .join('')
}

async function enter(user: User) {
  $('me-name').textContent = user.nickname
  $('greet').textContent = `Selamat datang, ${user.nickname}`
  show('dash')
  const [stats, list] = await Promise.allSettled([statsApi.get(), duelApi.list()])
  renderStats(stats.status === 'fulfilled' ? stats.value : null)
  renderActive(list.status === 'fulfilled' ? list.value.items : [])
}

async function boot() {
  try {
    await enter((await api.me()).user)
  } catch {
    show('login') // 401, or the account server is down: login still lets you skip to the chart
  }
}
void boot()
