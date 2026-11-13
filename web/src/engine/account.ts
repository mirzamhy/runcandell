/**
 * Paper-trading engine for XAUUSD. Pure logic, no DOM: shared by bar replay, backtest and duel server.
 *
 * Price model: candles are Bid. Ask = Bid + spread.
 *   Buy opens at Ask, closes at Bid.  Sell opens at Bid, closes at Ask.
 * Bars are processed one M1 candle at a time with OHLC only, so the path inside a bar is unknown:
 *   - if a bar opens beyond a level (gap), the fill is at the open, not the level;
 *   - if SL and TP are both touched inside one bar, SL wins (worst case).
 * Orders placed "now" fill at the close of the last revealed bar and are checked from the next bar on.
 */

export type Side = 'buy' | 'sell'
export type PendingType = 'limit' | 'stop'

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  spread: number
}

export interface Position {
  id: number
  side: Side
  lots: number
  entry: number
  sl: number | null
  tp: number | null
  openTime: number
}

export interface PendingOrder {
  id: number
  side: Side
  type: PendingType
  lots: number
  price: number
  sl: number | null
  tp: number | null
  createdTime: number
}

/** signal/time/end are used by the backtester */
export type CloseReason = 'tp' | 'sl' | 'manual' | 'stopout' | 'signal' | 'time' | 'end'

export interface ClosedTrade {
  id: number
  side: Side
  lots: number
  entry: number
  exit: number
  sl: number | null
  tp: number | null
  openTime: number
  closeTime: number
  pnl: number
  reason: CloseReason
}

export interface AccountConfig {
  balance: number
  leverage: number
  /** ounces per lot */
  contractSize: number
  /** round-turn commission per lot, account currency */
  commissionPerLot: number
  /** close everything when equity / used margin falls below this (0.5 = 50%) */
  stopOutLevel: number
}

export const DEFAULT_CONFIG: AccountConfig = {
  balance: 10_000,
  leverage: 100,
  contractSize: 100,
  commissionPerLot: 0,
  stopOutLevel: 0.5,
}

export type AccountEvent =
  | { kind: 'open'; pos: Position; fromOrder?: PendingOrder }
  | { kind: 'close'; trade: ClosedTrade }
  | { kind: 'cancel'; order: PendingOrder }

export class TradeError extends Error {}

export interface Quote {
  bid: number
  ask: number
  time: number
}

const round2 = (n: number) => Math.round(n * 100) / 100
const LOT_STEP = 0.01

export interface AccountState {
  cfg: AccountConfig
  balance: number
  positions: Position[]
  orders: PendingOrder[]
  history: ClosedTrade[]
  equityCurve: [number, number][]
  nextId: number
  last: Candle | null
}

export class Account {
  balance: number
  positions: Position[] = []
  orders: PendingOrder[] = []
  history: ClosedTrade[] = []
  /** [time, equity] at the close of each processed bar (sampled) */
  equityCurve: [number, number][] = []
  /** last processed candle: the "now" price */
  last: Candle | null = null
  private nextId = 1
  /** the backtester samples equity itself (per strategy bar) */
  recordEquity = true
  onEvent: (e: AccountEvent) => void = () => {}

  readonly cfg: AccountConfig

  // no parameter properties: the duel server runs this file with Node's plain type stripping
  constructor(cfg: AccountConfig = DEFAULT_CONFIG) {
    this.cfg = cfg
    this.balance = cfg.balance
  }

  // ---------- state ----------

  quote(): Quote | null {
    if (!this.last) return null
    return { bid: this.last.close, ask: this.last.close + this.last.spread, time: this.last.time }
  }

  /** Floating P/L of one position at the current quote. */
  positionPnl(p: Position, q = this.quote()): number {
    if (!q) return 0
    const exit = p.side === 'buy' ? q.bid : q.ask
    return this.pnl(p.side, p.entry, exit, p.lots)
  }

  floating(q = this.quote()): number {
    return this.positions.reduce((s, p) => s + this.positionPnl(p, q), 0)
  }

  equity(q = this.quote()): number {
    return this.balance + this.floating(q)
  }

  marginOf(lots: number, price: number): number {
    return (price * this.cfg.contractSize * lots) / this.cfg.leverage
  }

  usedMargin(): number {
    return this.positions.reduce((s, p) => s + this.marginOf(p.lots, p.entry), 0)
  }

  freeMargin(q = this.quote()): number {
    return this.equity(q) - this.usedMargin()
  }

  /** Account-currency P/L for a price move, after commission. */
  pnl(side: Side, entry: number, exit: number, lots: number): number {
    const move = side === 'buy' ? exit - entry : entry - exit
    return move * this.cfg.contractSize * lots - this.cfg.commissionPerLot * lots
  }

