import {
  LineStyle,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import { openMenu, type MenuItem } from './ctxmenu'
import { TradeError, stats, type Account, type AccountEvent, type PendingType, type Side, type ClosedTrade } from './engine/account'
import { px, pxStep } from './current'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const fmtMoney = (n: number, sign = false) => (sign && n > 0 ? '+' : '') + money.format(n)
const fmtPx = (n: number | null) => (n === null ? '–' : px(n))
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const COLORS = { buy: '#4c8dff', sell: '#ef5350', sl: '#ef5350', tp: '#26a69a', pending: '#f5a524' }
const REASON: Record<string, string> = { tp: 'TP', sl: 'SL', manual: 'Manual', stopout: 'Stop-out', signal: 'Signal', time: 'Time', end: 'End of data' }

// ---------- toast ----------

let toastHost: HTMLElement | null = null

export function toast(msg: string, kind: 'info' | 'good' | 'bad' = 'info') {
  if (!toastHost) {
    toastHost = document.createElement('div')
    toastHost.className = 'toasts'
    toastHost.setAttribute('role', 'status')
    toastHost.setAttribute('aria-live', 'polite')
    document.body.append(toastHost)
  }
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = msg
  toastHost.append(el)
  setTimeout(() => el.remove(), 3200)
}

// ---------- order lines on the chart (draggable, MT5 style) ----------

/** `${kind}:${id}`; kinds: entry, sl, tp (positions), order, osl, otp (pending), tk (ticket preview), new (SL/TP being pulled out) */
type LineKey = string
type DragKind = 'entry' | 'sl' | 'tp' | 'order' | 'osl' | 'otp' | 'tk'

interface DragState {
  key: LineKey
  id: number
  kind: DragKind
  /** ticket preview field when kind = tk */
  field?: 'price' | 'sl' | 'tp'
  startY: number
  moved: boolean
}

export interface TicketPreview {
  price: number | null
  sl: number | null
  tp: number | null
}

const HIT_Y = 8
const HIT_TOUCH = 18
/** on touch a line is grabbed only this close to the price axis; a swipe anywhere else pans the chart */
const GRAB_TOUCH_PX = 90
const TOUCH = matchMedia('(pointer: coarse)').matches
const ARM_PX = 4

class OrderLines {
  private lines = new Map<LineKey, IPriceLine>()
  private drag: DragState | null = null
  /** a touch that landed on a line away from its handle: a quick tap still opens the line's menu */
  private tap: { kind: DragKind; id: number; x: number; y: number; t: number; pointer: number } | null = null
  private readonly chart: IChartApi
  private readonly series: ISeriesApi<'Candlestick'>
  private readonly host: HTMLElement
  private readonly getAccount: () => Account | null
  private readonly onModified: () => void
  /** a click (no drag) on a position or order line */
  onClick: (kind: 'entry' | 'order', id: number, clientX: number, clientY: number) => void = () => {}
  getTicket: () => TicketPreview | null = () => null
  setTicket: (field: 'price' | 'sl' | 'tp', v: number) => void = () => {}

  constructor(chart: IChartApi, series: ISeriesApi<'Candlestick'>, host: HTMLElement, getAccount: () => Account | null, onModified: () => void) {
    this.chart = chart
    this.series = series
    this.host = host
    this.getAccount = getAccount
    this.onModified = onModified
    host.addEventListener('pointerdown', (e) => this.down(e), true)
    host.addEventListener('pointermove', (e) => this.move(e), true)
    host.addEventListener('pointerup', (e) => this.up(e), true)
    host.addEventListener('pointercancel', (e) => this.cancel(e), true)
  }

  clear() {
    for (const l of this.lines.values()) this.series.removePriceLine(l)
    this.lines.clear()
  }

  sync() {
    const acc = this.getAccount()
    const want = new Map<LineKey, Parameters<ISeriesApi<'Candlestick'>['createPriceLine']>[0]>()
    if (acc) {
      for (const p of acc.positions) {
        const pnl = acc.positionPnl(p)
        want.set(`entry:${p.id}`, {
          price: p.entry,
          color: COLORS[p.side],
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `${p.side.toUpperCase()} ${p.lots.toFixed(2)}  ${fmtMoney(pnl, true)}`,
        })
        if (p.sl !== null) {
          const risk = acc.pnl(p.side, p.entry, p.sl, p.lots)
          want.set(`sl:${p.id}`, { price: p.sl, color: COLORS.sl, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `SL ${fmtMoney(risk, true)}` })
        }
        if (p.tp !== null) {
          const gain = acc.pnl(p.side, p.entry, p.tp, p.lots)
          want.set(`tp:${p.id}`, { price: p.tp, color: COLORS.tp, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `TP ${fmtMoney(gain, true)}` })
        }
      }
      for (const o of acc.orders) {
        want.set(`order:${o.id}`, {
          price: o.price,
          color: COLORS.pending,
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.lots.toFixed(2)}`,
        })
        if (o.sl !== null) want.set(`osl:${o.id}`, { price: o.sl, color: COLORS.sl, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'SL order' })
        if (o.tp !== null) want.set(`otp:${o.id}`, { price: o.tp, color: COLORS.tp, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'TP order' })
      }
      // ticket preview: the pending price and SL/TP typed in the ticket, draggable before the order exists
      const tk = this.getTicket()
      const tkLine = (field: 'price' | 'sl' | 'tp', v: number | null, color: string, title: string) => {
        if (v !== null && Number.isFinite(v)) want.set(`tk:${field}`, { price: v, color, lineWidth: 1, lineStyle: LineStyle.LargeDashed, axisLabelVisible: true, title })
      }
      if (tk) {
        tkLine('price', tk.price, COLORS.pending, 'Order price (drag)')
        tkLine('sl', tk.sl, COLORS.sl, 'Ticket SL (drag)')
        tkLine('tp', tk.tp, COLORS.tp, 'Ticket TP (drag)')
      }
    }
    for (const [k, l] of this.lines) {
      if (!want.has(k) && !k.startsWith('new:')) {
        this.series.removePriceLine(l)
        this.lines.delete(k)
      }
    }
    for (const [k, opts] of want) {
      if (this.drag?.key === k && this.drag.kind !== 'entry') continue // keep the price the user is dragging
      const l = this.lines.get(k)
      if (l) l.applyOptions(opts)
      else this.lines.set(k, this.series.createPriceLine(opts))
    }
  }

  private local(e: PointerEvent) {
    const r = this.host.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private hit(x: number, y: number, slop = HIT_Y): Omit<DragState, 'startY' | 'moved'> | null {
    // the price-axis label counts too: it is the easiest thing to grab
    if (x > this.host.clientWidth || y > this.chart.panes()[0].getHeight()) return null
    let best: { key: LineKey; d: number } | null = null
    for (const [key, line] of this.lines) {
      if (key.startsWith('new:')) continue
      const ly = this.series.priceToCoordinate(line.options().price)
      if (ly === null) continue
      const d = Math.abs(ly - y)
      // SL/TP can sit on the entry: prefer them
      const bias = key.startsWith('entry:') ? 1.5 : 0
      if (d <= slop && (!best || d + bias < best.d)) best = { key, d: d + bias }
    }
    if (!best) return null
    const [kind, id] = best.key.split(':')
    if (kind === 'tk') return { key: best.key, id: 0, kind: 'tk', field: id as DragState['field'] }
    return { key: best.key, id: Number(id), kind: kind as DragKind }
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 || !this.getAccount()) return
    const { x, y } = this.local(e)
    // a fingertip is far less precise than a mouse pointer
    const touch = e.pointerType === 'touch'
    const h = this.hit(x, y, touch ? HIT_TOUCH : HIT_Y)
    this.tap = null
    if (!h) return
    if (touch && x < this.chart.timeScale().width() - GRAB_TOUCH_PX) {
      // leave the gesture to the chart so it can pan; remember the line in case this is just a tap
      this.tap = { kind: h.kind, id: h.id, x: e.clientX, y: e.clientY, t: e.timeStamp, pointer: e.pointerId }
      return
    }
    e.stopPropagation()
    e.preventDefault()
    this.drag = { ...h, startY: y, moved: false }
    try {
      this.host.setPointerCapture(e.pointerId)
    } catch {
      // the pointer already lifted (a very quick tap): the drag still works without capture
    }
    this.chart.applyOptions({ handleScroll: false, handleScale: false })
  }

  private move(e: PointerEvent) {
    const { x, y } = this.local(e)
    const d = this.drag
    const tp = this.tap
    if (tp && e.pointerId === tp.pointer && Math.hypot(e.clientX - tp.x, e.clientY - tp.y) > 10) this.tap = null
    if (!d) {
      if (e.pointerType === 'touch') return
      const h = this.getAccount() ? this.hit(x, y) : null
      if (h) this.host.style.cursor = 'ns-resize'
      else if (this.host.style.cursor === 'ns-resize') this.host.style.cursor = ''
      return
    }
    e.stopPropagation()
    if (!d.moved && Math.abs(y - d.startY) < ARM_PX) return
    d.moved = true
    const raw = this.series.coordinateToPrice(y)
    if (raw === null) return
    const price = Math.round(raw * 100) / 100
    const acc = this.getAccount()!
    if (d.kind === 'entry') {
      // pulling a position line out makes a TP (towards profit) or an SL (towards loss)
      const p = acc.positions.find((q) => q.id === d.id)
      if (!p) return
      const pnl = acc.pnl(p.side, p.entry, price, p.lots)
      const isTp = pnl > 0
      const opts = { price, color: isTp ? COLORS.tp : COLORS.sl, lineWidth: 1 as const, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${isTp ? 'TP' : 'SL'} ${fmtMoney(pnl, true)}` }
      const key = `new:${d.id}`
      const l = this.lines.get(key)
      if (l) l.applyOptions(opts)
      else this.lines.set(key, this.series.createPriceLine(opts))
      return
    }
    const line = this.lines.get(d.key)
    if (!line) return
    line.applyOptions({ price })
    // live money label while dragging SL/TP
    if (d.kind === 'sl' || d.kind === 'tp') {
      const p = acc.positions.find((q) => q.id === d.id)
      if (p) line.applyOptions({ title: `${d.kind.toUpperCase()} ${fmtMoney(acc.pnl(p.side, p.entry, price, p.lots), true)}` })
    }
  }

  private cancel(e: PointerEvent) {
    this.tap = null
    const d = this.drag
    if (!d) return
    this.drag = null
    if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId)
    this.chart.applyOptions({ handleScroll: true, handleScale: true })
    const temp = this.lines.get(`new:${d.id}`)
    if (temp) {
      this.series.removePriceLine(temp)
      this.lines.delete(`new:${d.id}`)
    }
    this.onModified() // puts a half-dragged line back where it was
  }

  private up(e: PointerEvent) {
    const tp = this.tap
    this.tap = null
    if (tp && e.pointerId === tp.pointer && e.timeStamp - tp.t < 450 && (tp.kind === 'entry' || tp.kind === 'order')) {
      this.onClick(tp.kind, tp.id, e.clientX, e.clientY)
      return
    }
    const d = this.drag
    if (!d) return
    e.stopPropagation()
    this.drag = null
    if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId)
    this.chart.applyOptions({ handleScroll: true, handleScale: true })
    const acc = this.getAccount()
    if (!acc) return
    if (!d.moved) {
      if (d.kind === 'entry' || d.kind === 'order') this.onClick(d.kind, d.id, e.clientX, e.clientY)
      return
    }
    const temp = this.lines.get(`new:${d.id}`)
    const price = d.kind === 'entry' ? temp?.options().price : this.lines.get(d.key)?.options().price
    if (temp) {
      this.series.removePriceLine(temp)
      this.lines.delete(`new:${d.id}`)
    }
    if (price === undefined) return
    try {
      if (d.kind === 'tk') this.setTicket(d.field!, price)
      else if (d.kind === 'order' || d.kind === 'osl' || d.kind === 'otp') {
        const o = acc.orders.find((x) => x.id === d.id)
        if (o) acc.modifyOrder(o.id, d.kind === 'order' ? price : o.price, d.kind === 'osl' ? price : o.sl, d.kind === 'otp' ? price : o.tp)
      } else {
        const p = acc.positions.find((x) => x.id === d.id)
        if (p) {
          const kind = d.kind === 'entry' ? (acc.pnl(p.side, p.entry, price, p.lots) > 0 ? 'tp' : 'sl') : d.kind
          acc.modifyPosition(p.id, kind === 'sl' ? price : p.sl, kind === 'tp' ? price : p.tp)
        }
      }
    } catch (err) {
      toast((err as Error).message, 'bad')
    }
    this.onModified()
  }
}

