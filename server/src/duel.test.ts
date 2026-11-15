import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bar, TF } from '../../web/src/types.ts'
import { TF_SEC, aggregate } from '../../web/src/engine/duel.ts'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import type { MarketData } from './market.ts'

/** 60 days of continuous synthetic M1 + pyramid. */
function fakeMarket(): MarketData {
  const start = 1_700_000_000 - (1_700_000_000 % 86400)
  const m1: Bar[] = []
  let p = 2000
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 60 * 1440; i++) {
    const o = p
    p += (rnd() - 0.5) * 2
    m1.push({ time: start + i * 60, open: o, high: Math.max(o, p) + rnd(), low: Math.min(o, p) - rnd(), close: p, volume: 10, spread: 0.2 })
  }
  const pyramid: Partial<Record<TF, Bar[]>> = { M1: m1 }
  for (const tf of ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as TF[]) {
    const s = TF_SEC[tf]
    const groups = new Map<number, Bar[]>()
    for (const b of m1) {
      const k = Math.floor(b.time / s) * s
      groups.set(k, [...(groups.get(k) ?? []), b])
    }
    pyramid[tf] = [...groups].map(([k, parts]) => aggregate(parts, k))
  }
  return {
    span: async () => ({ from: m1[0].time, to: m1[m1.length - 1].time }),
    bars: async (tf, from, to) => pyramid[tf]!.filter((b) => b.time >= from && b.time < to),
  }
}

const market = fakeMarket()

function setup() {
  let clock = 2_000_000_000
  const app = createApp(openDb(':memory:'), { secureCookie: false, market, now: () => clock })
  const client = () => {
    let cookie = ''
    return async (method: string, path: string, body?: unknown) => {
      const h: Record<string, string> = { 'x-rc': '1' }
      if (cookie) h.cookie = cookie
      if (body !== undefined) h['content-type'] = 'application/json'
      const res = await app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
      const set = res.headers.get('set-cookie')
      if (set) cookie = set.split(';')[0]
      return { status: res.status, body: await res.json() }
    }
  }
  return { client, tick: (s: number) => (clock += s) }
}

const PARAMS = { rounds: 3, analysisSec: 60, runMinutes: 60, hardcore: false }

test('solo duel: snapshot has no future, server scores, timer enforced', async () => {
  const { client, tick } = setup()
  const a = client()
  await a('POST', '/api/auth/guest', { nickname: 'alice' })
  const { code } = (await a('POST', '/api/duels', { mode: 'solo', ...PARAMS })).body
  assert.match(code, /^[A-Z2-9]{8}$/)
  assert.equal((await a('GET', `/api/duels/${code}`)).body.nextRound, 1)
  assert.equal((await a('POST', `/api/duels/${code}/rounds/1/decide`, { side: 'skip' })).status, 409, 'not started')
  assert.equal((await a('POST', `/api/duels/${code}/rounds/2/start`)).status, 409, 'wrong round')

  const s = (await a('POST', `/api/duels/${code}/rounds/1/start`)).body
  assert.equal(s.remaining, 60)
  assert.equal(s.cut.close, 1000, 'price rebased at the cut')
  const m1 = s.bars.M1 as Bar[]
  assert.equal(m1[m1.length - 1].time, s.cut.time, 'M1 ends exactly at the cut')
  for (const tf of ['M5', 'M15', 'H1', 'H4', 'D1']) {
    const bars = s.bars[tf] as Bar[]
    assert.ok(bars.length > 0, tf)
    const last = bars[bars.length - 1]
    assert.ok(last.time <= s.cut.time, `${tf} no candle after the cut`)
    assert.equal(last.close, s.cut.close, `${tf} forming candle closes at the cut`)
  }
  // forming H1 high can only come from minutes up to the cut
  const h1 = (s.bars.H1 as Bar[]).at(-1)!
  const sameHour = m1.filter((b) => b.time >= h1.time)
  assert.equal(h1.high, Math.max(...sameHour.map((b) => b.high)))

  const entry = s.cut.close + s.cut.spread
  const tooClose = await a('POST', `/api/duels/${code}/rounds/1/decide`, { side: 'buy', sl: entry - s.minStop / 2 })
  assert.equal(tooClose.status, 400)
  assert.match(tooClose.body.error, /too close/)
  const d = (await a('POST', `/api/duels/${code}/rounds/1/decide`, { side: 'buy', sl: entry - s.minStop * 2, tp: entry + s.minStop * 4 })).body
  assert.equal(d.future.length, 60, 'run window revealed after deciding')
  assert.ok(d.future[0].time > s.cut.time)
  assert.ok(['tp', 'sl', 'time'].includes(d.outcome.reason))
  assert.ok(d.outcome.r >= -1.0001 && d.outcome.r <= 2.0001, `R in [-1, 2]: ${d.outcome.r}`)
  assert.ok(Array.isArray(d.breaks.H1))
  // deciding twice returns the stored result, no second chance
  const again = (await a('POST', `/api/duels/${code}/rounds/1/decide`, { side: 'sell', sl: entry + 50 })).body
  assert.deepEqual(again.outcome, d.outcome)

  // round 2: too late -> forced skip
  await a('POST', `/api/duels/${code}/rounds/2/start`)
  tick(70)
  const late = (await a('POST', `/api/duels/${code}/rounds/2/decide`, { side: 'buy', sl: 1 })).body
  assert.deepEqual([late.outcome.side, late.outcome.reason, late.outcome.r], ['skip', 'timeout', 0])

  // round 3: started and abandoned -> swept into a skip on the next read
  await a('POST', `/api/duels/${code}/rounds/3/start`)
  tick(200)
  const detail = (await a('GET', `/api/duels/${code}`)).body
  assert.equal(detail.status, 'done')
  assert.equal(detail.nextRound, null)
  assert.equal(detail.rounds[2].results[0].reason, 'timeout')
  assert.ok(detail.rounds[0].realTime > 0, 'real date revealed after the duel')
  assert.equal(detail.players[0].totalR, d.outcome.r)
})

