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
import { TradeError, stats, type Account, type AccountEvent, type PendingType, type Side, type ClosedTrade } from './engine/account'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const fmtMoney = (n: number, sign = false) => (sign && n > 0 ? '+' : '') + money.format(n)
const fmtPx = (n: number | null) => (n === null ? '–' : n.toFixed(2))
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const COLORS = { buy: '#4c8dff', sell: '#ef5350', sl: '#ef5350', tp: '#26a69a', pending: '#f5a524' }
const REASON: Record<string, string> = { tp: 'TP', sl: 'SL', manual: 'Manual', stopout: 'Stop-out', signal: 'Sinyal', time: 'Waktu', end: 'Akhir data' }

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

// ---------- order lines on the chart (draggable) ----------

type LineKey = string // `${kind}:${id}` kind = entry|sl|tp|order

interface DragState {
  key: LineKey
  id: number
  kind: 'sl' | 'tp' | 'order'
  pointerId: number
}

class OrderLines {
  private lines = new Map<LineKey, IPriceLine>()
  private drag: DragState | null = null

  constructor(
    private readonly chart: IChartApi,
    private readonly series: ISeriesApi<'Candlestick'>,
    private readonly host: HTMLElement,
    private readonly getAccount: () => Account | null,
    private readonly onModified: () => void,
  ) {
    host.addEventListener('pointerdown', (e) => this.down(e), true)
    host.addEventListener('pointermove', (e) => this.move(e), true)
    host.addEventListener('pointerup', (e) => this.up(e), true)
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
          lineWidth: 1,
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
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.lots.toFixed(2)}`,
        })
        if (o.sl !== null) want.set(`osl:${o.id}`, { price: o.sl, color: COLORS.sl, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: 'SL' })
        if (o.tp !== null) want.set(`otp:${o.id}`, { price: o.tp, color: COLORS.tp, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: 'TP' })
      }
    }
    for (const [k, l] of this.lines) {
      if (!want.has(k)) {
        this.series.removePriceLine(l)
        this.lines.delete(k)
      }
    }
    for (const [k, opts] of want) {
      if (this.drag?.key === k) continue // keep the price the user is dragging
      const l = this.lines.get(k)
      if (l) l.applyOptions(opts)
      else this.lines.set(k, this.series.createPriceLine(opts))
    }
  }

  private local(e: PointerEvent) {
    const r = this.host.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private hit(x: number, y: number): DragState | null {
    if (x > this.chart.timeScale().width() || y > this.chart.panes()[0].getHeight()) return null
    let best: { key: LineKey; d: number } | null = null
    for (const [key, line] of this.lines) {
      const kind = key.split(':')[0]
      if (kind !== 'sl' && kind !== 'tp' && kind !== 'order') continue
      const ly = this.series.priceToCoordinate(line.options().price)
      if (ly === null) continue
      const d = Math.abs(ly - y)
      if (d <= 5 && (!best || d < best.d)) best = { key, d }
    }
    if (!best) return null
    const [kind, id] = best.key.split(':')
    return { key: best.key, id: Number(id), kind: kind as DragState['kind'], pointerId: 0 }
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 || !this.getAccount()) return
    const { x, y } = this.local(e)
    const h = this.hit(x, y)
    if (!h) return
    e.stopPropagation()
    e.preventDefault()
    this.drag = { ...h, pointerId: e.pointerId }
    this.host.setPointerCapture(e.pointerId)
    this.chart.applyOptions({ handleScroll: false, handleScale: false })
  }

  private move(e: PointerEvent) {
    const { x, y } = this.local(e)
    if (!this.drag) {
      const h = this.getAccount() ? this.hit(x, y) : null
      if (h) this.host.style.cursor = 'ns-resize'
      else if (this.host.style.cursor === 'ns-resize') this.host.style.cursor = ''
      return
    }
    e.stopPropagation()
    const price = this.series.coordinateToPrice(y)
    if (price !== null) this.lines.get(this.drag.key)?.applyOptions({ price: Math.round(price * 100) / 100 })
  }

  private up(e: PointerEvent) {
    const d = this.drag
    if (!d) return
    e.stopPropagation()
    this.drag = null
    if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId)
    this.chart.applyOptions({ handleScroll: true, handleScale: true })
    const acc = this.getAccount()
    const price = this.lines.get(d.key)?.options().price
    if (!acc || price === undefined) return
    try {
      if (d.kind === 'order') {
        const o = acc.orders.find((x) => x.id === d.id)
        if (o) acc.modifyOrder(o.id, price, o.sl, o.tp)
      } else {
        const p = acc.positions.find((x) => x.id === d.id)
        if (p) acc.modifyPosition(p.id, d.kind === 'sl' ? price : p.sl, d.kind === 'tp' ? price : p.tp)
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
    if (e.kind === 'open' && e.fromOrder) toast(`Order ${e.pos.side.toUpperCase()} ${e.fromOrder.type} terisi di ${fmtPx(e.pos.entry)}`)
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
        <div><span class="k">Saldo</span><b data-f="balance"></b></div>
        <div><span class="k">Equity</span><b data-f="equity"></b></div>
        <div><span class="k">P/L berjalan</span><b data-f="floating"></b></div>
        <div><span class="k">Margin bebas</span><b data-f="free"></b></div>
      </section>
      <form class="ticket" data-f="ticket" novalidate>
        <div class="row">
          <label><span>Lot</span><input name="lots" type="number" min="0.01" max="100" step="0.01" value="0.10" inputmode="decimal"></label>
          <label><span>Tipe</span><select name="type"><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option></select></label>
        </div>
        <label class="price-row" hidden><span>Harga order</span><input name="price" type="number" step="0.01" inputmode="decimal"></label>
        <div class="row">
          <label><span>Stop loss</span><input name="sl" type="number" step="0.01" placeholder="opsional" inputmode="decimal"></label>
          <label><span>Take profit</span><input name="tp" type="number" step="0.01" placeholder="opsional" inputmode="decimal"></label>
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
        if (q) field('price').value = q.bid.toFixed(2)
      }
      this.updateRisk()
    })
    form.addEventListener('input', () => this.updateRisk())
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
      if ([lots, sl, tp].some((v) => Number.isNaN(v))) throw new TradeError('Isi angka yang valid.')
      if (type === 'market') {
        const p = acc.market(side, lots, sl, tp)
        toast(`${side.toUpperCase()} ${lots.toFixed(2)} di ${fmtPx(p.entry)}`)
      } else {
        const price = this.num('price')
        if (price === null || Number.isNaN(price)) throw new TradeError('Isi harga order.')
        acc.pending(side, type as PendingType, lots, price, sl, tp)
        toast(`Order ${side.toUpperCase()} ${type} ${lots.toFixed(2)} @ ${fmtPx(price)} dipasang`)
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
      out.textContent = 'Isi SL untuk melihat risiko per trade.'
      return
    }
    const parts: string[] = []
    // show both directions: the side is chosen with the button
    const entryFor = (side: Side) => (type === 'market' ? (side === 'buy' ? q.ask : q.bid) : (priceIn ?? NaN))
    const side: Side = sl !== null ? (sl < entryFor('buy') ? 'buy' : 'sell') : tp !== null && tp > entryFor('buy') ? 'buy' : 'sell'
    const entry = entryFor(side)
    if (sl !== null && Number.isFinite(entry)) {
      const risk = -acc.pnl(side, entry, sl, lots)
      parts.push(`Risiko ${fmtMoney(risk)} (${((risk / acc.balance) * 100).toFixed(2)}% saldo)`)
      if (tp !== null) {
        const reward = acc.pnl(side, entry, tp, lots)
        if (risk > 0) parts.push(`R:R 1:${(reward / risk).toFixed(2)}`)
      }
    } else if (tp !== null && Number.isFinite(entry)) {
      parts.push(`Target ${fmtMoney(acc.pnl(side, entry, tp, lots))}, tanpa SL`)
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
    if (!acc || !input.dataset.edit) return
    const id = Number(input.dataset.id)
    const v = input.value.trim() === '' ? null : Number(input.value)
    try {
      if (v !== null && !Number.isFinite(v)) throw new TradeError('Angka tidak valid.')
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

    const tabs = this.o.root.querySelectorAll<HTMLButtonElement>('[data-tab]')
    const labels = { pos: `Posisi (${acc.positions.length})`, orders: `Order (${acc.orders.length})`, hist: `Riwayat (${acc.history.length})` }
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
        cell.className = v > 0 ? 'up' : v < 0 ? 'down' : ''
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
    if (this.tab === 'pos') {
      html = acc.positions.length
        ? `<table><thead><tr><th>Posisi</th><th>Entry</th><th>SL</th><th>TP</th><th>P/L</th><th></th></tr></thead><tbody>${acc.positions
            .map(
              (p) => `<tr>
                <td class="${p.side}">${p.side.toUpperCase()} ${p.lots.toFixed(2)}</td>
                <td>${fmtPx(p.entry)}</td>
                <td><input aria-label="Stop loss" type="number" step="0.01" data-edit="sl" data-id="${p.id}" value="${p.sl ?? ''}"></td>
                <td><input aria-label="Take profit" type="number" step="0.01" data-edit="tp" data-id="${p.id}" value="${p.tp ?? ''}"></td>
                <td data-pnl="${p.id}"></td>
                <td><button type="button" class="x" data-act="close" data-id="${p.id}" aria-label="Tutup posisi">✕</button></td>
              </tr>`,
            )
            .join('')}</tbody></table><button type="button" class="link" data-act="close-all">Tutup semua</button>`
        : '<p class="empty">Belum ada posisi. Pasang order dari tiket di atas.</p>'
    } else if (this.tab === 'orders') {
      html = acc.orders.length
        ? `<table><thead><tr><th>Order</th><th>Harga</th><th>SL</th><th>TP</th><th></th></tr></thead><tbody>${acc.orders
            .map(
              (o) => `<tr>
                <td class="${o.side}">${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.lots.toFixed(2)}</td>
                <td>${fmtPx(o.price)}</td><td>${fmtPx(o.sl)}</td><td>${fmtPx(o.tp)}</td>
                <td><button type="button" class="x" data-act="cancel" data-id="${o.id}" aria-label="Batalkan order">✕</button></td>
              </tr>`,
            )
            .join('')}</tbody></table>`
        : '<p class="empty">Tidak ada order pending.</p>'
    } else {
      const rows = acc.history.slice(-100).reverse()
      html = rows.length
        ? `<table><thead><tr><th>Trade</th><th>Entry → Exit</th><th>Tutup</th><th>P/L</th>${this.o.journal ? '<th></th>' : ''}</tr></thead><tbody>${rows
            .map(
              (t) => `<tr>
                <td class="${t.side}">${t.side.toUpperCase()} ${t.lots.toFixed(2)}</td>
                <td>${fmtPx(t.entry)} → ${fmtPx(t.exit)}</td>
                <td>${esc(REASON[t.reason])}</td>
                <td class="${t.pnl > 0 ? 'up' : t.pnl < 0 ? 'down' : ''}">${fmtMoney(t.pnl, true)}</td>
                ${this.o.journal ? `<td><button type="button" class="link jr-btn" data-act="journal" data-id="${t.id}" title="Tulis jurnal untuk trade ini">${this.o.journal.has(t) ? '✓ Jurnal' : 'Jurnal'}</button></td>` : ''}
              </tr>`,
            )
            .join('')}</tbody></table>`
        : '<p class="empty">Belum ada trade selesai.</p>'
    }
    this.el.body.innerHTML = html
  }

  private renderStats() {
    const acc = this.account!
    const s = stats(acc.history, acc.cfg.balance)
    const pf = s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)
    this.el.stats.innerHTML = [
      ['Trade', String(s.trades)],
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