// ---------- panel ----------

export interface TradeUIOptions {
  root: HTMLElement
  chartHost: HTMLElement
  chart: IChartApi
  candles: ISeriesApi<'Candlestick'>
  /** chart time of the visible candle that contains UTC time t, or null if not on screen */
  chartTimeOf: (t: number) => Time | null
  onChange: () => void
  /** trade journal (F5): button on finished trades */
  journal?: { has: (t: ClosedTrade) => boolean; open: (t: ClosedTrade) => void }
  /** one-tap SELL / BUY and a limit/stop button drawn over the chart */
  quick?: HTMLElement
  /** wait for a tap on the chart; the price there and where the tap was (for the menu) */
  pickPrice?: (label: string) => Promise<{ price: number; x: number; y: number } | null>
}

export class TradeUI {
  account: Account | null = null
  private readonly lines: OrderLines
  private readonly markers: ISeriesMarkersPluginApi<Time>
  private tab: 'pos' | 'orders' | 'hist' = 'pos'
  private structureSig = ''
  private readonly el: Record<string, HTMLElement> = {}

  constructor(private readonly o: TradeUIOptions) {
    this.lines = new OrderLines(o.chart, o.candles, o.chartHost, () => this.account, () => {
      this.refresh()
      o.onChange()
    })
    this.markers = createSeriesMarkers(o.candles, [])
    this.build()
    this.lines.onClick = (kind, id, x, y) => this.lineMenu(kind, id, x, y)
    this.lines.getTicket = () => this.ticketPreview()
    this.buildQuick()
    this.lines.setTicket = (field, v) => {
      const input = (this.el.ticket as HTMLFormElement).elements.namedItem(field) as HTMLInputElement
      input.value = px(v)
      this.updateRisk()
      this.lines.sync()
    }
  }

