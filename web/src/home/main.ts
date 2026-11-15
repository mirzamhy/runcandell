/** Arena home: guest login, then the dashboard (duel, chart, leaderboard). */
import { ApiError, api, duelApi, statsApi, type DuelListItem, type Stats, type User } from '../api'
import type { Arena3D } from './arena3d'
import { mountLogos } from '../shared/brand'
import { mountGoogleButton } from '../shared/google'
import { EYES_SIGIL, maskEyesSvg, maskSvg } from './mask'
import '../shared/theme.css'
import '../shared/shell.css'
import './home.css'

// old share links pointed at "/?duel=CODE": duels have their own page now
const params = new URLSearchParams(location.search)
if (params.get('duel')) location.replace(`/duel.html?code=${encodeURIComponent(params.get('duel')!)}`)

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const fmtR = (r: number) => `${r > 0 ? '+' : ''}${r.toFixed(1)}R`
const tone = (r: number) => (r > 0 ? 'pos' : r < 0 ? 'neg' : '')

mountLogos()
for (const el of document.querySelectorAll('.mask-fallback')) el.innerHTML = maskSvg()
for (const el of document.querySelectorAll('.avatar')) el.innerHTML = EYES_SIGIL
$('intro-eyes').innerHTML = maskEyesSvg()

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
  const arenaTitle = $('intro-arena')
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
  await step(900)
  if (!skipped) arenaTitle.classList.add('on') // ... TO ARENA
  await step(2300)
  if (!skipped) {
    welcome.classList.add('out')
    arenaTitle.classList.add('out')
    // the 3D mask comes out of the dark around the eyes, still, in purple fire
    const a = await Promise.race([arenaReady, finished.then(() => null)])
    a?.setReveal(1, 2200)
    await step(400)
    eyes.classList.add('heat') // blue glow turns into the mask's red eye glow
    await step(700) // the 3D eyes are lit by now: hand over
    eyes.classList.add('out')
    await step(1900)
  } else await step(0)

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

type Pane = 'login' | 'register' | 'guest' | 'recover' | 'gnick' | 'code'
const form = (id: string) => $<HTMLFormElement>(id)
const panes: Record<Pane, HTMLElement> = {
  login: form('login-form'),
  register: form('register-form'),
  guest: form('guest-form'),
  recover: form('recover-form'),
  gnick: form('gnick-form'),
  code: $('code-box'),
}
const loginErr = $('login-err')
const gLogin = $('g-login')
const tabs = $('auth-tabs')
let googleOn = false
const HAS_ACCOUNT = 'rc.v1.hasAccount'
const field = (f: HTMLFormElement, name: string) => (f.elements.namedItem(name) as HTMLInputElement).value.trim()

function loginPane(p: Pane, focus = true) {
  for (const [k, el] of Object.entries(panes)) el.hidden = k !== p
  // tabs + Google only on the two main panes
  const main = p === 'login' || p === 'register'
  tabs.hidden = !main
  for (const t of tabs.querySelectorAll<HTMLButtonElement>('[data-to]')) t.setAttribute('aria-selected', String(t.dataset.to === p))
  gLogin.hidden = !googleOn || !main
  loginErr.hidden = true
  if (focus) panes[p].querySelector('input')?.focus()
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#join [data-to]')) b.addEventListener('click', () => loginPane(b.dataset.to as Pane))
for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-pane]')) a.addEventListener('click', () => loginPane(a.dataset.pane as Pane, false))

// returning visitors see "Masuk" first, new ones "Daftar"
const knownDevice = () => {
  try {
    return localStorage.getItem(HAS_ACCOUNT) === '1'
  } catch {
    return false
  }
}
const firstPane = (): Pane => (knownDevice() ? 'login' : 'register')
loginPane(firstPane(), false)

// show / hide password
for (const eye of document.querySelectorAll<HTMLButtonElement>('#join .eye')) {
  eye.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>'
  eye.addEventListener('click', () => {
    const input = eye.parentElement!.querySelector('input')!
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    eye.setAttribute('aria-pressed', String(show))
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password')
    input.focus()
  })
}

const showErr = (e: unknown) => {
  loginErr.textContent = e instanceof ApiError ? e.message : 'Something went wrong. Try again.'
  loginErr.hidden = false
}

async function submit(f: HTMLFormElement, run: () => Promise<void>) {
  const btn = f.querySelector<HTMLButtonElement>('button[type=submit]')!
  btn.disabled = true
  loginErr.hidden = true
  try {
    await run()
  } catch (e) {
    showErr(e)
  } finally {
    btn.disabled = false
  }
}
const on = (p: Pane, run: (f: HTMLFormElement) => Promise<void>) => {
  const f = panes[p] as HTMLFormElement
  f.addEventListener('submit', (e) => {
    e.preventDefault()
    void submit(f, () => run(f))
  })
}

on('login', async (f) => {
  const r = await api.login(field(f, 'login'), (f.elements.namedItem('password') as HTMLInputElement).value)
  void enter(r.user)
})
on('register', async (f) => {
  const r = await api.register({ nickname: field(f, 'nickname'), email: field(f, 'email'), password: (f.elements.namedItem('password') as HTMLInputElement).value })
  void enter(r.user)
})
on('recover', async (f) => void enter((await api.recover(field(f, 'code'))).user))