  // ---------- validation ----------

  private checkLots(lots: number) {
    if (!(lots >= LOT_STEP) || lots > 100) throw new TradeError('Lot harus 0.01 sampai 100.')
    if (Math.abs(Math.round(lots / LOT_STEP) * LOT_STEP - lots) > 1e-9) throw new TradeError('Lot kelipatan 0.01.')
  }

  /** SL/TP must sit on the correct side of the price the position would close at. */
  private checkLevels(side: Side, ref: number, sl: number | null, tp: number | null) {
    if (side === 'buy') {
      if (sl !== null && sl >= ref) throw new TradeError('SL buy harus di bawah harga.')
      if (tp !== null && tp <= ref) throw new TradeError('TP buy harus di atas harga.')
    } else {
      if (sl !== null && sl <= ref) throw new TradeError('SL sell harus di atas harga.')
      if (tp !== null && tp >= ref) throw new TradeError('TP sell harus di bawah harga.')
    }
  }

  private needQuote(): Quote {
    const q = this.quote()
    if (!q) throw new TradeError('Belum ada harga.')
    return q
  }

  // ---------- actions ----------

  market(side: Side, lots: number, sl: number | null = null, tp: number | null = null): Position {
    this.checkLots(lots)
    const q = this.needQuote()
    const entry = side === 'buy' ? q.ask : q.bid
    this.checkLevels(side, side === 'buy' ? q.bid : q.ask, sl, tp)
    if (this.marginOf(lots, entry) > this.freeMargin(q)) throw new TradeError('Margin tidak cukup.')
    return this.open(side, lots, entry, sl, tp, q.time)
  }

  pending(side: Side, type: PendingType, lots: number, price: number, sl: number | null = null, tp: number | null = null): PendingOrder {
    this.checkLots(lots)
    const q = this.needQuote()
    const now = side === 'buy' ? q.ask : q.bid
    if (!(price > 0)) throw new TradeError('Harga order tidak valid.')
    const below = price < now
    if (side === 'buy' && type === 'limit' && !below) throw new TradeError('Buy limit harus di bawah Ask.')
    if (side === 'buy' && type === 'stop' && below) throw new TradeError('Buy stop harus di atas Ask.')
    if (side === 'sell' && type === 'limit' && below) throw new TradeError('Sell limit harus di atas Bid.')
    if (side === 'sell' && type === 'stop' && !below) throw new TradeError('Sell stop harus di bawah Bid.')
    this.checkLevels(side, price, sl, tp)
    const o: PendingOrder = { id: this.nextId++, side, type, lots, price, sl, tp, createdTime: q.time }
    this.orders.push(o)
    return o
  }

  modifyPosition(id: number, sl: number | null, tp: number | null) {
    const p = this.positions.find((x) => x.id === id)
    if (!p) throw new TradeError('Posisi tidak ditemukan.')
    const q = this.needQuote()
    this.checkLevels(p.side, p.side === 'buy' ? q.bid : q.ask, sl, tp)
    p.sl = sl
    p.tp = tp
  }

  modifyOrder(id: number, price: number, sl: number | null, tp: number | null) {
    const o = this.orders.find((x) => x.id === id)
    if (!o) throw new TradeError('Order tidak ditemukan.')
    const q = this.needQuote()
    const now = o.side === 'buy' ? q.ask : q.bid
    const below = price < now
    const ok =
      (o.side === 'buy' && o.type === 'limit' && below) ||
      (o.side === 'buy' && o.type === 'stop' && !below) ||
      (o.side === 'sell' && o.type === 'limit' && !below) ||
      (o.side === 'sell' && o.type === 'stop' && below)
    if (!ok) throw new TradeError('Harga order di sisi yang salah.')
    this.checkLevels(o.side, price, sl, tp)
    o.price = price
    o.sl = sl
    o.tp = tp
  }

  cancelOrder(id: number) {
    const i = this.orders.findIndex((x) => x.id === id)
    if (i === -1) return
    const [o] = this.orders.splice(i, 1)
    this.onEvent({ kind: 'cancel', order: o })
  }

  closePosition(id: number, reason: CloseReason = 'manual') {
    const p = this.positions.find((x) => x.id === id)
    if (!p) return
    const q = this.needQuote()
    this.close(p, p.side === 'buy' ? q.bid : q.ask, q.time, reason)
  }

  closeAll(reason: CloseReason = 'manual') {
    for (const p of [...this.positions]) this.closePosition(p.id, reason)
  }

  // ---------- bar processing ----------

