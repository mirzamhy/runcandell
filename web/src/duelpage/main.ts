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
import { SYMBOL_LIST, instrument } from '../instruments'
import { openReview } from './review'

mountLogos()
setFavicon()

const app = document.getElementById('app')!
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const fmtR = (r: number | null | undefined) => (r === null || r === undefined ? '–' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`)
const tone = (n: number | null | undefined) => (!n ? '' : n > 0 ? 'pos' : 'neg')
const REASON: Record<string, string> = { tp: 'TP', sl: 'SL', time: 'Time up', skip: 'Skip', timeout: 'Too late', stopout: 'Stop-out', unfilled: 'Order not filled' }
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
  rounds: { label: 'Rounds', values: [1, 3, 5, 7, 10], def: 5, fmt: (v: number) => String(v) },
}

/** analysis time per round, by name */
const SPEEDS = [
  { sec: 60, name: 'Quick', time: '1 min', note: 'Scalping: read fast, decide fast.' },
  { sec: 180, name: 'Normal', time: '3 min', note: 'Time to check a few timeframes.' },
  { sec: 600, name: 'Deep', time: '10 min', note: 'Multi-timeframe analysis, levels and drawings.' },
]
const speedName = (sec: number) => SPEEDS.find((x) => x.sec === sec)?.name ?? (sec < 60 ? `${sec} s` : `${sec / 60} min`)
const runText = (min: number) => (min >= 1440 ? `${min / 1440} day` : min >= 60 ? `${min / 60} h` : `${min} min`)

function speedCards() {
  return `<fieldset class="dp-field"><legend>Analysis time</legend><div class="dp-modes dp-speeds">${SPEEDS.map(
    (x) =>
      `<label class="dp-mode"><input type="radio" name="analysisSec" value="${x.sec}"${x.sec === 180 ? ' checked' : ''} /><span><b>${x.name} <em>${x.time}</em></b><small>${x.note}</small></span></label>`,
  ).join('')}</div></fieldset>`
}

function pairChips() {
  const opts = [['random', 'Random'], ...SYMBOL_LIST.map((x) => [x, x])]
  return `<fieldset class="dp-field"><legend>Pair</legend><div class="dp-chips">${opts
    .map(([v, t]) => `<label class="dp-chip"><input type="radio" name="pair" value="${v}"${v === 'random' ? ' checked' : ''} /><span>${t}</span></label>`)
    .join('')}</div><p class="dp-note">Random: a different pair each round, named only after you decide. Each trade runs for 1 day after your decision.</p></fieldset>`
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
    ${cell(String(m.duels), 'Duels finished')}
    ${cell(m.winRate === null ? '–' : `${Math.round(m.winRate * 100)}%`, 'Winning rounds')}
    ${cell(m.rank ? `#${m.rank}` : '–', 'Rank this week')}
  </section>`
}

function listCard(d: DuelListItem) {
  const mine = d.players.find((p) => p.nickname === me?.nickname) ?? d.players[0]
  const other = d.players.find((p) => p !== mine)
  const status = d.status === 'done' ? 'Finished' : d.nextRound ? `Round ${d.nextRound}/${d.rounds}` : d.mode === 'async' && d.players.length < 2 ? 'Waiting for an opponent' : 'Waiting for your opponent'
  return `<a class="dp-card ${d.status === 'done' ? 'done' : ''}" href="${duelUrl(d.code)}">
    <span class="dp-card-vs"><b>${esc(mine?.nickname ?? '?')}</b><i>VS</i><b>${d.mode === 'solo' ? 'Practice' : esc(other?.nickname ?? '???')}</b></span>
    <span class="dp-card-meta"><code>${d.code}</code> · ${d.rounds} rounds · ${status}${d.status === 'done' ? ` · ${formatWall(d.created_at, false)}` : ''}</span>
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
        <p class="dp-kicker">1 vs 1 · prices disguised</p>
        <h1>Candle Duel</h1>
        <p>The chart is cut at a random point. You and your opponent get the same slice, analyse it, then BUY, SELL or skip. Scored in R; the highest wins.</p>
      </div>
      <div class="dp-hero-vs" aria-hidden="true"><span class="a"></span><b>VS</b><span class="b"></span></div>
    </section>
    ${recordHtml(stats)}
    <div class="dp-grid">
      <form class="dp-panel dp-create" data-f="create">
        <h2>New duel</h2>
        <fieldset class="dp-field"><legend>Opponent</legend>
          <div class="dp-modes">
            <label class="dp-mode"><input type="radio" name="mode" value="async" checked /><span><b>Challenge a friend</b><small>You get a link to send. Play any time; results open once you both finish.</small></span></label>
            <label class="dp-mode"><input type="radio" name="mode" value="solo" /><span><b>Practise solo</b><small>No opponent. Counts toward your record, not a head-to-head.</small></span></label>
          </div></fieldset>
        ${speedCards()}${pairChips()}${chips('rounds')}
        <label class="dp-toggle"><input type="checkbox" name="hardcore" /><span><b>Hardcore</b> the time of day is hidden too</span></label>
        <button type="submit" class="dp-cta">Create duel</button>
      </form>
      <div class="dp-col">
        <form class="dp-panel" data-f="join">
          <h2>Got a code?</h2>
          <div class="dp-join"><input name="code" required maxlength="8" autocomplete="off" spellcheck="false" placeholder="ABCD2345" aria-label="Duel code" /><button type="submit" class="dp-btn">Open</button></div>
        </form>
        <section class="dp-panel">
          <h2>Rules</h2>
          <ol class="dp-rules">
            <li><b>Random slice.</b> Prices normalised, dates hidden. Every timeframe is open.</li>
            <li><b>Timed analysis.</b> Run out of time = skip.</li>
            <li><b>Market, limit or stop.</b> SL required, TP optional.</li>
            <li><b>Scored in R.</b> Hitting the SL = -1R. Spread included.</li>
          </ol>
        </section>
      </div>
    </div>
    <section class="dp-list">
      <h2>Active duels <small>${open.length}</small></h2>
      ${open.length ? `<div class="dp-cards">${open.map(listCard).join('')}</div>` : '<p class="dp-empty">None yet. Create a duel above.</p>'}
      ${done.length ? `<h2>Match history <small>${done.length}</small></h2><p class="dp-note">Open a match to see every trade with its real prices, then open a trade to see it on the chart.</p><div class="dp-cards">${done.map(listCard).join('')}</div>` : ''}
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
    ${p?.nickname === me?.nickname ? '<p class="vs-you">you</p>' : ''}
    <ul class="vs-stats">
      ${row('Total', fmtR(s.total), tone(s.total))}
      ${row('Rounds played', `${s.played}/${total}`)}
      ${row('Winning rounds', String(s.wins))}
      ${row('Best', fmtR(s.best), tone(s.best))}
    </ul>
  </div>`
}

function roundCard(r: DuelRoundResult, names: string[], done: boolean) {
  const digits = r.symbol ? instrument(r.symbol).digits : 2
  const px = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toFixed(digits))
  const cell = (n: string) => {
    const x = r.results.find((y) => y.nickname === n)
    if (!x) return `<li class="wait"><span>${esc(n)}</span><b>${done ? '–' : '?'}</b></li>`
    const head = `${SIDE[x.side] ?? x.side}${x.type && x.type !== 'market' && x.side !== 'skip' ? ` ${x.type.toUpperCase()}` : ''} · ${REASON[x.reason] ?? x.reason}`
    if (!done) return `<li class="${tone(x.r)}"><span>${esc(n)}</span><em>${head}</em><b>${fmtR(x.r)}</b></li>`
    // finished: the real trade, and a tap opens it on the real chart
    const prices =
      x.side === 'skip'
        ? ''
        : `<em class="dp-px">${x.entry === null ? `order ${px(x.price)} · not filled` : `${px(x.entry)} → ${px(x.exit)}`}</em><em class="dp-px">SL ${px(x.sl)} · TP ${px(x.tp)}</em>`
    return `<li class="${tone(x.r)}"><button type="button" class="dp-trade" data-a="review" data-round="${r.round}" data-who="${esc(n)}" title="See this trade on the real chart"><span>${esc(n)}</span><em>${head}</em>${prices}<b>${fmtR(x.r)}</b></button></li>`
  }
  const when = done && r.realTime ? `<small>${formatWall(r.realTime)} UTC</small>` : ''
  const open = done ? `<button type="button" class="dp-chart" data-a="review" data-round="${r.round}">Chart</button>` : ''
  return `<article class="dp-round"><header><span>Round ${r.round}${done && r.symbol ? ` · ${r.symbol}` : ''}${when}</span>${open}</header><ul>${names.map(cell).join('')}</ul></article>`
}

async function renderDuel(code: string) {
  const d: DuelDetail = await duelApi.get(code)
  const total = typeof d.rounds === 'number' ? d.rounds : d.rounds.length
  const params = `${total} rounds · ${speedName(d.analysisSec)} · ${d.pair && d.pair !== 'random' ? d.pair : 'random pair'} · runs ${runText(d.runMinutes)}${d.hardcore ? ' · hardcore' : ''}`
  const back = '<a class="dp-back" href="/duel.html">← All duels</a>'
  const link = `${location.origin}${duelUrl(d.code)}`
  const share = d.mode === 'async' ? `<div class="dp-share"><input readonly value="${esc(link)}" aria-label="Duel link" /><button type="button" class="dp-btn" data-a="copy" data-link="${esc(link)}">Copy link</button></div>` : ''

  if (!d.member) {
    const host = d.players[0]
    app.innerHTML = `${back}
      <section class="vs-stage">
        ${fighter(host, 'a', [], total, '')}
        <div class="vs-mid"><b class="vs-word">VS</b><p>${params}</p>
          ${d.joinable ? `<button type="button" class="dp-cta" data-a="join" data-code="${d.code}">Accept the challenge</button>` : '<p class="dp-empty">This duel is full or a private practice.</p>'}</div>
        ${fighter(undefined, 'b', [], total, me ? esc(me.nickname) : 'You')}
      </section>`
    return
  }

  const rounds = d.rounds as DuelRoundResult[]
  const done = d.status === 'done'
  const a = d.players.find((p) => p.nickname === me?.nickname) ?? d.players[0]
  const b = d.players.find((p) => p !== a)
  let banner = ''
  if (done) {
    if (d.mode === 'solo' || !b) banner = `<p class="vs-banner solo">Practice done</p>`
    else {
      const ra = a.totalR ?? 0
      const rb = b.totalR ?? 0
      banner = ra === rb ? '<p class="vs-banner draw">Draw</p>' : ra > rb ? '<p class="vs-banner win">Victory</p>' : '<p class="vs-banner lose">Defeat</p>'
    }
  }
  const waiting =
    !done && !d.nextRound ? `<p class="vs-note">You are done. ${d.mode === 'async' && d.players.length < 2 ? 'Send the link to your opponent.' : 'Waiting for your opponent; results open after that.'}</p>` : ''
  const play = d.nextRound ? `<a class="dp-cta" href="${playUrl(d.code, d.nextRound)}">${d.nextRound === 1 ? 'Start round 1' : `Continue round ${d.nextRound}`}</a>` : ''
  const names = d.players.map((p) => p.nickname)
  app.innerHTML = `${back}
    <section class="vs-stage${done ? ' is-done' : ''}">
      ${fighter(a, 'a', rounds, total, '')}
      <div class="vs-mid">
        ${banner}
        <b class="vs-word">VS</b>
        <p class="vs-code"><code>${d.code}</code> · ${d.mode === 'solo' ? 'practice' : 'challenge'}</p>
        <p>${params}</p>
        ${play}${waiting}
      </div>
      ${fighter(b, 'b', rounds, total, d.mode === 'solo' ? 'Practice' : 'Waiting for an opponent')}
    </section>
    ${share}
    <section class="dp-list">
      <h2>${done ? 'Trades' : 'Rounds'}</h2>
      ${done ? '<p class="dp-note">Real prices and times. Tap a trade to see where it entered, where it left and where SL/TP sat.</p>' : ''}
      ${rounds.length ? `<div class="dp-rounds">${rounds.map((r) => roundCard(r, names, done)).join('')}</div>` : '<p class="dp-empty">No rounds played yet.</p>'}
      ${done ? '' : '<p class="dp-empty">Your opponent\'s results show once every player is done.</p>'}
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
      btn.textContent = 'Picking chart slices…'
      const { code } = await duelApi.create({
        mode: fd.get('mode') as 'solo' | 'async',
        rounds: Number(fd.get('rounds')),
        analysisSec: Number(fd.get('analysisSec')),
        pair: String(fd.get('pair') ?? 'random'),
        hardcore: fd.get('hardcore') === 'on',
      })
      location.href = duelUrl(code)
    } else location.href = duelUrl(String(fd.get('code')).trim().toUpperCase())
  } catch (err) {
    toast((err as Error).message, 'bad')
    btn.disabled = false
    btn.textContent = f.dataset.f === 'create' ? 'Create duel' : 'Open'
  }
})

app.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')
  if (!el) return
  try {
    if (el.dataset.a === 'copy')
      await navigator.clipboard.writeText(el.dataset.link!).then(
        () => toast('Link copied. Send it to your opponent.'),
        () => toast('Copy it from the link box by hand.', 'bad'),
      )
    if (el.dataset.a === 'review') {
      const code = new URLSearchParams(location.search).get('code')
      if (code) openReview(code.toUpperCase(), Number(el.dataset.round), el.dataset.who)
    }
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
    .then((s) => (document.getElementById('me-rank')!.textContent = s.me?.rank ? `Rank #${s.me.rank}` : 'Guest'))
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
    app.innerHTML = `<section class="dp-gate"><h1>Candle Duel</h1><p>Sign in or create an account first, then you come straight back here${code ? ` for duel <code>${esc(code.toUpperCase())}</code>` : ''}.</p><a class="dp-cta" href="/#join">Sign in</a></section>`
    return
  }
  showMe(me)
  try {
    if (code) await renderDuel(code.toUpperCase())
    else await renderLobby()
  } catch (err) {
    app.innerHTML = `<p class="dp-empty">${esc((err as Error).message)}</p><a class="dp-back" href="/duel.html">← All duels</a>`
  }
}
void boot()
