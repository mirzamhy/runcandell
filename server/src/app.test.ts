import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from './app.ts'
import { openDb } from './db.ts'

function setup(signupLimit = 10) {
  const app = createApp(openDb(':memory:'), { secureCookie: false, signupLimit })
  /** tiny cookie-keeping client */
  const client = () => {
    let cookie = ''
    return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const h: Record<string, string> = { 'x-rc': '1', ...headers }
      if (cookie) h.cookie = cookie
      let payload: BodyInit | undefined
      if (body instanceof Uint8Array) payload = body as unknown as BodyInit
      else if (body !== undefined) {
        payload = JSON.stringify(body)
        h['content-type'] = 'application/json'
      }
      const res = await app.request(path, { method, headers: h, body: payload })
      const set = res.headers.get('set-cookie')
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0]
      const type = res.headers.get('content-type') ?? ''
      return { status: res.status, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()), type }
    }
  }
  return { app, client }
}

const SESSION = { startTime: 1000, cursorTime: 5000, hideDate: false, account: { balance: 10100, history: [{ pnl: 100 }] } }

test('guest signup, me, logout, recover', async () => {
  const { client } = setup()
  const a = client()
  assert.equal((await a('GET', '/api/me')).status, 401)
  const r = await a('POST', '/api/auth/guest', { nickname: 'mirza_1' })
  assert.equal(r.status, 201)
  const code = r.body.recoveryCode as string
  assert.match(code, /^rc-/)
  assert.equal((await a('GET', '/api/me')).body.user.nickname, 'mirza_1')
  assert.equal((await a('POST', '/api/auth/guest', { nickname: 'MIRZA_1' })).status, 409, 'nickname unique, case-insensitive')
  await a('POST', '/api/auth/logout')
  assert.equal((await a('GET', '/api/me')).status, 401)

  const b = client()
  assert.equal((await b('POST', '/api/auth/recover', { code: 'rc-wrongwrongwrong' })).status, 401)
  assert.equal((await b('POST', '/api/auth/recover', { code })).body.user.nickname, 'mirza_1')
  // rotate: old code dies
  const fresh = (await b('POST', '/api/me/recovery')).body.recoveryCode
  assert.notEqual(fresh, code)
  assert.equal((await client()('POST', '/api/auth/recover', { code })).status, 401)
  assert.equal((await client()('POST', '/api/auth/recover', { code: fresh })).status, 200)
})

test('validation, CSRF header, signup rate limit', async () => {
  const { client } = setup(2)
  const a = client()
  assert.equal((await a('POST', '/api/auth/guest', { nickname: 'a b' })).status, 400)
  assert.equal((await a('POST', '/api/auth/guest', { nickname: 'okname' }, { 'x-rc': '' })).status, 403)
  assert.equal((await a('POST', '/api/auth/guest', { nickname: 'user_a' })).status, 201)
  assert.equal((await client()('POST', '/api/auth/guest', { nickname: 'user_b' })).status, 201)
  assert.equal((await client()('POST', '/api/auth/guest', { nickname: 'user_c' })).status, 429)
})

test('replay sessions are private per user', async () => {
  const { client } = setup()
  const a = client()
  const b = client()
  await a('POST', '/api/auth/guest', { nickname: 'alice' })
  await b('POST', '/api/auth/guest', { nickname: 'bob' })
  const { id } = (await a('POST', '/api/replays', { name: 'Senin pagi', session: SESSION })).body
  const list = (await a('GET', '/api/replays')).body.items
  assert.equal(list.length, 1)
  assert.equal(list[0].trades, 1)
  assert.equal(list[0].balance, 10100)
  assert.equal((await b('GET', `/api/replays/${id}`)).status, 404)
  assert.equal((await b('GET', '/api/replays')).body.items.length, 0)
  assert.equal((await a('PUT', `/api/replays/${id}`, { name: 'x', session: { ...SESSION, cursorTime: 9000 } })).status, 200)
  assert.equal((await a('GET', `/api/replays/${id}`)).body.session.cursorTime, 9000)
  await b('DELETE', `/api/replays/${id}`)
  assert.equal((await a('GET', '/api/replays')).body.items.length, 1, 'other user cannot delete')
})

test('backtests save and load', async () => {
  const { client } = setup()
  const a = client()
  await a('POST', '/api/auth/guest', { nickname: 'alice' })
  const r = await a('POST', '/api/backtests', { name: 'EMA', spec: { tf: 'M15' }, metrics: { net: 5 }, curve: { t: [1, 2], v: [10, 11] }, from: 1, to: 2 })
  assert.equal(r.status, 201)
  const full = (await a('GET', `/api/backtests/${r.body.id}`)).body
  assert.deepEqual(full.curve, { t: [1, 2], v: [10, 11] })
  assert.equal((await a('GET', '/api/backtests')).body.items[0].metrics.net, 5)
})

test('journal with screenshot', async () => {
  const { client } = setup()
  const a = client()
  const b = client()
  await a('POST', '/api/auth/guest', { nickname: 'alice' })
  await b('POST', '/api/auth/guest', { nickname: 'bob' })
  const trade = { side: 'buy', entry: 4000.2, exit: 4010, pnl: 98, lots: 0.1, openTime: 1, closeTime: 2, r: 1.5 }
  const r = await a('POST', '/api/journal', { source: 'replay', trade, setup: 'Breakout', emotion: 'tenang', note: 'retest', tags: ['london'] })
  assert.equal(r.status, 201)
  const id = r.body.id
  assert.equal((await a('POST', '/api/journal', { source: 'x' })).status, 400)

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  assert.equal((await a('PUT', `/api/journal/${id}/shot`, new Uint8Array([1, 2, 3, 4]))).status, 400, 'not an image')
  assert.equal((await b('PUT', `/api/journal/${id}/shot`, png)).status, 404, 'not owner')
  assert.equal((await a('PUT', `/api/journal/${id}/shot`, png)).status, 200)
  const shot = await a('GET', `/api/journal/${id}/shot`)
  assert.equal(shot.type, 'image/png')
  assert.deepEqual([...(shot.body as Uint8Array)], [...png])
  assert.equal((await b('GET', `/api/journal/${id}/shot`)).status, 404)
  assert.equal((await a('PUT', `/api/journal/${id}/shot`, new Uint8Array(700 * 1024))).status, 413)

  const items = (await a('GET', '/api/journal')).body.items
  assert.equal(items[0].hasShot, true)
  assert.equal(items[0].trade.pnl, 98)
  assert.deepEqual(items[0].tags, ['london'])
  await a('PATCH', `/api/journal/${id}`, { setup: 'Pullback', emotion: 'ragu', note: '', tags: [] })
  assert.equal((await a('GET', '/api/journal')).body.items[0].setup, 'Pullback')
  await a('DELETE', `/api/journal/${id}`)
  assert.equal((await a('GET', '/api/journal')).body.items.length, 0)
})
