/**
 * Duel API (async + solo). The server owns everything that decides a round:
 * it picks cuts, sends only candles up to the cut, times the analysis, validates and scores
 * the decision with the shared engine, and only then sends the candles after the cut.
 */
import type { Context, Hono } from 'hono'
import { randomInt } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Bar, TF } from '../../web/src/types.ts'
import {
  DUEL_TFS,
  SNAPSHOT_COUNT,
  TF_SEC,
  checkDecision,
  findCut,
  floorIdx,
  makeNorm,
  minStop,
  normBar,
  normPrice,
  normTime,
  realPrice,
  runDecision,
  snapshotTF,
  type Decision,
  type Norm,
  type Outcome,
} from '../../web/src/engine/duel.ts'
import type { Env } from './app.ts'
import { HttpError, json } from './http.ts'
import type { MarketData, MarketSource } from './market.ts'
import { instrument } from '../../web/src/instruments.ts'

/** seconds of network slack on top of the analysis timer */
export const GRACE = 5
const DAY = 86400
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

interface DuelRow {
  id: number
  code: string
  mode: 'solo' | 'async'
  rounds: number
  analysis_sec: number
  run_minutes: number
  hardcore: number
  pair: string
  status: 'open' | 'done'
  created_by: number
  created_at: number
}
interface RoundRow {
  round_no: number
  cut_time: number
  k: number
  symbol: string
}
interface DecisionRow {
  round_no: number
  user_id: number
  sent_at: number
  submitted_at: number | null
  side: string | null
  sl: number | null
  tp: number | null
  entry: number | null
  exit: number | null
  exit_time: number | null
  reason: string | null
  r: number | null
  order_type: string | null
  order_price: number | null
}

const pick = <T extends readonly unknown[]>(v: unknown, allowed: T, field: string): T[number] => {
  if (!allowed.includes(v)) throw new HttpError(400, `Invalid ${field.toLowerCase()}.`)
  return v as T[number]
}