  /** Advance one candle: trigger pending orders, then SL/TP, then stop-out. */
  onBar(bar: Candle) {
    const askO = bar.open + bar.spread
    const askH = bar.high + bar.spread
    const askL = bar.low + bar.spread

    const filledNow = new Set<number>()
    for (const o of [...this.orders]) {
      let fill: number | null = null
      if (o.side === 'buy' && o.type === 'limit' && askL <= o.price) fill = Math.min(o.price, askO)
      if (o.side === 'buy' && o.type === 'stop' && askH >= o.price) fill = Math.max(o.price, askO)
      if (o.side === 'sell' && o.type === 'limit' && bar.high >= o.price) fill = Math.max(o.price, bar.open)
      if (o.side === 'sell' && o.type === 'stop' && bar.low <= o.price) fill = Math.min(o.price, bar.open)
      if (fill === null) continue
      this.orders.splice(this.orders.indexOf(o), 1)
      filledNow.add(this.open(o.side, o.lots, fill, o.sl, o.tp, bar.time, o).id)
    }

    for (const p of [...this.positions]) {
      // closing price series: Bid for buys, Ask for sells
      const o = p.side === 'buy' ? bar.open : askO
      const h = p.side === 'buy' ? bar.high : askH
      const l = p.side === 'buy' ? bar.low : askL
      const slHit = p.sl !== null && (p.side === 'buy' ? l <= p.sl : h >= p.sl)
      // filled inside this bar: the extreme on the TP side may have come before the fill, so only
      // SL counts (worst case); TP is checked from the next bar
      const tpHit = !filledNow.has(p.id) && p.tp !== null && (p.side === 'buy' ? h >= p.tp : l <= p.tp)
      if (slHit) {
        const px = p.side === 'buy' ? Math.min(p.sl!, o) : Math.max(p.sl!, o)
        this.close(p, px, bar.time, 'sl')
      } else if (tpHit) {
        const px = p.side === 'buy' ? Math.max(p.tp!, o) : Math.min(p.tp!, o)
        this.close(p, px, bar.time, 'tp')
      }
    }

    this.last = bar
    const q = this.quote()!
    const used = this.usedMargin()
    if (used > 0 && this.equity(q) / used < this.cfg.stopOutLevel) this.closeAll('stopout')

    if (!this.recordEquity) return
    const eq = round2(this.equity(q))
    const lastPoint = this.equityCurve[this.equityCurve.length - 1]
    if (!lastPoint || lastPoint[1] !== eq) this.equityCurve.push([bar.time, eq])
  }

  // ---------- internals ----------

  private open(side: Side, lots: number, entry: number, sl: number | null, tp: number | null, time: number, from?: PendingOrder) {
    const pos: Position = { id: from?.id ?? this.nextId++, side, lots, entry, sl, tp, openTime: time }
    this.positions.push(pos)
    this.onEvent({ kind: 'open', pos, fromOrder: from })
    return pos
  }

  private close(p: Position, exit: number, time: number, reason: CloseReason) {
    const pnl = round2(this.pnl(p.side, p.entry, exit, p.lots))
    this.positions.splice(this.positions.indexOf(p), 1)
    this.balance = round2(this.balance + pnl)
    const trade: ClosedTrade = { ...p, exit, closeTime: time, pnl, reason }
    this.history.push(trade)
    this.onEvent({ kind: 'close', trade })
  }

  // ---------- persistence ----------

  toJSON(): AccountState {
    return {
      cfg: this.cfg,
      balance: this.balance,
      positions: this.positions,
      orders: this.orders,
      history: this.history,
      equityCurve: this.equityCurve,
      nextId: this.nextId,
      last: this.last,
    }
  }

  static fromJSON(s: AccountState): Account {
    const a = new Account(s.cfg)
    a.balance = s.balance
    a.positions = s.positions
    a.orders = s.orders
    a.history = s.history
    a.equityCurve = s.equityCurve
    a.nextId = s.nextId
    a.last = s.last
    return a
  }
}

/** Summary statistics over closed trades. */
export function stats(history: ClosedTrade[], startBalance: number) {
  const wins = history.filter((t) => t.pnl > 0)
  const losses = history.filter((t) => t.pnl < 0)
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0)
  let peak = startBalance
  let bal = startBalance
  let maxDd = 0
  for (const t of history) {
    bal += t.pnl
    peak = Math.max(peak, bal)
    maxDd = Math.max(maxDd, (peak - bal) / peak)
  }
  return {
    trades: history.length,
    winRate: history.length ? wins.length / history.length : 0,
    net: round2(grossWin - grossLoss),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,
    maxDrawdown: maxDd,
  }
}