// guest: signed in at once, but first the recovery code (or link Google instead)
let pending: User | null = null
on('guest', async (f) => {
  const r = await api.guest(field(f, 'nickname'))
  pending = r.user
  $('code-value').textContent = r.recoveryCode
  loginPane('code')
  const box = $('g-link-box')
  box.hidden = false // laid out before Google measures the button
  void mountGoogleButton($('g-link'), (credential) => {
    void api.google(credential).then(() => {
      box.innerHTML = '<p class="ok">Google linked. The code above still works as a backup.</p>'
    }, showErr)
  }).then((ok) => (box.hidden = !ok))
})
$('code-copy').addEventListener('click', () => {
  void navigator.clipboard.writeText($('code-value').textContent ?? '').then(
    () => ($('code-copy').textContent = 'Copied'),
    () => ($('code-copy').textContent = 'Copy it by hand (select the text)'),
  )
})
$('code-done').addEventListener('click', () => {
  if (pending) void enter(pending)
})

// Google: known account -> straight in; new account -> pick a nickname first
let gCredential = ''
async function onGoogle(credential: string) {
  loginErr.hidden = true
  try {
    const r = await api.google(credential)
    if ('needNickname' in r) {
      gCredential = credential
      ;(panes.gnick.querySelector('input') as HTMLInputElement).value = r.suggestion
      loginPane('gnick')
    } else void enter(r.user)
  } catch (e) {
    showErr(e)
  }
}
on('gnick', async (f) => {
  const r = await api.google(gCredential, field(f, 'nickname'))
  if ('user' in r) void enter(r.user)
})
// the button needs a laid-out box to size itself: show the slot, hide it again if Google is off
gLogin.hidden = false
void mountGoogleButton($('g-btn'), (c) => void onGoogle(c)).then((ok) => {
  googleOn = ok
  gLogin.hidden = !ok || tabs.hidden
})

function resetLogin() {
  for (const el of Object.values(panes)) if (el instanceof HTMLFormElement) el.reset()
  loginPane(firstPane(), false)
}

// ---------- dashboard ----------

$('logout').addEventListener('click', () => {
  void api.logout().finally(() => {
    resetLogin()
    arena?.setStill(false)
    show('login')
  })
})

const joinForm = $<HTMLFormElement>('join-form')
joinForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const code = (joinForm.elements.namedItem('code') as HTMLInputElement).value.trim().toUpperCase()
  if (code) location.href = `/duel.html?code=${encodeURIComponent(code)}`
})

function renderStats(s: Stats | null) {
  const m = s?.me
  const cell = (v: string, label: string, cls = '') => `<div class="stat"><b class="${cls}">${v}</b><span>${label}</span></div>`
  $('stats').innerHTML = m
    ? cell(fmtR(m.totalR), 'Total R, all duels', tone(m.totalR)) +
      cell(m.winRate === null ? '–' : `${Math.round(m.winRate * 100)}%`, `Win rate (${m.trades} trades)`) +
      cell(String(m.duels), 'Duels finished') +
      cell(m.rank ? `#${m.rank}` : '–', '7-day rank')
    : '<p class="empty">Stats could not be loaded.</p>'
  $('me-rank').textContent = m?.rank ? `Rank #${m.rank}` : 'Guest'
  const board = s?.board ?? []
  $('lb').innerHTML = board.length
    ? board
        .map(
          (x) =>
            `<li class="${x.me ? 'me' : ''}"><span>${x.rank}</span><span>${esc(x.nickname)}</span><span class="n">${x.duels} ${x.duels === 1 ? 'duel' : 'duels'}</span><span class="r ${tone(x.totalR)}">${fmtR(x.totalR)}</span></li>`,
        )
        .join('') +
      (m?.rank && m.rank > 10 && m.weekR !== null
        ? `<li class="me"><span>${m.rank}</span><span>${esc($('me-name').textContent ?? '')}</span><span class="n"></span><span class="r ${tone(m.weekR)}">${fmtR(m.weekR)}</span></li>`
        : '')
    : '<li class="empty">No finished duels this week yet. Be the first.</li>'
}

function renderActive(items: DuelListItem[]) {
  const open = items.filter((d) => d.nextRound !== null).slice(0, 5)
  $('active').hidden = !open.length
  $('active-list').innerHTML = open
    .map((d) => {
      const vs = d.mode === 'solo' ? 'Solo' : d.players.length < 2 ? 'Waiting for an opponent' : `vs ${esc(d.players.map((p) => p.nickname).join(' / '))}`
      return `<li><a href="/duel.html?code=${d.code}"><span><b>${d.code}</b> · ${vs}</span><span class="meta">Round ${d.nextRound}/${d.rounds} · continue</span></a></li>`
    })
    .join('')
}

async function enter(user: User) {
  try {
    localStorage.setItem(HAS_ACCOUNT, '1')
  } catch {
    /* private mode */
  }
  // signed in from another page (e.g. a duel link): go back there
  const next = sessionStorage.getItem('rc.next')
  if (next && next.startsWith('/')) {
    sessionStorage.removeItem('rc.next')
    location.href = next
    return
  }
  $('me-name').textContent = user.nickname
  $('greet').textContent = `Welcome, ${user.nickname}`
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