test('async duel: join rules and hidden opponent results', async () => {
  const { client } = setup()
  const a = client()
  const b = client()
  const c = client()
  await a('POST', '/api/auth/guest', { nickname: 'alice' })
  await b('POST', '/api/auth/guest', { nickname: 'bob' })
  await c('POST', '/api/auth/guest', { nickname: 'carol' })
  const { code } = (await a('POST', '/api/duels', { mode: 'async', ...PARAMS, rounds: 1 })).body

  const peek = (await b('GET', `/api/duels/${code}`)).body
  assert.deepEqual([peek.member, peek.joinable], [false, true])
  assert.equal(peek.rounds, 1)
  assert.equal((await b('POST', `/api/duels/${code}/rounds/1/start`)).status, 403, 'must join first')
  assert.equal((await b('POST', `/api/duels/${code}/join`)).status, 200)
  assert.equal((await c('POST', `/api/duels/${code}/join`)).status, 409, 'two players max')

  const sa = (await a('POST', `/api/duels/${code}/rounds/1/start`)).body
  await a('POST', `/api/duels/${code}/rounds/1/decide`, { side: 'sell', sl: sa.cut.close + sa.minStop * 3 })
  const sb = (await b('POST', `/api/duels/${code}/rounds/1/start`)).body
  assert.deepEqual(sb.cut, sa.cut, 'same round for both players')
  // bob has not decided: alice's result stays hidden from him
  const mid = (await b('GET', `/api/duels/${code}`)).body
  assert.equal(mid.status, 'open')
  assert.equal(mid.players.find((p: { nickname: string }) => p.nickname === 'alice').totalR, null)
  assert.equal(mid.rounds[0].results.length, 0)

  await b('POST', `/api/duels/${code}/rounds/1/decide`, { side: 'skip' })
  const end = (await b('GET', `/api/duels/${code}`)).body
  assert.equal(end.status, 'done')
  assert.equal(end.rounds[0].results.length, 2)
  assert.notEqual(end.players.find((p: { nickname: string }) => p.nickname === 'alice').totalR, null)
})

test('stats: own record and weekly board of finished duels only', async () => {
  const { client } = setup()
  const a = client()
  const b = client()
  await a('POST', '/api/auth/guest', { nickname: 'alice' })
  await b('POST', '/api/auth/guest', { nickname: 'bob' })
  const empty = (await a('GET', '/api/stats')).body
  assert.deepEqual([empty.me.duels, empty.me.totalR, empty.me.winRate, empty.me.rank, empty.board.length], [0, 0, null, null, 0])

  // alice: solo, 1 round, traded
  const solo = (await a('POST', '/api/duels', { mode: 'solo', ...PARAMS, rounds: 1 })).body.code
  const s = (await a('POST', `/api/duels/${solo}/rounds/1/start`)).body
  const d = (await a('POST', `/api/duels/${solo}/rounds/1/decide`, { side: 'buy', sl: s.cut.close + s.cut.spread - s.minStop * 2 })).body
  // async duel with bob, only alice finished: must not show on the board yet
  const as = (await a('POST', '/api/duels', { mode: 'async', ...PARAMS, rounds: 1 })).body.code
  await b('POST', `/api/duels/${as}/join`)
  await b('POST', `/api/duels/${as}/rounds/1/start`)
  await b('POST', `/api/duels/${as}/rounds/1/decide`, { side: 'skip' })

  const st = (await a('GET', '/api/stats')).body
  assert.equal(st.me.duels, 1)
  assert.equal(st.me.trades, 1)
  assert.equal(st.me.totalR, Math.round(d.outcome.r * 100) / 100)
  assert.equal(st.me.winRate, d.outcome.r > 0 ? 1 : 0)
  assert.deepEqual(st.board.map((x: { nickname: string }) => x.nickname), ['alice'], 'bob unfinished-duel result hidden')
  assert.equal(st.me.rank, 1)
  assert.equal((await b('GET', '/api/stats')).body.me.rank, null)
})
