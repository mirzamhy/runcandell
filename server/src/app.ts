/**
 * runcandell API: guest accounts, saved replay sessions, saved backtests, trade journal.
 *
 * Auth: a guest picks a nickname and gets a session cookie plus a one-time-shown recovery code
 * (the only way back in from another device). Only SHA-256 hashes of tokens/codes are stored.
 * CSRF: every non-GET request must carry `X-RC: 1`; browsers cannot add that header cross-site
 * without a CORS preflight, and no CORS is allowed.
 */
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { compress } from 'hono/compress'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { mountDuels } from './duel.ts'
import { checkEmail, checkPassword, dummyHash, hashPassword, loginBrake, verifyPassword } from './password.ts'
import { googleJwks, suggestNickname, verifyGoogleToken, type JwksSource } from './google.ts'
import { HttpError, idParam, int, json, obj, str } from './http.ts'
import { singleMarket, type MarketData, type MarketSource } from './market.ts'

interface User {
  id: number
  nickname: string
}
export type Env = { Variables: { user: User } }

export interface AppOptions {
  secureCookie: boolean
  now?: () => number
  /** guest accounts per IP per hour */
  signupLimit?: number
  /** candle data for duels; without it duel routes answer 503 */
  /** one data set (tests: treated as gold) or every instrument */
  market?: MarketData | MarketSource
  /** "Sign in with Google": OAuth client ID (env RC_GOOGLE_CLIENT_ID); `jwks` only for tests */
  google?: { clientId: string; jwks?: JwksSource }
}

const COOKIE = 'rc_session'
const SESSION_DAYS = 180
const MAX_SHOT = 600 * 1024

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const token = (bytes: number) => randomBytes(bytes).toString('base64url')

const NICK = /^[A-Za-z0-9_]{3,20}$/
const SOURCES = new Set(['replay', 'backtest', 'manual'])

