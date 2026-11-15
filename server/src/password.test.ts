import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from './app.ts'
import { openDb } from './db.ts'

function setup() {
  const app = createApp(openDb(':memory:'), { secureCookie: false })
  return () => {
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
}

test('email: register, sign in with email or nickname, wrong password refused', async () => {
  const client = setup()
  const a = client()
  const reg = await a('POST', '/api/auth/register', { nickname: 'budi_fx', email: ' Budi@Example.com ', password: 'rahasia123' })
  assert.equal(reg.status, 201)
  assert.deepEqual((await a('GET', '/api/me')).body.user.login, { email: 'budi@example.com' })

  const b = client()
  assert.equal((await b('POST', '/api/auth/login', { login: 'BUDI@example.com', password: 'rahasia123' })).body.user.nickname, 'budi_fx')
  assert.equal((await b('GET', '/api/me')).status, 200)
  const c = client()
  assert.equal((await c('POST', '/api/auth/login', { login: 'Budi_FX', password: 'rahasia123' })).status, 200, 'nickname works too')
  const wrong = await client()('POST', '/api/auth/login', { login: 'budi@example.com', password: 'salah12345' })
  assert.deepEqual([wrong.status, wrong.body.error], [401, 'Wrong email/nickname or password.'])
  const none = await client()('POST', '/api/auth/login', { login: 'nobody@example.com', password: 'whatever1' })
  assert.deepEqual([none.status, none.body.error], [401, 'Wrong email/nickname or password.'], 'same answer: no hint that the email is unknown')
})

test('email: validation and duplicates', async () => {
  const a = setup()()
  const bad = async (body: object) => (await a('POST', '/api/auth/register', body)).body.error
  assert.equal(await bad({ nickname: 'x_one', email: 'not-an-email', password: 'rahasia123' }), 'Invalid email address.')
  assert.equal(await bad({ nickname: 'x_one', email: 'a@b.co', password: 'short' }), 'The password needs at least 8 characters.')
  assert.equal((await a('POST', '/api/auth/register', { nickname: 'x_one', email: 'a@b.co', password: 'rahasia123' })).status, 201)
  assert.match(await bad({ nickname: 'x_two', email: 'A@B.co', password: 'rahasia123' }), /already registered/)
  assert.equal(await bad({ nickname: 'X_ONE', email: 'c@d.co', password: 'rahasia123' }), 'That nickname is taken.')
})

test('email: guest adds a password later; changing it needs the old one and signs out other devices', async () => {
  const client = setup()
  const a = client()
  await a('POST', '/api/auth/guest', { nickname: 'tamu1' })
  assert.equal((await a('GET', '/api/me')).body.user.login, null)
  assert.equal((await a('POST', '/api/me/password', { email: 'tamu@example.com', password: 'pertama123' })).status, 200)
  const other = client()
  assert.equal((await other('POST', '/api/auth/login', { login: 'tamu@example.com', password: 'pertama123' })).status, 200)

  assert.equal((await a('POST', '/api/me/password', { current: 'salah', password: 'kedua12345' })).status, 401)
  assert.equal((await a('POST', '/api/me/password', { current: 'pertama123', password: 'kedua12345' })).status, 200)
  assert.equal((await a('GET', '/api/me')).status, 200, 'this device stays in')
  assert.equal((await other('GET', '/api/me')).status, 401, 'the other device is signed out')
  assert.equal((await client()('POST', '/api/auth/login', { login: 'tamu1', password: 'kedua12345' })).status, 200)
})

test('email: repeated wrong passwords are slowed down', async () => {
  const client = setup()
  await client()('POST', '/api/auth/register', { nickname: 'target', email: 't@example.com', password: 'benar12345' })
  const x = client()
  for (let i = 0; i < 8; i++) assert.equal((await x('POST', '/api/auth/login', { login: 't@example.com', password: `nope${i}xxxx` })).status, 401)
  assert.equal((await x('POST', '/api/auth/login', { login: 't@example.com', password: 'benar12345' })).status, 429, 'even the right password waits')
})
