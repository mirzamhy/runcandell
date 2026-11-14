/** Client for the runcandell API (server/). Same origin: dev goes through the Vite proxy. */

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-RC': '1' }
  let payload: BodyInit | undefined
  if (body instanceof Blob) payload = body
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'Server akun tidak bisa dihubungi.')
  }
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('json')) {
    if (!res.ok) throw new ApiError(res.status, res.status >= 500 ? 'Server akun tidak bisa dihubungi.' : `HTTP ${res.status}`)
    return (await res.blob()) as T
  }
  const data = await res.json()
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`)
  return data as T
}

export interface User {
  id: number
  nickname: string
}

export interface ReplayItem {
  id: number
  name: string
  start_time: number
  cursor_time: number
  trades: number
  balance: number
  updated_at: number
}

export interface BacktestItem {
  id: number
  name: string
  spec: unknown
  metrics: { net: number; trades: number; winRate: number; profitFactor: number; maxDdPct: number }
  from: number
  to: number
  created_at: number
}

export interface JournalTrade {
  side: 'buy' | 'sell'
  lots: number
  entry: number
  exit: number
  sl: number | null
  tp: number | null
  pnl: number
  r: number | null
  reason: string
  openTime: number
  closeTime: number
}

export interface JournalEntry {
  id: number
  source: 'replay' | 'backtest' | 'manual'
  replayId: number | null
  trade: JournalTrade | null
  setup: string
  emotion: string
  note: string
  tags: string[]
  hasShot: boolean
  created_at: number
}

export type JournalInput = Pick<JournalEntry, 'setup' | 'emotion' | 'note' | 'tags'> & {
  source: JournalEntry['source']
  trade?: JournalTrade | null
  replayId?: number | null
}

export const api = {
  me: () => call<{ user: User }>('GET', '/me'),
  guest: (nickname: string) => call<{ user: User; recoveryCode: string }>('POST', '/auth/guest', { nickname }),
  recover: (code: string) => call<{ user: User }>('POST', '/auth/recover', { code }),
  logout: () => call<{ ok: true }>('POST', '/auth/logout'),
  newRecovery: () => call<{ recoveryCode: string }>('POST', '/me/recovery'),

  replays: () => call<{ items: ReplayItem[] }>('GET', '/replays'),
  replay: (id: number) => call<{ id: number; name: string; session: unknown }>('GET', `/replays/${id}`),
  saveReplay: (name: string, session: unknown, id?: number) =>
    id ? call<{ ok: true }>('PUT', `/replays/${id}`, { name, session }).then(() => ({ id })) : call<{ id: number }>('POST', '/replays', { name, session }),
  deleteReplay: (id: number) => call('DELETE', `/replays/${id}`),

  backtests: () => call<{ items: BacktestItem[] }>('GET', '/backtests'),
  backtest: (id: number) => call<BacktestItem & { curve: { t: number[]; v: number[] } }>('GET', `/backtests/${id}`),
  saveBacktest: (b: { name: string; spec: unknown; metrics: unknown; curve: unknown; from: number; to: number }) => call<{ id: number }>('POST', '/backtests', b),
  deleteBacktest: (id: number) => call('DELETE', `/backtests/${id}`),

  journal: () => call<{ items: JournalEntry[] }>('GET', '/journal'),
  addJournal: (e: JournalInput) => call<{ id: number }>('POST', '/journal', e),
  updateJournal: (id: number, e: Pick<JournalEntry, 'setup' | 'emotion' | 'note' | 'tags'>) => call('PATCH', `/journal/${id}`, e),
  deleteJournal: (id: number) => call('DELETE', `/journal/${id}`),
  uploadShot: (id: number, img: Blob) => call('PUT', `/journal/${id}/shot`, img),
  shotUrl: (id: number) => `/api/journal/${id}/shot`,
}

// ---------- duel (F6) ----------

export interface DuelParams {
  mode: 'solo' | 'async'
  rounds: number
  analysisSec: number
  runMinutes: number
  hardcore: boolean
}

export interface DuelPlayer {
  nickname: string
  finished?: boolean
  totalR?: number | null
}

/** GET /duels/:code. `rounds` is a number for non-members, the per-round results for members. */
export interface DuelDetail extends Omit<DuelParams, 'rounds'> {
  code: string
  member: boolean
  joinable?: boolean
  status?: 'open' | 'done'
  nextRound?: number | null
  players: DuelPlayer[]
  rounds: number | DuelRoundResult[]
}

export interface DuelRoundResult {
  round: number
  realTime: number | null
  k: number | null
  results: { nickname: string; side: string; r: number; reason: string }[]
}

export interface DuelListItem {
  code: string
  mode: 'solo' | 'async'
  rounds: number
  status: 'open' | 'done'
  created_at: number
  nextRound: number | null
  players: DuelPlayer[]
}

export interface Snapshot {
  round: number
  rounds: number
  analysisSec: number
  runMinutes: number
  hardcore: boolean
  remaining: number
  minStop: number
  cut: import('./types').Bar
  bars: Record<import('./types').TF, import('./types').Bar[]>
}

export interface DuelOutcome {
  side: 'buy' | 'sell' | 'skip'
  type?: 'market' | 'limit' | 'stop'
  /** order price for limit/stop */
  price?: number | null
  r: number
  reason: string
  entry: number | null
  exit: number | null
  exitTime: number | null
  sl: number | null
  tp: number | null
}

export interface DecideResult {
  outcome: DuelOutcome
  future: import('./types').Bar[]
  breaks: Partial<Record<import('./types').TF, number[]>>
  finished: boolean
  totalR: number | null
}

export const duelApi = {
  create: (p: DuelParams) => call<{ code: string }>('POST', '/duels', p),
  list: () => call<{ items: DuelListItem[] }>('GET', '/duels'),
  get: (code: string) => call<DuelDetail>('GET', `/duels/${encodeURIComponent(code)}`),
  join: (code: string) => call<{ ok: true }>('POST', `/duels/${encodeURIComponent(code)}/join`),
  start: (code: string, n: number) => call<Snapshot>('POST', `/duels/${encodeURIComponent(code)}/rounds/${n}/start`),
  decide: (code: string, n: number, d: { side: 'buy' | 'sell' | 'skip'; type?: 'market' | 'limit' | 'stop'; price?: number | null; sl?: number | null; tp?: number | null }) =>
    call<DecideResult>('POST', `/duels/${encodeURIComponent(code)}/rounds/${n}/decide`, d),
}

export interface Stats {
  me: { totalR: number; duels: number; trades: number; winRate: number | null; rank: number | null; weekR: number | null }
  board: { rank: number; nickname: string; duels: number; totalR: number; me: boolean }[]
}
export const statsApi = { get: () => call<Stats>('GET', '/stats') }