export function mountDuels(app: Hono<Env>, db: DatabaseSync, source: MarketSource | null, now: () => number) {
  const needSource = (): MarketSource => {
    if (!source) throw new HttpError(503, 'Candle data is not available on the server yet.')
    return source
  }
  const needMarket = (symbol: string): MarketData => needSource().of(symbol)

  const duelByCode = (code: string): DuelRow => {
    const d = db.prepare('SELECT * FROM duels WHERE code = ?').get(code.toUpperCase()) as DuelRow | undefined
    if (!d) throw new HttpError(404, 'Duel not found.')
    return d
  }
  const players = (duelId: number) =>
    db
      .prepare('SELECT p.user_id, u.nickname, p.finished_at, p.total_r FROM duel_players p JOIN users u ON u.id = p.user_id WHERE p.duel_id = ? ORDER BY p.joined_at')
      .all(duelId) as { user_id: number; nickname: string; finished_at: number | null; total_r: number | null }[]
  const isMember = (duelId: number, userId: number) => !!db.prepare('SELECT 1 FROM duel_players WHERE duel_id = ? AND user_id = ?').get(duelId, userId)
  const roundOf = (duelId: number, n: number) => {
    const r = db.prepare('SELECT round_no, cut_time, k, symbol FROM duel_rounds WHERE duel_id = ? AND round_no = ?').get(duelId, n) as RoundRow | undefined
    if (!r) throw new HttpError(404, 'Round not found.')
    return r
  }
  const decisions = (duelId: number, userId?: number) =>
    (userId === undefined
      ? db.prepare('SELECT * FROM duel_decisions WHERE duel_id = ? ORDER BY round_no').all(duelId)
      : db.prepare('SELECT * FROM duel_decisions WHERE duel_id = ? AND user_id = ? ORDER BY round_no').all(duelId, userId)) as unknown as DecisionRow[]
  /** next round to play, or null when finished */
  const currentRound = (d: DuelRow, userId: number) => {
    const done = decisions(d.id, userId).filter((x) => x.side !== null).length
    return done < d.rounds ? done + 1 : null
  }

  /** Mark the duel done once every player finished (solo: 1 player, async: 2). */
  const settle = (d: DuelRow) => {
    const ps = players(d.id)
    const need = d.mode === 'solo' ? 1 : 2
    if (ps.length >= need && ps.every((p) => p.finished_at !== null)) db.prepare("UPDATE duels SET status = 'done' WHERE id = ?").run(d.id)
  }

  const store = (d: DuelRow, userId: number, n: number, o: Outcome, timeout: boolean) => {
    db.prepare(
      'UPDATE duel_decisions SET submitted_at = ?, side = ?, sl = ?, tp = ?, entry = ?, exit = ?, exit_time = ?, reason = ?, r = ?, order_type = ?, order_price = ? WHERE duel_id = ? AND round_no = ? AND user_id = ?',
    ).run(now(), o.side, o.sl, o.tp, o.entry, o.exit, o.exitTime, timeout ? 'timeout' : o.reason, o.r, o.type ?? null, o.price ?? null, d.id, n, userId)
    if (n === d.rounds) {
      const total = decisions(d.id, userId).reduce((s, x) => s + (x.r ?? 0), 0)
      db.prepare('UPDATE duel_players SET finished_at = ?, total_r = ? WHERE duel_id = ? AND user_id = ?').run(now(), Math.round(total * 1000) / 1000, d.id, userId)
      settle(d)
    }
  }

  const SKIP: Outcome = { side: 'skip', r: 0, reason: 'skip', entry: null, exit: null, exitTime: null, sl: null, tp: null }

  /** Rounds whose analysis time ran out without a decision become skips. */
  const sweep = (d: DuelRow, userId: number) => {
    for (const x of decisions(d.id, userId))
      if (x.side === null && now() > x.sent_at + d.analysis_sec + GRACE) store(d, userId, x.round_no, SKIP, true)
  }

  // ---------- market helpers ----------

  /** Cuts for every round; `pool` = instruments to draw from (one each round, at random). */
  async function pickRounds(src: MarketSource, pool: string[], count: number, runMinutes: number): Promise<{ symbol: string; cut: number; k: number }[]> {
    const spans = new Map<string, { from: number; to: number }>()
    const out: { symbol: string; cut: number; k: number }[] = []
    for (let tries = 0; out.length < count && tries < count * 40; tries++) {
      const symbol = pool[randomInt(0, pool.length)]
      const m = src.of(symbol)
      if (!spans.has(symbol)) spans.set(symbol, await m.span())
      const span = spans.get(symbol)!
      const lo = span.from + 45 * DAY // enough history for H4/D1 context
      const hi = span.to - 2 * DAY - runMinutes * 60
      if (hi <= lo) continue
      const t = lo + randomInt(0, hi - lo)
      const m1 = await m.bars('M1', t, t + 3 * DAY)
      if (m1.length < runMinutes + 2) continue
      const i = findCut(m1, randomInt(0, Math.max(1, Math.min(m1.length - runMinutes - 1, 1440))), runMinutes)
      if (i < 0) continue
      const cut = m1[i].time
      if (out.some((x) => x.symbol === symbol && Math.abs(x.cut - cut) < DAY)) continue
      out.push({ symbol, cut, k: Math.round((0.7 + randomInt(0, 701) / 1000) * 1000) / 1000 })
    }
    if (out.length < count) throw new HttpError(503, 'Could not pick chart slices. Try again.')
    return out
  }

  async function cutContext(m: MarketData, r: RoundRow) {
    const m1 = await m.bars('M1', r.cut_time - 5 * DAY, r.cut_time + 1)
    const i = floorIdx(m1, r.cut_time)
    if (i < 0 || m1[i].time !== r.cut_time) throw new HttpError(503, 'The slice candle was not found.')
    // every pair moves on screen about like gold: k x the instrument's scale
    return { m1, cut: m1[i], norm: makeNorm(m1[i], r.k * instrument(r.symbol).duelScale) }
  }

  async function future(m: MarketData, r: RoundRow, runMinutes: number) {
    return (await m.bars('M1', r.cut_time + 1, r.cut_time + runMinutes * 60 * 2 + 3600)).slice(0, runMinutes)
  }

  const outcomeOut = (n: Norm, o: Outcome) => ({
    side: o.side,
    type: o.type ?? 'market',
    price: o.price === null || o.price === undefined ? null : normPrice(n, o.price),
    r: o.r,
    reason: o.reason,
    entry: o.entry === null ? null : normPrice(n, o.entry),
    exit: o.exit === null ? null : normPrice(n, o.exit),
    exitTime: o.exitTime === null ? null : normTime(n, o.exitTime),
    sl: o.sl === null ? null : normPrice(n, o.sl),
    tp: o.tp === null ? null : normPrice(n, o.tp),
  })
  const rowOutcome = (x: DecisionRow): Outcome => ({
    side: (x.side ?? 'skip') as Outcome['side'],
    type: (x.order_type ?? 'market') as Outcome['type'],
    price: x.order_price,
    r: x.r ?? 0,
    reason: (x.reason ?? 'skip') as Outcome['reason'],
    entry: x.entry,
    exit: x.exit,
    exitTime: x.exit_time,
    sl: x.sl,
    tp: x.tp,
  })

  // ---------- routes ----------

  app.post('/api/duels', async (c) => {
    const b = await json(c)
    const mode = pick(b.mode, ['solo', 'async'] as const, 'Mode')
    const rounds = pick(b.rounds, [1, 3, 5, 7, 10] as const, 'Round count')
    // analysis modes: Kilat 60 s, Normal 180 s, Mendalam 600 s (older values still accepted)
    const analysisSec = pick(b.analysisSec, [30, 60, 90, 120, 180, 300, 600] as const, 'Analysis time')
    // the result always runs one day after the decision, the same for everyone
    const runMinutes = b.runMinutes === undefined ? 1440 : pick(b.runMinutes, [30, 60, 90, 120, 240, 1440] as const, 'Run window')
    const hardcore = b.hardcore === true
    const src = needSource()
    const available = await src.symbols()
    const pair = b.pair === undefined || b.pair === 'random' ? 'random' : pick(b.pair, available, 'Pair')
    const chosen = await pickRounds(src, pair === 'random' ? available : [pair], rounds, runMinutes)
    let code = ''
    for (let i = 0; i < 8; i++) code += CODE_CHARS[randomInt(0, CODE_CHARS.length)]
    const user = c.get('user')
    db.exec('BEGIN')
    try {
      const r = db
        .prepare("INSERT INTO duels (code, mode, rounds, analysis_sec, run_minutes, hardcore, pair, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
        .run(code, mode, rounds, analysisSec, runMinutes, hardcore ? 1 : 0, pair, user.id, now())
      const id = Number(r.lastInsertRowid)
      chosen.forEach((x, i) => db.prepare('INSERT INTO duel_rounds (duel_id, round_no, cut_time, k, symbol) VALUES (?, ?, ?, ?, ?)').run(id, i + 1, x.cut, x.k, x.symbol))
      db.prepare('INSERT INTO duel_players (duel_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, user.id, now())
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return c.json({ code }, 201)
  })

  app.get('/api/duels', (c) => {
    const user = c.get('user')
    const rows = db
      .prepare('SELECT d.* FROM duels d JOIN duel_players p ON p.duel_id = d.id WHERE p.user_id = ? ORDER BY d.created_at DESC LIMIT 100')
      .all(user.id) as unknown as DuelRow[]
    return c.json({
      items: rows.map((d) => {
        sweep(d, user.id)
        const ps = players(d.id)
        const fresh = db.prepare('SELECT status FROM duels WHERE id = ?').get(d.id) as { status: string }
        return {
          code: d.code,
          mode: d.mode,
          rounds: d.rounds,
          status: fresh.status,
          created_at: d.created_at,
          nextRound: currentRound(d, user.id),
          players: ps.map((p) => ({
            nickname: p.nickname,
            finished: p.finished_at !== null,
            totalR: fresh.status === 'done' || p.user_id === user.id ? p.total_r : null,
          })),
        }
      }),
    })
  })

  app.get('/api/duels/:code', (c) => {
    const user = c.get('user')
    const d = duelByCode(c.req.param('code'))
    const params = { code: d.code, mode: d.mode, rounds: d.rounds, analysisSec: d.analysis_sec, runMinutes: d.run_minutes, hardcore: !!d.hardcore, pair: d.pair }
    const member = isMember(d.id, user.id)
    const ps = players(d.id)
    if (!member) {
      const joinable = d.mode === 'async' && ps.length < 2
      return c.json({ ...params, member: false, joinable, players: ps.map((p) => ({ nickname: p.nickname })) })
    }
    sweep(d, user.id)
    const status = (db.prepare('SELECT status FROM duels WHERE id = ?').get(d.id) as { status: string }).status
    const done = status === 'done'
    const rounds = (db.prepare('SELECT round_no, cut_time, k, symbol FROM duel_rounds WHERE duel_id = ? ORDER BY round_no').all(d.id) as unknown as RoundRow[]).map((r) => {
      const all = decisions(d.id).filter((x) => x.round_no === r.round_no && x.side !== null)
      const visible = done ? all : all.filter((x) => x.user_id === user.id)
      return {
        round: r.round_no,
        // the real date and scale are revealed only after the duel is over
        realTime: done ? r.cut_time : null,
        k: done ? r.k : null,
        symbol: done ? r.symbol : null,
        results: visible.map((x) => ({ nickname: ps.find((p) => p.user_id === x.user_id)?.nickname ?? '?', side: x.side, r: x.r, reason: x.reason })),
      }
    })
    return c.json({
      ...params,
      member: true,
      status,
      nextRound: currentRound(d, user.id),
      players: players(d.id).map((p) => ({ nickname: p.nickname, finished: p.finished_at !== null, totalR: done || p.user_id === user.id ? p.total_r : null })),
      rounds,
    })
  })

  app.post('/api/duels/:code/join', (c) => {
    const user = c.get('user')
    const d = duelByCode(c.req.param('code'))
    if (isMember(d.id, user.id)) return c.json({ ok: true })
    if (d.mode !== 'async' || players(d.id).length >= 2) throw new HttpError(409, 'This duel is full.')
    db.prepare('INSERT INTO duel_players (duel_id, user_id, joined_at) VALUES (?, ?, ?)').run(d.id, user.id, now())
    return c.json({ ok: true })
  })

  const roundParam = (c: Context) => {
    const n = Number(c.req.param('n'))
    if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'Round not found.')
    return n
  }

  app.post('/api/duels/:code/rounds/:n/start', async (c) => {
    const user = c.get('user')
    const d = duelByCode(c.req.param('code'))
    if (!isMember(d.id, user.id)) throw new HttpError(403, 'You are not a player in this duel.')
    const n = roundParam(c)
    sweep(d, user.id)
    const next = currentRound(d, user.id)
    if (next !== n) throw new HttpError(409, next === null ? 'The duel is finished.' : `Round ${next} is next.`)
    const r = roundOf(d.id, n)
    const m = needMarket(r.symbol)
    let row = db.prepare('SELECT * FROM duel_decisions WHERE duel_id = ? AND round_no = ? AND user_id = ?').get(d.id, n, user.id) as DecisionRow | undefined
    if (!row) {
      db.prepare('INSERT INTO duel_decisions (duel_id, round_no, user_id, sent_at) VALUES (?, ?, ?, ?)').run(d.id, n, user.id, now())
      row = db.prepare('SELECT * FROM duel_decisions WHERE duel_id = ? AND round_no = ? AND user_id = ?').get(d.id, n, user.id) as unknown as DecisionRow
    }
    const { m1, cut, norm } = await cutContext(m, r)
    const bars: Partial<Record<TF, Bar[]>> = {}
    for (const tf of DUEL_TFS) {
      const count = SNAPSHOT_COUNT[tf]
      const src = tf === 'M1' ? [] : await m.bars(tf, r.cut_time - count * TF_SEC[tf] * 2 - 5 * DAY, r.cut_time + 1)
      bars[tf] = snapshotTF(src, m1, r.cut_time, count, tf === 'M1').map((b) => normBar(norm, b))
    }
    return c.json({
      round: n,
      rounds: d.rounds,
      analysisSec: d.analysis_sec,
      runMinutes: d.run_minutes,
      hardcore: !!d.hardcore,
      remaining: Math.max(0, row.sent_at + d.analysis_sec - now()),
      minStop: Math.round(minStop(m1.slice(0, floorIdx(m1, r.cut_time) + 1)) * norm.k * 1000) / 1000,
      cut: normBar(norm, cut),
      bars,
    })
  })

  app.post('/api/duels/:code/rounds/:n/decide', async (c) => {
    const user = c.get('user')
    const d = duelByCode(c.req.param('code'))
    if (!isMember(d.id, user.id)) throw new HttpError(403, 'You are not a player in this duel.')
    const n = roundParam(c)
    const row = db.prepare('SELECT * FROM duel_decisions WHERE duel_id = ? AND round_no = ? AND user_id = ?').get(d.id, n, user.id) as DecisionRow | undefined
    if (!row) throw new HttpError(409, 'The round has not started.')
    const r = roundOf(d.id, n)
    const m = needMarket(r.symbol)
    const { m1, cut, norm } = await cutContext(m, r)

    let outcome: Outcome
    let timeout = false
    if (row.side !== null) outcome = rowOutcome(row)
    else {
      const b = await json(c)
      const side = pick(b.side, ['buy', 'sell', 'skip'] as const, 'Decision')
      const late = now() > row.sent_at + d.analysis_sec + GRACE
      if (late) {
        outcome = SKIP
        timeout = true
      } else {
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? realPrice(norm, v) : null)
        const type = b.type === undefined ? 'market' : pick(b.type, ['market', 'limit', 'stop'] as const, 'Order type')
        const dec: Decision = { side, type, price: type === 'market' ? null : num(b.price), sl: num(b.sl), tp: b.tp === null || b.tp === undefined ? null : num(b.tp) }
        const stop = minStop(m1.slice(0, floorIdx(m1, r.cut_time) + 1))
        const err = checkDecision(dec, cut, stop, (x) => (x * norm.k).toFixed(2))
        if (err) throw new HttpError(400, err)
        outcome = runDecision(cut, await future(m, r, d.run_minutes), dec)
      }
      store(d, user.id, n, outcome, timeout)
    }

    // only now: the candles after the cut, plus where each timeframe starts a new candle
    const fut = await future(m, r, d.run_minutes)
    const end = fut.length ? fut[fut.length - 1].time : r.cut_time
    const breaks: Partial<Record<TF, number[]>> = {}
    for (const tf of DUEL_TFS) {
      if (tf === 'M1') continue
      breaks[tf] = (await m.bars(tf, r.cut_time + 1, end + 1)).map((b) => normTime(norm, b.time))
    }
    const me = db.prepare('SELECT finished_at, total_r FROM duel_players WHERE duel_id = ? AND user_id = ?').get(d.id, user.id) as {
      finished_at: number | null
      total_r: number | null
    }
    return c.json({
      outcome: { ...outcomeOut(norm, outcome), reason: timeout ? 'timeout' : (row.reason ?? outcome.reason) },
      future: fut.map((b) => normBar(norm, b)),
      breaks,
      finished: me.finished_at !== null,
      totalR: me.total_r,
      // the pair is revealed once you have decided
      symbol: r.symbol,
    })
  })

  /**
   * Dashboard numbers. The weekly board counts only duels that are over (both players done),
   * so an opponent's hidden result never leaks through a total.
   */
  app.get('/api/stats', (c) => {
    const user = c.get('user')
    const since = now() - 7 * DAY
    const board = db
      .prepare(
        `SELECT u.id, u.nickname, COUNT(*) AS duels, ROUND(SUM(p.total_r), 2) AS total_r
         FROM duel_players p JOIN duels d ON d.id = p.duel_id JOIN users u ON u.id = p.user_id
         WHERE d.status = 'done' AND p.finished_at >= ?
         GROUP BY u.id ORDER BY total_r DESC, duels DESC, u.nickname LIMIT 100`,
      )
      .all(since) as { id: number; nickname: string; duels: number; total_r: number }[]
    const mine = db
      .prepare('SELECT COUNT(*) AS duels, ROUND(COALESCE(SUM(total_r), 0), 2) AS total_r FROM duel_players WHERE user_id = ? AND finished_at IS NOT NULL')
      .get(user.id) as { duels: number; total_r: number }
    const trades = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(r > 0), 0) AS wins FROM duel_decisions WHERE user_id = ? AND side IN ('buy', 'sell')")
      .get(user.id) as { n: number; wins: number }
    const rank = board.findIndex((x) => x.id === user.id)
    return c.json({
      me: {
        totalR: mine.total_r,
        duels: mine.duels,
        trades: trades.n,
        winRate: trades.n ? trades.wins / trades.n : null,
        rank: rank >= 0 ? rank + 1 : null,
        weekR: rank >= 0 ? board[rank].total_r : null,
      },
      board: board.slice(0, 10).map((x, i) => ({ rank: i + 1, nickname: x.nickname, duels: x.duels, totalR: x.total_r, me: x.id === user.id })),
    })
  })
}