export function createApp(db: DatabaseSync, opt: AppOptions) {
  const now = opt.now ?? (() => Math.floor(Date.now() / 1000))
  const app = new Hono<Env>()
  const signups = new Map<string, number[]>()

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
    console.error(err)
    return c.json({ error: 'Kesalahan server.' }, 500)
  })
  app.notFound((c) => c.json({ error: 'Tidak ditemukan.' }, 404))

  // gzip JSON: duel snapshots are ~300 KB raw, ~70 KB compressed
  // (the Vite dev proxy also stalls on uncompressed bodies past ~256 KB)
  app.use('/api/*', compress({ threshold: 4096 }))

  // CSRF guard + default body limit (screenshots get their own)
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-rc') !== '1') throw new HttpError(403, 'Header X-RC wajib.')
    await next()
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
  })
  const limitJson = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: () => { throw new HttpError(413, 'Data terlalu besar.') } })

  // ---------- auth ----------

  const startSession = (c: Context, userId: number) => {
    const t = token(32)
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)').run(sha(t), userId, now(), now())
    setCookie(c, COOKIE, t, { httpOnly: true, sameSite: 'Lax', secure: opt.secureCookie, path: '/', maxAge: SESSION_DAYS * 86400 })
  }

  const nickTaken = (n: string) => !!db.prepare('SELECT 1 FROM users WHERE nickname = ?').get(n)
  const checkNick = (v: unknown) => {
    const nickname = str(v, 'Nickname', 20, 3)
    if (!NICK.test(nickname)) throw new HttpError(400, 'Nickname cuma boleh huruf, angka, dan _ (3–20).')
    if (nickTaken(nickname)) throw new HttpError(409, 'Nickname sudah dipakai.')
    return nickname
  }
  /** new accounts per IP per hour; returns the commit step, run once the account exists */
  const signupSlot = (c: Context) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local'
    const recent = (signups.get(ip) ?? []).filter((t) => t > now() - 3600)
    if (recent.length >= (opt.signupLimit ?? 10)) throw new HttpError(429, 'Terlalu banyak akun baru. Coba lagi nanti.')
    return () => signups.set(ip, [...recent, now()])
  }
  /** the signed-in user, if any (for routes that also work signed out) */
  const sessionUser = (c: Context): User | undefined => {
    const t = getCookie(c, COOKIE)
    if (!t) return undefined
    const row = db
      .prepare('SELECT u.id, u.nickname, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
      .get(sha(t)) as (User & { last_seen: number }) | undefined
    return row && row.last_seen >= now() - SESSION_DAYS * 86400 ? { id: row.id, nickname: row.nickname } : undefined
  }

  app.post('/api/auth/guest', limitJson, async (c) => {
    const body = await json(c)
    const nickname = checkNick(body.nickname)
    const done = signupSlot(c)
    const code = `rc-${token(18)}`
    const r = db.prepare('INSERT INTO users (nickname, recovery_hash, created_at) VALUES (?, ?, ?)').run(nickname, sha(code), now())
    done()
    const id = Number(r.lastInsertRowid)
    startSession(c, id)
    return c.json({ user: { id, nickname }, recoveryCode: code }, 201)
  })

  // ---------- email + password ----------

  const brake = loginBrake(now)
  // per IP looser: behind a proxy without X-Forwarded-For everyone shares one address
  const ipBrake = loginBrake(now, 40)
  const ipOf = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local'
  const emailTaken = (e: string) => !!db.prepare('SELECT 1 FROM users WHERE login_email = ?').get(e)

  app.post('/api/auth/register', limitJson, async (c) => {
    const body = await json(c)
    const nickname = checkNick(body.nickname)
    const email = checkEmail(body.email)
    const password = checkPassword(body.password)
    if (emailTaken(email)) throw new HttpError(409, 'Email sudah terdaftar. Masuk saja, atau pakai email lain.')
    const done = signupSlot(c)
    const hash = await hashPassword(password)
    // the recovery code stays unknown until asked for in the account dialog
    const r = db
      .prepare('INSERT INTO users (nickname, recovery_hash, login_email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(nickname, sha(token(32)), email, hash, now())
    done()
    const id = Number(r.lastInsertRowid)
    startSession(c, id)
    return c.json({ user: { id, nickname } }, 201)
  })

  /** `login` is the email, or the nickname of an account that has a password */
  app.post('/api/auth/login', limitJson, async (c) => {
    const body = await json(c)
    const login = str(body.login, 'Email atau nickname', 254, 3).toLowerCase()
    const password = typeof body.password === 'string' ? body.password : ''
    const key = `login:${login}`
    const ip = `ip:${ipOf(c)}`
    brake.check(key)
    ipBrake.check(ip)
    const u = db
      .prepare(`SELECT id, nickname, password_hash FROM users WHERE ${login.includes('@') ? 'login_email = ?' : 'nickname = ?'}`)
      .get(login) as (User & { password_hash: string | null }) | undefined
    const ok = await verifyPassword(password.slice(0, 200), u?.password_hash ?? (await dummyHash()))
    if (!u || !u.password_hash || !ok) {
      brake.miss(key)
      ipBrake.miss(ip)
      throw new HttpError(401, 'Email/nickname atau password salah.')
    }
    brake.clear(key)
    startSession(c, u.id)
    return c.json({ user: { id: u.id, nickname: u.nickname } })
  })

  // ---------- Google ----------

  const jwks = opt.google ? (opt.google.jwks ?? googleJwks()) : null
  app.get('/api/auth/config', (c) => c.json({ googleClientId: opt.google?.clientId ?? null }))

  /**
   * One route for every case, decided by the Google account and the current session:
   * known Google account -> sign in; signed in without Google -> link it to this account;
   * otherwise a new account, which needs a nickname (answered with `needNickname` first).
   */
  app.post('/api/auth/google', limitJson, async (c) => {
    if (!opt.google || !jwks) throw new HttpError(503, 'Login Google belum diaktifkan di server.')
    const body = await json(c)
    const g = await verifyGoogleToken(str(body.credential, 'Credential', 4096, 20), opt.google.clientId, jwks, now())
    const known = db.prepare('SELECT id, nickname FROM users WHERE google_sub = ?').get(g.sub) as User | undefined
    const me = sessionUser(c)
    if (known) {
      if (me && me.id !== known.id) throw new HttpError(409, `Akun Google ini sudah dipakai akun ${known.nickname}. Keluar dulu lalu masuk dengan Google.`)
      if (!me) startSession(c, known.id)
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(g.email, known.id)
      return c.json({ user: known })
    }
    if (me) {
      const linked = db.prepare('SELECT google_sub FROM users WHERE id = ?').get(me.id) as { google_sub: string | null }
      if (linked.google_sub) throw new HttpError(409, 'Akun ini sudah terhubung ke akun Google lain.')
      db.prepare('UPDATE users SET google_sub = ?, email = ? WHERE id = ?').run(g.sub, g.email, me.id)
      return c.json({ user: me, linked: true })
    }
    if (body.nickname === undefined) return c.json({ needNickname: true, suggestion: suggestNickname(nickTaken) })
    const nickname = checkNick(body.nickname)
    const done = signupSlot(c)
    // Google accounts sign in with Google; the recovery code stays unknown until they ask for one
    const r = db
      .prepare('INSERT INTO users (nickname, recovery_hash, google_sub, email, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(nickname, sha(token(32)), g.sub, g.email, now())
    done()
    const id = Number(r.lastInsertRowid)
    startSession(c, id)
    return c.json({ user: { id, nickname } }, 201)
  })

  app.post('/api/auth/recover', limitJson, async (c) => {
    const body = await json(c)
    const code = str(body.code, 'Kode', 100, 10)
    const u = db.prepare('SELECT id, nickname FROM users WHERE recovery_hash = ?').get(sha(code)) as User | undefined
    if (!u) throw new HttpError(401, 'Kode pemulihan salah.')
    startSession(c, u.id)
    return c.json({ user: { id: u.id, nickname: u.nickname } })
  })

  app.post('/api/auth/logout', (c) => {
    const t = getCookie(c, COOKIE)
    if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t))
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  // everything below needs a session
  app.use('/api/*', async (c, next) => {
    const t = getCookie(c, COOKIE)
    if (!t) throw new HttpError(401, 'Belum masuk.')
    const row = db
      .prepare('SELECT u.id, u.nickname, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
      .get(sha(t)) as (User & { last_seen: number }) | undefined
    if (!row || row.last_seen < now() - SESSION_DAYS * 86400) {
      deleteCookie(c, COOKIE, { path: '/' })
      throw new HttpError(401, 'Sesi habis. Masuk lagi.')
    }
    if (row.last_seen < now() - 3600) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), sha(t))
    c.set('user', { id: row.id, nickname: row.nickname })
    await next()
  })

  app.get('/api/me', (c) => {
    const u = c.get('user')
    const g = db.prepare('SELECT email, google_sub, login_email FROM users WHERE id = ?').get(u.id) as {
      email: string | null
      google_sub: string | null
      login_email: string | null
    }
    return c.json({ user: { ...u, google: g.google_sub ? { email: g.email } : null, login: g.login_email ? { email: g.login_email } : null } })
  })

  /**
   * Add email + password to an account (guest / Google), or change the password.
   * Changing it needs the current one and signs out every other device.
   */
  app.post('/api/me/password', limitJson, async (c) => {
    const u = c.get('user')
    const body = await json(c)
    const password = checkPassword(body.password)
    const row = db.prepare('SELECT login_email, password_hash FROM users WHERE id = ?').get(u.id) as { login_email: string | null; password_hash: string | null }
    if (row.password_hash) {
      const key = `me:${u.id}`
      brake.check(key)
      if (!(await verifyPassword(typeof body.current === 'string' ? body.current : '', row.password_hash))) {
        brake.miss(key)
        throw new HttpError(401, 'Password sekarang salah.')
      }
      brake.clear(key)
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), u.id)
      const t = getCookie(c, COOKIE) ?? ''
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, sha(t))
      return c.json({ ok: true, email: row.login_email })
    }
    const email = checkEmail(body.email)
    if (emailTaken(email)) throw new HttpError(409, 'Email sudah dipakai akun lain.')
    db.prepare('UPDATE users SET login_email = ?, password_hash = ? WHERE id = ?').run(email, await hashPassword(password), u.id)
    return c.json({ ok: true, email })
  })

  /** New recovery code; the old one stops working. */
  app.post('/api/me/recovery', (c) => {
    const code = `rc-${token(18)}`
    db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?').run(sha(code), c.get('user').id)
    return c.json({ recoveryCode: code })
  })

  // ---------- replay sessions ----------

  const replayFields = (body: Record<string, unknown>) => {
    const name = str(body.name, 'Nama', 60, 1)
    const s = obj(body.session, 'Sesi')
    const acc = obj(s.account, 'Akun sesi')
    const history = Array.isArray(acc.history) ? acc.history : []
    return {
      name,
      start: int(s.startTime, 'startTime'),
      cursor: int(s.cursorTime, 'cursorTime'),
      trades: history.length,
      balance: typeof acc.balance === 'number' ? acc.balance : 0,
      state: JSON.stringify(s),
    }
  }

  app.get('/api/replays', (c) =>
    c.json({
      items: db
        .prepare('SELECT id, name, start_time, cursor_time, trades, balance, created_at, updated_at FROM replays WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200')
        .all(c.get('user').id),
    }),
  )

  app.post('/api/replays', limitJson, async (c) => {
    const f = replayFields(await json(c))
    const r = db
      .prepare('INSERT INTO replays (user_id, name, start_time, cursor_time, trades, balance, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.get('user').id, f.name, f.start, f.cursor, f.trades, f.balance, f.state, now(), now())
    return c.json({ id: Number(r.lastInsertRowid) }, 201)
  })

  app.put('/api/replays/:id', limitJson, async (c) => {
    const f = replayFields(await json(c))
    const r = db
      .prepare('UPDATE replays SET name = ?, start_time = ?, cursor_time = ?, trades = ?, balance = ?, state_json = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(f.name, f.start, f.cursor, f.trades, f.balance, f.state, now(), idParam(c), c.get('user').id)
    if (!r.changes) throw new HttpError(404, 'Sesi tidak ditemukan.')
    return c.json({ ok: true })
  })

  app.get('/api/replays/:id', (c) => {
    const row = db.prepare('SELECT id, name, state_json FROM replays WHERE id = ? AND user_id = ?').get(idParam(c), c.get('user').id) as
      | { id: number; name: string; state_json: string }
      | undefined
    if (!row) throw new HttpError(404, 'Sesi tidak ditemukan.')
    return c.json({ id: row.id, name: row.name, session: JSON.parse(row.state_json) })
  })

  app.delete('/api/replays/:id', (c) => {
    db.prepare('DELETE FROM replays WHERE id = ? AND user_id = ?').run(idParam(c), c.get('user').id)
    return c.json({ ok: true })
  })

  // ---------- backtests ----------

  app.get('/api/backtests', (c) => {
    const rows = db
      .prepare('SELECT id, name, spec_json, metrics_json, range_from, range_to, created_at FROM backtests WHERE user_id = ? ORDER BY created_at DESC LIMIT 200')
      .all(c.get('user').id) as { id: number; name: string; spec_json: string; metrics_json: string; range_from: number; range_to: number; created_at: number }[]
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        spec: JSON.parse(r.spec_json),
        metrics: JSON.parse(r.metrics_json),
        from: r.range_from,
        to: r.range_to,
        created_at: r.created_at,
      })),
    })
  })

  app.post('/api/backtests', limitJson, async (c) => {
    const b = await json(c)
    const curve = obj(b.curve, 'Kurva')
    if (!Array.isArray(curve.t) || !Array.isArray(curve.v) || curve.t.length > 5000) throw new HttpError(400, 'Kurva tidak valid.')
    const r = db
      .prepare('INSERT INTO backtests (user_id, name, spec_json, metrics_json, curve_json, range_from, range_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        c.get('user').id,
        str(b.name, 'Nama', 80, 1),
        JSON.stringify(obj(b.spec, 'Strategi')),
        JSON.stringify(obj(b.metrics, 'Metrik')),
        JSON.stringify({ t: curve.t, v: curve.v }),
        int(b.from, 'from'),
        int(b.to, 'to'),
        now(),
      )
    return c.json({ id: Number(r.lastInsertRowid) }, 201)
  })

  app.get('/api/backtests/:id', (c) => {
    const r = db.prepare('SELECT * FROM backtests WHERE id = ? AND user_id = ?').get(idParam(c), c.get('user').id) as
      | { id: number; name: string; spec_json: string; metrics_json: string; curve_json: string; range_from: number; range_to: number; created_at: number }
      | undefined
    if (!r) throw new HttpError(404, 'Backtest tidak ditemukan.')
    return c.json({
      id: r.id,
      name: r.name,
      spec: JSON.parse(r.spec_json),
      metrics: JSON.parse(r.metrics_json),
      curve: JSON.parse(r.curve_json),
      from: r.range_from,
      to: r.range_to,
      created_at: r.created_at,
    })
  })

  app.delete('/api/backtests/:id', (c) => {
    db.prepare('DELETE FROM backtests WHERE id = ? AND user_id = ?').run(idParam(c), c.get('user').id)
    return c.json({ ok: true })
  })

  // ---------- journal ----------

  const journalFields = (b: Record<string, unknown>) => {
    const tags = Array.isArray(b.tags) ? b.tags : []
    if (tags.length > 10) throw new HttpError(400, 'Maksimal 10 tag.')
    return {
      setup: str(b.setup ?? '', 'Setup', 40),
      emotion: str(b.emotion ?? '', 'Emosi', 30),
      note: str(b.note ?? '', 'Catatan', 4000),
      tags: JSON.stringify(tags.map((t) => str(t, 'Tag', 30, 1))),
    }
  }

  type JournalRow = {
    id: number
    source: string
    replay_id: number | null
    trade_json: string | null
    setup: string
    emotion: string
    note: string
    tags_json: string
    created_at: number
    updated_at: number
    has_shot: number
  }
  const journalOut = (r: JournalRow) => ({
    id: r.id,
    source: r.source,
    replayId: r.replay_id,
    trade: r.trade_json ? JSON.parse(r.trade_json) : null,
    setup: r.setup,
    emotion: r.emotion,
    note: r.note,
    tags: JSON.parse(r.tags_json),
    hasShot: !!r.has_shot,
    created_at: r.created_at,
    updated_at: r.updated_at,
  })

  app.get('/api/journal', (c) => {
    const rows = db
      .prepare(
        `SELECT j.*, EXISTS(SELECT 1 FROM journal_shots s WHERE s.journal_id = j.id) AS has_shot
         FROM journal j WHERE j.user_id = ? ORDER BY j.created_at DESC, j.id DESC LIMIT 1000`,
      )
      .all(c.get('user').id) as JournalRow[]
    return c.json({ items: rows.map(journalOut) })
  })

  app.post('/api/journal', limitJson, async (c) => {
    const b = await json(c)
    const source = str(b.source, 'Sumber', 20)
    if (!SOURCES.has(source)) throw new HttpError(400, 'Sumber tidak valid.')
    const f = journalFields(b)
    let trade: string | null = null
    if (b.trade !== undefined && b.trade !== null) {
      const t = obj(b.trade, 'Trade')
      if (t.side !== 'buy' && t.side !== 'sell') throw new HttpError(400, 'Arah trade tidak valid.')
      for (const k of ['entry', 'exit', 'pnl', 'lots', 'openTime', 'closeTime']) int(t[k], k)
      trade = JSON.stringify(t)
      if (trade.length > 4000) throw new HttpError(413, 'Data trade terlalu besar.')
    }
    const replayId = b.replayId === undefined || b.replayId === null ? null : int(b.replayId, 'replayId')
    const r = db
      .prepare('INSERT INTO journal (user_id, source, replay_id, trade_json, setup, emotion, note, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.get('user').id, source, replayId, trade, f.setup, f.emotion, f.note, f.tags, now(), now())
    return c.json({ id: Number(r.lastInsertRowid) }, 201)
  })

  app.patch('/api/journal/:id', limitJson, async (c) => {
    const f = journalFields(await json(c))
    const r = db
      .prepare('UPDATE journal SET setup = ?, emotion = ?, note = ?, tags_json = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(f.setup, f.emotion, f.note, f.tags, now(), idParam(c), c.get('user').id)
    if (!r.changes) throw new HttpError(404, 'Jurnal tidak ditemukan.')
    return c.json({ ok: true })
  })

  app.delete('/api/journal/:id', (c) => {
    db.prepare('DELETE FROM journal WHERE id = ? AND user_id = ?').run(idParam(c), c.get('user').id)
    return c.json({ ok: true })
  })

  const ownsEntry = (c: Context<Env>, id: number) => {
    if (!db.prepare('SELECT 1 FROM journal WHERE id = ? AND user_id = ?').get(id, c.get('user').id)) throw new HttpError(404, 'Jurnal tidak ditemukan.')
  }

  app.put(
    '/api/journal/:id/shot',
    bodyLimit({ maxSize: MAX_SHOT, onError: () => { throw new HttpError(413, 'Screenshot maksimal 600 KB.') } }),
    async (c) => {
      const id = idParam(c)
      ownsEntry(c, id)
      const data = new Uint8Array(await c.req.arrayBuffer())
      const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
      const isWebp = String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
      const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      const mime = isPng ? 'image/png' : isWebp ? 'image/webp' : isJpeg ? 'image/jpeg' : null
      if (!mime) throw new HttpError(400, 'Screenshot harus PNG, WebP, atau JPEG.')
      db.prepare('INSERT OR REPLACE INTO journal_shots (journal_id, mime, data) VALUES (?, ?, ?)').run(id, mime, data)
      return c.json({ ok: true })
    },
  )

  app.get('/api/journal/:id/shot', (c) => {
    const id = idParam(c)
    ownsEntry(c, id)
    const s = db.prepare('SELECT mime, data FROM journal_shots WHERE journal_id = ?').get(id) as { mime: string; data: Uint8Array } | undefined
    if (!s) throw new HttpError(404, 'Tidak ada screenshot.')
    return c.body(new Uint8Array(s.data), 200, { 'Content-Type': s.mime, 'Cache-Control': 'private, max-age=86400' })
  })

  const m = opt.market
  mountDuels(app, db, !m ? null : 'of' in m ? m : singleMarket(m), now)
  return app
}
