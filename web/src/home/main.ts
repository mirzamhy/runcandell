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
for (const el of document.querySelectorAll('.sigil, .avatar, .intro-eyes')) el.innerHTML = EYES_SIGIL

// three.js is the bulk of this page: load it after the UI is up
let slot: HTMLElement | null = null
const arenaReady: Promise<Arena3D | null> = import('./arena3d')
  .then(({ Arena3D }) => {
    const a = new Arena3D($<HTMLCanvasElement>('arena3d'))
    a.follow(slot)
    a.start()
    return a
  })
  .catch(() => {
    document.body.classList.add('no-gl') // no WebGL: flat SVG mask instead
    return null
  })
let arena: Arena3D | null = null
void arenaReady.then((a) => (arena = a))

type View = 'login' | 'dash'
function show(view: View, glide = false) {
  document.body.dataset.view = view
  scrollTo(0, 0)
  slot = $(view === 'login' ? 'slot-login' : 'slot-dash')
  arena?.follow(slot, glide)
}

// ---------- intro: dark, eyes open and blink, WELCOME, the mask rises in purple fire ----------

const INTRO_KEY = 'rc.intro'
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function introSeen() {
  try {
    return sessionStorage.getItem(INTRO_KEY) === '1'
  } catch {
    return false
  }
}

async function playIntro() {
  const body = document.body
  const intro = $('intro')
  const eyes = $('intro-eyes')
  const welcome = $('intro-welcome')
  let skipped = false
  let done!: () => void
  const finished = new Promise<void>((r) => (done = r))
  const skip = () => {
    skipped = true
    done()
  }
  $('intro-skip').addEventListener('click', skip, { once: true })
  addEventListener('keydown', skip, { once: true })
  /** sleeps, but resolves early when the user skips */
  const step = (ms: number) => Promise.race([wait(ms), finished])

  body.classList.add('intro')
  intro.hidden = false
  document.body.dataset.view = 'login' // laid out (invisible) so the mask can glide to its slot later
  slot = $('intro-slot')
  void arenaReady.then((a) => {
    a?.setStill(true)
    a?.setReveal(0)
    a?.follow(slot)
  })

  await step(500)
  if (!skipped) eyes.classList.add('on') // dot, slit, open: ~2.5 s
  await step(2500)
  if (!skipped) welcome.classList.add('on') // flickers on, then glitches
  await step(2600)
  if (!skipped) {
    eyes.classList.add('out')
    welcome.classList.add('out')
    // the 3D mask comes out of the dark, still, in purple fire
    const a = await Promise.race([arenaReady, finished.then(() => null)])
    a?.setReveal(1, 2200)
  }
  await step(3000)

  // landing: lift the veil, mask glides into the hero, then starts to breathe
  try {
    sessionStorage.setItem(INTRO_KEY, '1')
  } catch {
    /* private mode */
  }
  removeEventListener('keydown', skip)
  const a = arena
  if (skipped) a?.setReveal(1, 600)
  body.classList.remove('intro')
  intro.hidden = true
  show('login', !!a)
  setTimeout(() => arena?.setStill(false), 1800)
}

function enterLanding() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced || (introSeen() && !params.has('intro'))) return show('login')
  void playIntro()
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
    arena?.setStill(false)
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
    enterLanding() // 401, or the account server is down: the landing still lets you skip to the chart
  }
}
void boot()