  // ---------- quick order over the chart ----------

  /** Lots from the ticket, or the default when it holds nothing usable. */
  private quickLots() {
    const l = this.num('lots')
    return l && Number.isFinite(l) && l > 0 ? l : 0.1
  }

  private buildQuick() {
    const q = this.o.quick
    if (!q) return
    q.innerHTML = `
      <button type="button" class="sell" data-q="sell"><small>SELL</small><span data-q-bid>–</span></button>
      <span class="dq-spread" data-q-spread></span>
      <button type="button" class="buy" data-q="buy"><small>BUY</small><span data-q-ask>–</span></button>
      <button type="button" class="rq-pend" data-q="pending" title="Place a limit or stop order: tap the chart at its price">Limit / Stop</button>`
    q.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-q]')?.dataset.q
      if (act === 'sell' || act === 'buy') this.quickMarket(act)
      if (act === 'pending') void this.quickPending()
    })
  }

  private quickMarket(side: Side) {
    const acc = this.account
    if (!acc) return
    const lots = this.quickLots()
    this.act(() => {
      const p = acc.market(side, lots, null, null)
      toast(`${side.toUpperCase()} ${lots.toFixed(2)} at ${fmtPx(p.entry)}. ${TOUCH ? 'Drag its price label on the right' : 'Drag its line'} to set SL/TP.`)
    })
  }

  private async quickPending() {
    if (!this.account || !this.o.pickPrice) return
    const hit = await this.o.pickPrice('Tap the chart at the order price')
    if (!hit) return
    openMenu(hit.x, hit.y, this.pendingItems(hit.price))
  }

  /** Menu entries that place a limit or stop at `price` right away, with the ticket's lots. */
  pendingItems(price: number): MenuItem[] {
    const acc = this.account
    const q = acc?.quote()
    if (!acc || !q) return []
    const p = Math.round(price * 100) / 100
    const lots = this.quickLots()
    // below the market a buy waits as a limit and a sell as a stop; above it is the other way round
    const below = p < q.bid
    const place = (side: Side, type: PendingType) => () =>
      this.act(() => {
        acc.pending(side, type, lots, p, null, null)
        toast(`${side.toUpperCase()} ${type} ${lots.toFixed(2)} @ ${fmtPx(p)} placed. ${TOUCH ? 'Drag its price label on the right' : 'Drag its line'} to move it.`)
      })
    const lot = `${lots.toFixed(2)} lot`
    return below
      ? [
          { label: `Buy limit at ${px(p)}`, hint: lot, act: place('buy', 'limit') },
          { label: `Sell stop at ${px(p)}`, hint: lot, act: place('sell', 'stop') },
        ]
      : [
          { label: `Sell limit at ${px(p)}`, hint: lot, act: place('sell', 'limit') },
          { label: `Buy stop at ${px(p)}`, hint: lot, act: place('buy', 'stop') },
        ]
  }

  private syncQuick() {
    const q = this.o.quick
    if (!q) return
    const quote = this.account?.quote()
    q.querySelector('[data-q-bid]')!.textContent = quote ? fmtPx(quote.bid) : '–'
    q.querySelector('[data-q-ask]')!.textContent = quote ? fmtPx(quote.ask) : '–'
    q.querySelector('[data-q-spread]')!.textContent = quote ? fmtPx(quote.ask - quote.bid) : ''
  }

  /** Ticket values shown as draggable preview lines (pending price only for limit/stop). */
  private ticketPreview() {
    const form = this.el.ticket as HTMLFormElement | undefined
    if (!form) return null
    const pending = (form.elements.namedItem('type') as HTMLSelectElement).value !== 'market'
    const v = (n: string) => {
      const x = this.num(n)
      return x === null || Number.isNaN(x) ? null : x
    }
    return { price: pending ? v('price') : null, sl: v('sl'), tp: v('tp') }
  }

  /** A sensible first distance for a new SL/TP: about a tenth of the visible chart height. */
  private defaultDist(price: number) {
    const y = this.o.candles.priceToCoordinate(price)
    const h = this.o.chart.panes()[0].getHeight()
    const other = y === null ? null : this.o.candles.coordinateToPrice(y + h * 0.1)
    const d = other === null ? price * 0.002 : Math.abs(price - other)
    return Math.max(0.5, Math.round(d * 100) / 100)
  }

  private addLevel(id: number, which: 'sl' | 'tp') {
    const acc = this.account
    const p = acc?.positions.find((x) => x.id === id)
    if (!acc || !p) return
    const d = this.defaultDist(p.entry)
    const dir = (p.side === 'buy' ? 1 : -1) * (which === 'tp' ? 1 : -1)
    const v = Math.round((p.entry + dir * d) * 100) / 100
    this.act(() => acc.modifyPosition(id, which === 'sl' ? v : p.sl, which === 'tp' ? v : p.tp))
    toast(`${which.toUpperCase()} set at ${fmtPx(v)}. ${TOUCH ? 'Drag its price label on the right' : 'Drag its line on the chart'} to adjust.`)
  }

  private addOrderLevel(id: number, which: 'sl' | 'tp') {
    const acc = this.account
    const o = acc?.orders.find((x) => x.id === id)
    if (!acc || !o) return
    const d = this.defaultDist(o.price)
    const dir = (o.side === 'buy' ? 1 : -1) * (which === 'tp' ? 1 : -1)
    const v = Math.round((o.price + dir * d) * 100) / 100
    this.act(() => acc.modifyOrder(id, o.price, which === 'sl' ? v : o.sl, which === 'tp' ? v : o.tp))
  }

  /** run an account change, report errors, refresh everything */
  private act(fn: () => void) {
    try {
      fn()
    } catch (err) {
      toast((err as Error).message, 'bad')
    }
    this.structureSig = ''
    this.refresh()
    this.o.onChange()
  }

  /** Menu for a click on a position or order line in the chart. */
  private lineMenu(kind: 'entry' | 'order', id: number, x: number, y: number) {
    const acc = this.account
    if (!acc) return
    let items: MenuItem[] = []
    if (kind === 'entry') {
      const p = acc.positions.find((q) => q.id === id)
      if (!p) return
      items = [
        p.sl === null ? { label: '+ Set SL', act: () => this.addLevel(id, 'sl') } : { label: 'Remove SL', act: () => this.act(() => acc.modifyPosition(id, null, p.tp)) },
        p.tp === null ? { label: '+ Set TP', act: () => this.addLevel(id, 'tp') } : { label: 'Remove TP', act: () => this.act(() => acc.modifyPosition(id, p.sl, null)) },
        'sep',
        { label: `Close ${p.side.toUpperCase()} ${p.lots.toFixed(2)}`, hint: fmtMoney(acc.positionPnl(p), true), danger: true, act: () => this.act(() => acc.closePosition(id)) },
      ]
    } else {
      const o = acc.orders.find((q) => q.id === id)
      if (!o) return
      items = [
        o.sl === null ? { label: '+ Set SL', act: () => this.addOrderLevel(id, 'sl') } : { label: 'Remove SL', act: () => this.act(() => acc.modifyOrder(id, o.price, null, o.tp)) },
        o.tp === null ? { label: '+ Set TP', act: () => this.addOrderLevel(id, 'tp') } : { label: 'Remove TP', act: () => this.act(() => acc.modifyOrder(id, o.price, o.sl, null)) },
        'sep',
        { label: 'Cancel order', danger: true, act: () => this.act(() => acc.cancelOrder(id)) },
      ]
    }
    openMenu(x, y, items)
  }

  /** Rebuild the lists on the next refresh (e.g. journal state changed). */
  invalidate() {
    this.structureSig = ''
    if (this.account) this.refresh()
  }

  attach(acc: Account) {
    this.account = acc
    acc.onEvent = (e) => this.onEvent(e)
    this.structureSig = ''
    this.refresh()
  }

  detach() {
    if (this.account) this.account.onEvent = () => {}
    this.account = null
    this.lines.clear()
    this.markers.setMarkers([])
  }

  private onEvent(e: AccountEvent) {
    if (e.kind === 'open' && e.fromOrder) toast(`${e.pos.side.toUpperCase()} ${e.fromOrder.type} order filled at ${fmtPx(e.pos.entry)}`)
    if (e.kind === 'close' && e.trade.reason !== 'manual') {
      const t = e.trade
      toast(`${REASON[t.reason]} ${t.side.toUpperCase()} ${t.lots.toFixed(2)}: ${fmtMoney(t.pnl, true)}`, t.pnl >= 0 ? 'good' : 'bad')
    }
  }

  // ---------- DOM ----------

  private build() {
    const r = this.o.root
    r.innerHTML = `
      <section class="acct">
        <div><span class="k">Balance</span><b data-f="balance"></b></div>
        <div><span class="k">Equity</span><b data-f="equity"></b></div>
        <div><span class="k">Floating P/L</span><b data-f="floating"></b></div>
        <div><span class="k">Free margin</span><b data-f="free"></b></div>
      </section>
      <form class="ticket" data-f="ticket" novalidate>
        <div class="row">
          <label><span>Lot</span><input name="lots" type="number" min="0.01" max="100" step="0.01" value="0.10" inputmode="decimal"></label>
          <label><span>Type</span><select name="type"><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option></select></label>
        </div>
        <label class="price-row" hidden><span>Order price</span><input name="price" type="number" step="${pxStep()}" inputmode="decimal"></label>
        <div class="row">
          <label><span>Stop loss</span><input name="sl" type="number" step="${pxStep()}" placeholder="optional" inputmode="decimal"></label>
          <label><span>Take profit</span><input name="tp" type="number" step="${pxStep()}" placeholder="optional" inputmode="decimal"></label>
        </div>
        <p class="risk" data-f="risk"></p>
        <div class="sides">
          <button type="button" class="sell" data-side="sell"><span>SELL</span><b data-f="bid"></b></button>
          <button type="button" class="buy" data-side="buy"><span>BUY</span><b data-f="ask"></b></button>
        </div>
      </form>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="pos"></button>
        <button type="button" role="tab" data-tab="orders"></button>
        <button type="button" role="tab" data-tab="hist"></button>
      </div>
      <div class="tab-body" data-f="body"></div>
      <section class="perf">
        <div class="stats" data-f="stats"></div>
        <canvas data-f="curve" height="64" aria-label="Kurva equity"></canvas>
      </section>`
    for (const el of r.querySelectorAll<HTMLElement>('[data-f]')) this.el[el.dataset.f!] = el

    const form = this.el.ticket as HTMLFormElement
    const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement
    const typeSel = form.elements.namedItem('type') as HTMLSelectElement
    typeSel.addEventListener('change', () => {
      const pending = typeSel.value !== 'market'
      ;(r.querySelector('.price-row') as HTMLElement).hidden = !pending
      if (pending && !field('price').value) {
        const q = this.account?.quote()
        if (q) field('price').value = px(q.bid)
      }
      this.updateRisk()
      this.lines.sync()
    })
    form.addEventListener('input', () => {
      this.updateRisk()
      this.lines.sync()
    })
    for (const b of r.querySelectorAll<HTMLButtonElement>('[data-side]')) {
      b.addEventListener('click', () => this.submit(b.dataset.side as Side))
    }
    for (const b of r.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab as typeof this.tab
        this.structureSig = ''
        this.refresh()
      })
    }
    this.el.body.addEventListener('click', (e) => this.onBodyClick(e))
    this.el.body.addEventListener('change', (e) => this.onBodyChange(e))
  }

  /** Small screens: the panel sits under the chart in the page scroll, bring the ticket into view. */
  private revealTicket() {
    if (matchMedia('(max-width: 900px)').matches) this.el.ticket.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  /** Fill the ticket with a pending order at `price` (from the chart's right-click menu). */
  prefill(type: 'limit' | 'stop', price: number) {
    const form = this.el.ticket as HTMLFormElement
    const sel = form.elements.namedItem('type') as HTMLSelectElement
    sel.value = type
    sel.dispatchEvent(new Event('change'))
    ;(form.elements.namedItem('price') as HTMLInputElement).value = px(price)
    this.revealTicket()
    this.updateRisk()
    ;(form.elements.namedItem('sl') as HTMLInputElement).focus()
  }

  private num(name: string): number | null {
    const v = ((this.el.ticket as HTMLFormElement).elements.namedItem(name) as HTMLInputElement).value.trim()
    if (v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }

  private submit(side: Side) {
    const acc = this.account
    if (!acc) return
    const lots = this.num('lots') ?? NaN
    const sl = this.num('sl')
    const tp = this.num('tp')
    const type = ((this.el.ticket as HTMLFormElement).elements.namedItem('type') as HTMLSelectElement).value
    try {
      if ([lots, sl, tp].some((v) => Number.isNaN(v))) throw new TradeError('Enter valid numbers.')
      if (type === 'market') {
        const p = acc.market(side, lots, sl, tp)
        toast(`${side.toUpperCase()} ${lots.toFixed(2)} at ${fmtPx(p.entry)}`)
      } else {
        const price = this.num('price')
        if (price === null || Number.isNaN(price)) throw new TradeError('Enter the order price.')
        acc.pending(side, type as PendingType, lots, price, sl, tp)
        toast(`${side.toUpperCase()} ${type} order ${lots.toFixed(2)} @ ${fmtPx(price)} placed`)
      }
    } catch (err) {
      toast((err as Error).message, 'bad')
      return
    }
    this.refresh()
    this.o.onChange()
  }

  /** Risk and reward of the ticket in money, % of balance and R multiple. */
  private updateRisk() {
    const acc = this.account
    const q = acc?.quote()
    const out = this.el.risk
    if (!acc || !q) {
      out.textContent = ''
      return
    }
    const lots = this.num('lots')
    const sl = this.num('sl')
    const tp = this.num('tp')
    const type = ((this.el.ticket as HTMLFormElement).elements.namedItem('type') as HTMLSelectElement).value
    const priceIn = this.num('price')
    if (!lots || Number.isNaN(lots) || (sl === null && tp === null)) {
      out.textContent = 'Set an SL to see the risk per trade.'
      return
    }
    const parts: string[] = []
    // show both directions: the side is chosen with the button
    const entryFor = (side: Side) => (type === 'market' ? (side === 'buy' ? q.ask : q.bid) : (priceIn ?? NaN))
    const side: Side = sl !== null ? (sl < entryFor('buy') ? 'buy' : 'sell') : tp !== null && tp > entryFor('buy') ? 'buy' : 'sell'
    const entry = entryFor(side)
    if (sl !== null && Number.isFinite(entry)) {
      const risk = -acc.pnl(side, entry, sl, lots)
      parts.push(`Risk ${fmtMoney(risk)} (${((risk / acc.balance) * 100).toFixed(2)}% of balance)`)
      if (tp !== null) {
        const reward = acc.pnl(side, entry, tp, lots)
        if (risk > 0) parts.push(`R:R 1:${(reward / risk).toFixed(2)}`)
      }
    } else if (tp !== null && Number.isFinite(entry)) {
      parts.push(`Target ${fmtMoney(acc.pnl(side, entry, tp, lots))}, no SL`)
    }
    out.textContent = parts.length ? `${side.toUpperCase()}: ${parts.join(' · ')}` : ''
  }

  private onBodyClick(e: Event) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
    const acc = this.account
    if (!t || !acc) return
    const id = Number(t.dataset.id)
    if (t.dataset.act === 'journal') {
      const tr = acc.history.find((x) => x.id === id)
      if (tr) this.o.journal?.open(tr)
      return
    }
    const act = t.dataset.act!
    if (act === 'add-sl' || act === 'add-tp') return this.addLevel(id, act === 'add-sl' ? 'sl' : 'tp')
    if (act === 'oadd-sl' || act === 'oadd-tp') return this.addOrderLevel(id, act === 'oadd-sl' ? 'sl' : 'tp')
    if (act === 'clear-sl' || act === 'clear-tp') {
      const p = acc.positions.find((x) => x.id === id)
      if (p) this.act(() => acc.modifyPosition(id, act === 'clear-sl' ? null : p.sl, act === 'clear-tp' ? null : p.tp))
      return
    }
    if (act === 'oclear-sl' || act === 'oclear-tp') {
      const o = acc.orders.find((x) => x.id === id)
      if (o) this.act(() => acc.modifyOrder(id, o.price, act === 'oclear-sl' ? null : o.sl, act === 'oclear-tp' ? null : o.tp))
      return
    }
    try {
      if (t.dataset.act === 'close') acc.closePosition(id)
      if (t.dataset.act === 'cancel') acc.cancelOrder(id)
      if (t.dataset.act === 'close-all') acc.closeAll()
    } catch (err) {
      toast((err as Error).message, 'bad')
    }
    this.refresh()
    this.o.onChange()
  }

  private onBodyChange(e: Event) {
    const input = e.target as HTMLInputElement
    const acc = this.account
    if (acc && input.dataset.oedit) {
      const o = acc.orders.find((x) => x.id === Number(input.dataset.id))
      const v = input.value.trim() === '' ? null : Number(input.value)
      if (!o) return
      return this.act(() => {
        if (v !== null && !Number.isFinite(v)) throw new TradeError('Invalid number.')
        const f = input.dataset.oedit
        if (f === 'price' && v === null) throw new TradeError('Enter the order price.')
        acc.modifyOrder(o.id, f === 'price' ? v! : o.price, f === 'sl' ? v : o.sl, f === 'tp' ? v : o.tp)
      })
    }
    if (!acc || !input.dataset.edit) return
    const id = Number(input.dataset.id)
    const v = input.value.trim() === '' ? null : Number(input.value)
    try {
      if (v !== null && !Number.isFinite(v)) throw new TradeError('Invalid number.')
      const p = acc.positions.find((x) => x.id === id)
      if (p) acc.modifyPosition(id, input.dataset.edit === 'sl' ? v : p.sl, input.dataset.edit === 'tp' ? v : p.tp)
    } catch (err) {
      toast((err as Error).message, 'bad')
    }
    this.structureSig = ''
    this.refresh()
    this.o.onChange()
  }

  // ---------- refresh ----------

  /** Cheap per-step update; the lists are only rebuilt when their structure changes. */
  refresh() {
    const acc = this.account
    if (!acc) return
    const q = acc.quote()
    this.el.balance.textContent = fmtMoney(acc.balance)
    this.el.equity.textContent = fmtMoney(acc.equity())
    const fl = acc.floating()
    this.el.floating.textContent = fmtMoney(fl, true)
    this.el.floating.className = fl > 0 ? 'up' : fl < 0 ? 'down' : ''
    this.el.free.textContent = fmtMoney(acc.freeMargin())
    this.el.bid.textContent = q ? fmtPx(q.bid) : '–'
    this.el.ask.textContent = q ? fmtPx(q.ask) : '–'
    this.syncQuick()

    const tabs = this.o.root.querySelectorAll<HTMLButtonElement>('[data-tab]')
    const labels = { pos: `Positions (${acc.positions.length})`, orders: `Orders (${acc.orders.length})`, hist: `History (${acc.history.length})` }
    for (const b of tabs) {
      b.textContent = labels[b.dataset.tab as keyof typeof labels]
      b.setAttribute('aria-selected', String(b.dataset.tab === this.tab))
    }

    const sig = JSON.stringify([
      this.tab,
      acc.positions.map((p) => [p.id, p.sl, p.tp]),
      acc.orders.map((o) => [o.id, o.price]),
      acc.history.length,
    ])
    const editing = this.el.body.contains(document.activeElement)
    if (sig !== this.structureSig && !editing) {
      this.structureSig = sig
      this.renderBody()
    }
    for (const p of acc.positions) {
      const cell = this.el.body.querySelector<HTMLElement>(`[data-pnl="${p.id}"]`)
      if (cell) {
        const v = acc.positionPnl(p)
        cell.textContent = fmtMoney(v, true)
        cell.classList.toggle('up', v > 0)
        cell.classList.toggle('down', v < 0)
      }
    }

    this.renderStats()
    this.drawCurve()
    this.updateRisk()
    this.lines.sync()
    this.syncMarkers()
  }

  private renderBody() {
    const acc = this.account!
    let html = ''
    // a level: value field with a clear button, or a "+" button that places it for dragging
    const level = (kind: 'sl' | 'tp', v: number | null, id: number, order = false) =>
      v === null
        ? `<button type="button" class="lv-add ${kind}" data-act="${order ? 'o' : ''}add-${kind}" data-id="${id}">+ ${kind.toUpperCase()}</button>`
        : `<span class="lv ${kind}"><span>${kind.toUpperCase()}</span><input aria-label="${kind === 'sl' ? 'Stop loss' : 'Take profit'}" type="number" step="0.01" inputmode="decimal" ${order ? 'data-oedit' : 'data-edit'}="${kind}" data-id="${id}" value="${v}"><button type="button" class="lv-x" data-act="${order ? 'o' : ''}clear-${kind}" data-id="${id}" aria-label="Remove ${kind.toUpperCase()}">✕</button></span>`
    if (this.tab === 'pos') {
      html = acc.positions.length
        ? `<ul class="cards">${acc.positions
            .map(
              (p) => `<li class="card-row">
                <div class="cr-top"><b class="${p.side}">${p.side.toUpperCase()} ${p.lots.toFixed(2)}</b><span class="cr-at">@ ${fmtPx(p.entry)}</span><b class="cr-pnl" data-pnl="${p.id}"></b>
                <button type="button" class="x" data-act="close" data-id="${p.id}" aria-label="Close position" title="Close position">✕</button></div>
                <div class="cr-lv">${level('sl', p.sl, p.id)}${level('tp', p.tp, p.id)}</div>
              </li>`,
            )
            .join('')}</ul>
            <div class="cards-foot"><span class="hint">Drag a position line on the chart to set SL/TP. Click a line for its menu.</span>${acc.positions.length > 1 ? '<button type="button" class="link" data-act="close-all">Close all</button>' : ''}</div>`
        : '<p class="empty">No open positions. Click SELL or BUY in the ticket.</p>'
    } else if (this.tab === 'orders') {
      html = acc.orders.length
        ? `<ul class="cards">${acc.orders
            .map(
              (o) => `<li class="card-row">
                <div class="cr-top"><b class="${o.side}">${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.lots.toFixed(2)}</b>
                <span class="lv price"><span>@</span><input aria-label="Order price" type="number" step="0.01" inputmode="decimal" data-oedit="price" data-id="${o.id}" value="${o.price}"></span>
                <button type="button" class="x" data-act="cancel" data-id="${o.id}" aria-label="Cancel order" title="Cancel order">✕</button></div>
                <div class="cr-lv">${level('sl', o.sl, o.id, true)}${level('tp', o.tp, o.id, true)}</div>
              </li>`,
            )
            .join('')}</ul><div class="cards-foot"><span class="hint">Drag an order line on the chart to change its price.</span></div>`
        : '<p class="empty">No pending orders. Choose Limit/Stop in the ticket, or right-click the chart at the price you want.</p>'
    } else {
      const rows = acc.history.slice(-100).reverse()
      html = rows.length
        ? `<table><thead><tr><th>Trade</th><th>Entry → Exit</th><th>Closed by</th><th>P/L</th>${this.o.journal ? '<th></th>' : ''}</tr></thead><tbody>${rows
            .map(
              (t) => `<tr>
                <td class="${t.side}">${t.side.toUpperCase()} ${t.lots.toFixed(2)}</td>
                <td>${fmtPx(t.entry)} → ${fmtPx(t.exit)}</td>
                <td>${esc(REASON[t.reason])}</td>
                <td class="${t.pnl > 0 ? 'up' : t.pnl < 0 ? 'down' : ''}">${fmtMoney(t.pnl, true)}</td>
                ${this.o.journal ? `<td><button type="button" class="link jr-btn" data-act="journal" data-id="${t.id}" title="Write a journal entry for this trade">${this.o.journal.has(t) ? '✓ Journal' : 'Journal'}</button></td>` : ''}
              </tr>`,
            )
            .join('')}</tbody></table>`
        : '<p class="empty">No closed trades yet.</p>'
    }
    this.el.body.innerHTML = html
  }

  private renderStats() {
    const acc = this.account!
    const s = stats(acc.history, acc.cfg.balance)
    const pf = s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)
    this.el.stats.innerHTML = [
      ['Trades', String(s.trades)],
      ['Win rate', `${(s.winRate * 100).toFixed(0)}%`],
      ['Net', fmtMoney(s.net, true)],
      ['Profit factor', pf],
      ['Max DD', `${(s.maxDrawdown * 100).toFixed(1)}%`],
    ]
      .map(([k, v]) => `<div><span class="k">${k}</span><b>${v}</b></div>`)
      .join('')
  }

  private drawCurve() {
    const acc = this.account!
    const cv = this.el.curve as HTMLCanvasElement
    const w = cv.clientWidth
    const h = 64
    if (!w) return
    const dpr = window.devicePixelRatio || 1
    if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const pts = acc.equityCurve
    if (pts.length < 2) return
    const vals = pts.map((p) => p[1])
    const lo = Math.min(...vals, acc.cfg.balance)
    const hi = Math.max(...vals, acc.cfg.balance)
    const y = (v: number) => (hi === lo ? h / 2 : h - 4 - ((v - lo) / (hi - lo)) * (h - 8))
    ctx.strokeStyle = '#3a4256'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(0, y(acc.cfg.balance))
    ctx.lineTo(w, y(acc.cfg.balance))
    ctx.stroke()
    ctx.setLineDash([])
    ctx.strokeStyle = vals[vals.length - 1] >= acc.cfg.balance ? '#26a69a' : '#ef5350'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    vals.forEach((v, i) => {
      const x = (i / (vals.length - 1)) * w
      if (i === 0) ctx.moveTo(x, y(v))
      else ctx.lineTo(x, y(v))
    })
    ctx.stroke()
  }

  /** Entry/exit arrows on the candles, placed on the visible candle containing each fill. */
  syncMarkers() {
    const acc = this.account
    if (!acc) {
      this.markers.setMarkers([])
      return
    }
    const out: SeriesMarker<Time>[] = []
    const add = (t: number, m: Omit<SeriesMarker<Time>, 'time'>) => {
      const time = this.o.chartTimeOf(t)
      if (time !== null) out.push({ time, ...m } as SeriesMarker<Time>)
    }
    for (const t of acc.history.slice(-300)) {
      add(t.openTime, t.side === 'buy'
        ? { position: 'belowBar', shape: 'arrowUp', color: COLORS.buy, text: 'B' }
        : { position: 'aboveBar', shape: 'arrowDown', color: COLORS.sell, text: 'S' })
      add(t.closeTime, { position: t.side === 'buy' ? 'aboveBar' : 'belowBar', shape: 'circle', color: t.pnl >= 0 ? COLORS.tp : COLORS.sl, text: fmtMoney(t.pnl, true) })
    }
    for (const p of acc.positions) {
      add(p.openTime, p.side === 'buy'
        ? { position: 'belowBar', shape: 'arrowUp', color: COLORS.buy, text: 'B' }
        : { position: 'aboveBar', shape: 'arrowDown', color: COLORS.sell, text: 'S' })
    }
    out.sort((a, b) => (a.time as number) - (b.time as number))
    this.markers.setMarkers(out)
  }
}
