import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import type { Jwk } from './google.ts'

const CLIENT = 'test-client.apps.googleusercontent.com'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk: Jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1', alg: 'RS256' }
const NOW = 2_000_000_000

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
function idToken(claims: Record<string, unknown>, kid = 'k1') {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' })
  const body = b64({ iss: 'https://accounts.google.com', aud: CLIENT, iat: NOW, exp: NOW + 3600, email_verified: true, ...claims })
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
}

function setup() {
  const app = createApp(openDb(':memory:'), { secureCookie: false, now: () => NOW, google: { clientId: CLIENT, jwks: async () => [jwk] } })
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
  return client
}

test('google: new account asks for a nickname, then signs in on any device', async () => {
  const client = setup()
  const a = client()
  assert.equal((await a('GET', '/api/auth/config')).body.googleClientId, CLIENT)
  const cred = idToken({ sub: 'g-1', email: 'ana@example.com', name: 'Ana Real Name' })
  const first = (await a('POST', '/api/auth/google', { credential: cred })).body
  assert.equal(first.needNickname, true)
  assert.match(first.suggestion, /^trader\d+$/, 'never the real name')
  assert.equal((await a('GET', '/api/me')).status, 401, 'no account yet')
  const made = await a('POST', '/api/auth/google', { credential: cred, nickname: 'ana_fx' })
  assert.equal(made.status, 201)
  const me = (await a('GET', '/api/me')).body.user
  assert.deepEqual([me.nickname, me.google], ['ana_fx', { email: 'ana@example.com' }])

  // another device: same Google account, straight in
  const b = client()
  const again = (await b('POST', '/api/auth/google', { credential: idToken({ sub: 'g-1', email: 'ana@example.com' }) })).body
  assert.equal(again.user.nickname, 'ana_fx')
  assert.equal((await b('GET', '/api/me')).body.user.nickname, 'ana_fx')
})

test('google: a guest links Google and keeps the account', async () => {
  const client = setup()
  const a = client()
  await a('POST', '/api/auth/guest', { nickname: 'guesty' })
  const r = (await a('POST', '/api/auth/google', { credential: idToken({ sub: 'g-2', email: 'g@example.com' }) })).body
  assert.deepEqual([r.user.nickname, r.linked], ['guesty', true])
  const b = client()
  assert.equal((await b('POST', '/api/auth/google', { credential: idToken({ sub: 'g-2' }) })).body.user.nickname, 'guesty')
  // that Google account cannot also be linked to a second guest
  const c = client()
  await c('POST', '/api/auth/guest', { nickname: 'other' })
  assert.equal((await c('POST', '/api/auth/google', { credential: idToken({ sub: 'g-2' }) })).status, 409)
  // and a linked account cannot take a second Google account
  assert.equal((await a('POST', '/api/auth/google', { credential: idToken({ sub: 'g-3' }) })).status, 409)
})

test('google: forged, foreign or expired tokens are refused', async () => {
  const client = setup()
  const a = client()
  const good = idToken({ sub: 'g-4' })
  const [h, p] = good.split('.')
  const tampered = `${h}.${b64({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'someone-else' })}.${good.split('.')[2]}`
  for (const [name, cred] of [
    ['tampered payload', tampered],
    ['other app', idToken({ sub: 'g-4', aud: 'evil.apps.googleusercontent.com' })],
    ['other issuer', idToken({ sub: 'g-4', iss: 'https://evil.example' })],
    ['expired', idToken({ sub: 'g-4', exp: NOW - 3600 })],
    ['unknown key', idToken({ sub: 'g-4' }, 'nope')],
    ['not a jwt', 'abc.def'.padEnd(30, 'x')],
  ])
    assert.equal((await a('POST', '/api/auth/google', { credential: cred })).status, 401, name)
  // unverified email is not stored
  await a('POST', '/api/auth/google', { credential: idToken({ sub: 'g-5', email: 'x@example.com', email_verified: false }), nickname: 'nomail' })
  assert.equal((await a('GET', '/api/me')).body.user.google.email, null)
})

test('google: off without a client id', async () => {
  const app = createApp(openDb(':memory:'), { secureCookie: false })
  assert.equal((await (await app.request('/api/auth/config')).json()).googleClientId, null)
  const res = await app.request('/api/auth/google', { method: 'POST', headers: { 'x-rc': '1', 'content-type': 'application/json' }, body: '{"credential":"x"}' })
  assert.equal(res.status, 503)
})
