/** Strategy tester panel: strategy form, results, trade list, optimizer, A/B compare. */
import { TIMEFRAMES, type TF } from '../data'
import { formatWall, makeShifter, parseZoned } from '../time'
import { toast } from '../trade'
import { SESSIONS, breakdown, sessionOf, type Metrics } from './report'
import type { BtTrade } from './run'
import {
  OPS,
  PRESETS,
  SOURCES,
  defaultSpec,
  describe,
  fmtCond,
  listParams,
  operand,
  withParams,
  type Cond,
  type Op,
  type StrategySpec,
} from './strategy'
import type { OptRow, RunReport, WorkerIn, WorkerOut } from './worker'
import { ask } from '../shared/ask'
import { px } from '../current'
import { current } from '../current'

type Tab = 'strategy' | 'result' | 'trades' | 'optimize' | 'compare'
const TABS: [Tab, string][] = [
  ['strategy', 'Strategy'],
  ['result', 'Results'],
  ['trades', 'Trades'],
  ['optimize', 'Optimise'],
  ['compare', 'Compare'],
]
const LISTS: [keyof Pick<StrategySpec, 'long' | 'short' | 'exitLong' | 'exitShort'>, string][] = [
  ['long', 'Buy when all are true'],
  ['short', 'Sell when all are true'],
  ['exitLong', 'Close buys when (optional)'],
  ['exitShort', 'Close sells when (optional)'],
]
const REASON: Record<string, string> = { tp: 'TP', sl: 'SL', signal: 'Signal', time: 'Time', end: 'End of data', stopout: 'Stop-out', manual: 'Manual' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const SPLIT = 0.7
const MAX_COMBOS = 200

/** period chips: key, days back from the end of the data (0 = all), label */
const PERIODS: [string, number, string][] = [
  ['1m', 30, '1 month'],
  ['3m', 91, '3 months'],
  ['6m', 182, '6 months'],
  ['1y', 365, '1 year'],
  ['all', 0, 'All data'],
]
const MIRROR: Record<Op, Op> = { gt: 'lt', lt: 'gt', xup: 'xdown', xdown: 'xup' }

const KEY = { spec: 'rc.v1.bt.spec', saved: 'rc.v1.bt.saved', height: 'rc.v1.bt.height' }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const usd = (n: number, sign = false) => (sign && n > 0 ? '+' : '') + money.format(n)
const pct = (n: number, sign = false) => (sign && n > 0 ? '+' : '') + (n * 100).toFixed(1) + '%'
const num = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : n === Infinity ? '∞' : '–')
const cls = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
function save(key: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* storage full or blocked */
  }
}

/** Fill missing fields after an app update changed the spec shape. */
function normalize(s: Partial<StrategySpec> | null): StrategySpec {
  const d = defaultSpec()
  if (!s || typeof s !== 'object') return d
  return { ...d, ...s, sl: { ...d.sl, ...s.sl }, tp: { ...d.tp, ...s.tp }, sizing: { ...d.sizing, ...s.sizing }, hours: { ...d.hours, ...s.hours } }
}

function setPath(obj: unknown, path: string, value: unknown) {
  const keys = path.split('.')
  let o = obj as Record<string, unknown>
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>
  o[keys[keys.length - 1]] = value
}
function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((o, k) => (o as Record<string, unknown>)?.[k], obj)
}

interface Saved {
  spec: StrategySpec
  metrics: Metrics
  curve: { t: number[]; v: number[] }
  from: number
  to: number
}

interface OptForm {
  p1: string
  a1: number
  b1: number
  s1: number
  p2: string
  a2: number
  b2: number
  s2: number
}

export interface BacktestUIOptions {
  root: HTMLElement
  zone: () => string
  /** first/last bar of the whole data set */
  span: { from: number; to: number }
  onTrades: (trades: BtTrade[] | null) => void
  onJump: (t: number, tf: TF) => void
  onClose: () => void
  /** save the current result to the user's account (F5) */
  onSave?: (r: RunReport) => void
}

export class BacktestUI {
  spec: StrategySpec = normalize(load<Partial<StrategySpec> | null>(KEY.spec, null))
  report: RunReport | null = null
  private saved: Saved | null = load<Saved | null>(KEY.saved, null)
  private tab: Tab = 'strategy'
  private worker: Worker | null = null
  private jobId = 0
  private running = false
  private opt: { rows: OptRow[]; specs: StrategySpec[]; labels: [number, number | null][]; names: [string, string | null]; isEnd: number } | null = null
  private optForm: OptForm | null = null
  private readonly body: HTMLElement
  private readonly status: HTMLElement
  private readonly runBtn: HTMLButtonElement

  constructor(private readonly o: BacktestUIOptions) {
    const r = o.root
    r.innerHTML = `
      <header class="bt-head">
        <div class="bt-tabs" role="tablist">${TABS.map(([t, l]) => `<button type="button" role="tab" data-tab="${t}">${l}</button>`).join('')}</div>
        <span class="bt-status" aria-live="polite"></span>
        <button type="button" class="primary bt-run" data-act="run">▶ Run</button>
        <button type="button" class="bt-x" data-act="close" aria-label="Close backtest" title="Close">×</button>
      </header>
      <div class="bt-body"></div>`
    this.grip(r)
    this.body = r.querySelector('.bt-body')!
    this.status = r.querySelector('.bt-status')!
    this.runBtn = r.querySelector('.bt-run')!
    r.addEventListener('click', (e) => this.onClick(e))
    r.addEventListener('input', (e) => this.onInput(e, false))
    r.addEventListener('change', (e) => this.onInput(e, true))
    r.addEventListener('keydown', (e) => {
      // Tab inside the code editor inserts spaces
      const t = e.target as HTMLTextAreaElement
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (!this.running) this.run()
        return
      }
      if (e.key === 'Tab' && t.tagName === 'TEXTAREA') {
        e.preventDefault()
        t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end')
        t.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    new ResizeObserver(() => this.redrawCanvases()).observe(this.body)
    this.show('strategy')
  }

  /** Drag the panel's top edge to give it more or less room; double-click toggles a tall panel. */
  private grip(r: HTMLElement) {
    const g = document.createElement('div')
    g.className = 'bt-grip'
    g.title = 'Drag to resize the panel (double-click: big/small)'
    r.prepend(g)
    const ws = () => r.parentElement as HTMLElement
    const set = (px: number | null) => {
      if (px === null) ws().style.removeProperty('--bt-h')
      else ws().style.setProperty('--bt-h', `${Math.round(px)}px`)
      save(KEY.height, px)
    }
    const h0 = load<number | null>(KEY.height, null)
    if (h0) ws().style.setProperty('--bt-h', `${h0}px`)
    const clamp = (px: number) => Math.max(160, Math.min(ws().clientHeight - 120, px))
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      g.setPointerCapture(e.pointerId)
      const bottom = ws().getBoundingClientRect().bottom
      const move = (ev: PointerEvent) => set(clamp(bottom - ev.clientY))
      const up = () => {
        g.removeEventListener('pointermove', move)
        g.removeEventListener('pointerup', up)
      }
      g.addEventListener('pointermove', move)
      g.addEventListener('pointerup', up)
    })
    g.addEventListener('dblclick', () => {
      const tall = r.getBoundingClientRect().height > ws().clientHeight * 0.6
      set(tall ? null : clamp(ws().clientHeight - 160))
    })
  }

  // ---------- tabs ----------

  show(tab: Tab) {
    const same = this.tab === tab
    this.tab = tab
    for (const b of this.o.root.querySelectorAll<HTMLElement>('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab))
    this.render(!same)
  }

  private render(top = false) {
    const keep = this.body.scrollTop
    const html =
      this.tab === 'strategy'
        ? this.strategyHtml()
        : this.tab === 'result'
          ? this.resultHtml()
          : this.tab === 'trades'
            ? this.tradesHtml()
            : this.tab === 'optimize'
              ? this.optimizeHtml()
              : this.compareHtml()
    this.body.innerHTML = html
    this.body.scrollTop = top ? 0 : keep
    this.redrawCanvases()
  }

  // ---------- events ----------

  private onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tab],[data-act],[data-jump]')
    if (!el) return
    if (el.dataset.tab) return this.show(el.dataset.tab as Tab)
    if (el.dataset.jump) {
      const t = this.report?.trades[+el.dataset.jump]
      if (t && this.report) this.o.onJump(t.openTime, this.report.spec.tf)
      for (const row of this.body.querySelectorAll('tr.sel')) row.classList.remove('sel')
      el.classList.add('sel')
      return
    }
    const act = el.dataset.act
    const s = this.spec
    if (act === 'run') return this.running ? this.cancel() : this.run()
    if (act === 'close') return this.o.onClose()
    if (act === 'preset') {
      const p = PRESETS[+el.dataset.v!]
      if (!p) return
      const keep = { from: s.from, to: s.to, tf: s.tf, balance: s.balance, leverage: s.leverage, commission: s.commission, slippage: s.slippage }
      this.spec = { ...p.make(), ...keep, name: p.name }
      return this.changed(true)
    }
    if (act === 'tf') {
      s.tf = el.dataset.v as TF
      return this.changed(true)
    }
    if (act === 'period') {
      const k = el.dataset.v!
      const day = 86400
      const end = Math.ceil(this.o.span.to / day) * day
      if (k === 'custom') {
        if (s.to === null) Object.assign(s, { from: s.from ?? end - 30 * day, to: end })
      } else {
        const d = PERIODS.find(([x]) => x === k)![1]
        Object.assign(s, { from: d ? this.o.span.to - d * day : null, to: null })
      }
      return this.changed(true)
    }
    if (act === 'mirror') {
      s.short = s.long.map((c) => ({ a: structuredClone(c.a), op: MIRROR[c.op], b: structuredClone(c.b) }))
      // a fixed level mirrors around its own scale: RSI 30 becomes 70, 0 stays 0
      for (const c of s.short)
        for (const o of [c.a, c.b]) if (o.src === 'num' && o.p[0] > 0 && o.p[0] < 100 && (c.a.src === 'rsi' || c.a.src.startsWith('stoch'))) o.p[0] = 100 - o.p[0]
      s.name = ''
      toast('Sell conditions set to the mirror of the buy conditions.', 'good')
      return this.changed(true)
    }
    if (act === 'mode') {
      s.mode = el.dataset.v as StrategySpec['mode']
      return this.changed(true)
    }
    if (act === 'add') {
      const list = el.dataset.list as (typeof LISTS)[number][0]
      s[list].push({ a: operand('close'), op: 'gt', b: operand('ema', [50]) })
      s.name = ''
      return this.changed(true)
    }
    if (act === 'del') {
      s[el.dataset.list as (typeof LISTS)[number][0]].splice(+el.dataset.i!, 1)
      return this.changed(true)
    }
    if (act === 'reset-code') {
      void ask('Your code is replaced with the starter example.', { title: 'Replace code?', ok: 'Replace' }).then((ok) => {
        if (!ok) return
        s.code = defaultSpec().code
        this.changed(true)
      })
      return
    }
    if (act === 'saveA' && this.report) {
      const r = this.report
      this.saved = { spec: r.spec, metrics: r.metrics, curve: r.curve, from: r.from, to: r.to }
      save(KEY.saved, this.saved)
      toast('Result saved as A. Change the strategy, run it again, then open the Compare tab.', 'good')
      return
    }
    if (act === 'save-acct' && this.report) return this.o.onSave?.(this.report)
    if (act === 'clearA') {
      this.saved = null
      save(KEY.saved, null)
      return this.render()
    }
    if (act === 'optimize') return this.optimize()
    if (act === 'apply' && this.opt) {
      const i = +el.dataset.i!
      this.spec = structuredClone(this.opt.specs[i])
      this.spec.from = s.from
      this.spec.to = s.to
      this.changed(false)
      toast('Parameters applied. Run it to see the full result.', 'good')
      return this.show('strategy')
    }
  }

  private onInput(e: Event, commit: boolean) {
    const el = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    const s = this.spec
    if (el.dataset.src && commit) {
      // operand source changed: reset its parameters to the defaults
      setPath(s, el.dataset.src, operand(el.value))
      s.name = ''
      return this.changed(true)
    }
    if (el.dataset.date && commit) {
      const v = el.value ? parseZoned(el.value, this.o.zone()) : null
      const key = el.dataset.date as 'from' | 'to'
      s[key] = v === null ? null : key === 'to' ? v + 86400 : v
      return this.changed(false)
    }
    if (el.dataset.opt) {
      if (!this.optForm) return
      const k = el.dataset.opt as keyof OptForm
      if (k === 'p1' || k === 'p2') {
        ;(this.optForm[k] as string) = el.value
        if (commit) {
          this.fillRange(k === 'p1' ? 1 : 2)
          this.render()
        }
      } else (this.optForm[k] as number) = parseFloat(el.value)
      const c = this.body.querySelector('.bt-combos')
      if (c) c.textContent = this.comboText()
      return
    }
    const path = el.dataset.path
    if (!path) return
    let v: unknown = el.value
    if (el instanceof HTMLInputElement && el.type === 'checkbox') v = el.checked
    else if ((el instanceof HTMLInputElement && el.type === 'number') || typeof getPath(s, path) === 'number') {
      const n = parseFloat(el.value)
      if (!Number.isFinite(n)) return
      v = n
    }
    if (getPath(s, path) === v) return
    setPath(s, path, v)
    // edited rules are no longer the preset they started from
    if (/^(long|short|exit)/.test(path)) s.name = ''
    // choices that change which fields exist need a redraw; typing does not
    this.changed(commit && (/\.kind$/.test(path) || path === 'hours.on'))
  }

  private changed(rerender: boolean) {
    save(KEY.spec, this.spec)
    this.optForm = null
    if (rerender) return this.render()
    const sum = this.body.querySelector('[data-summary]')
    if (sum) sum.innerHTML = this.sentence()
    const err = this.body.querySelector('[data-err]')
    if (err) err.textContent = this.validate() ?? ''
  }

  // ---------- strategy tab ----------

  private dateValue(t: number | null, end: boolean) {
    if (t === null) return ''
    const shift = makeShifter(this.o.zone())
    return formatWall(shift(end ? t - 86400 : t), false)
  }

  /** Which period chip matches the current date range ('' = custom). */
  private periodKey(): string {
    const s = this.spec
    if (s.from === null && s.to === null) return 'all'
    if (s.to !== null || s.from === null) return ''
    const days = (this.o.span.to - s.from) / 86400
    const hit = PERIODS.find(([, d]) => d && Math.abs(days - d) < 1.5)
    return hit ? hit[0] : ''
  }

  /** The strategy in one or two plain sentences, updated as the form changes. */
  private sentence(): string {
    const s = this.spec
    const b = (t: string) => `<b>${esc(t)}</b>`
    const rules = (list: Cond[]) => list.map((c) => b(fmtCond(c))).join(' <i>and</i> ')
    const parts: string[] = []
    if (s.mode === 'code') parts.push('Signals from <b>JavaScript code</b>.')
    else {
      if (s.long.length) parts.push(`<span class="pos">BUY</span> when ${rules(s.long)}.`)
      if (s.short.length) parts.push(`<span class="neg">SELL</span> when ${rules(s.short)}.`)
      if (!s.long.length && !s.short.length) parts.push('<span class="neg">No entry rules yet.</span>')
    }
    const sl = s.sl.kind === 'none' ? 'no stop loss' : s.sl.kind === 'atr' ? `SL ${b(`${s.sl.value}× ATR`)}` : `SL ${b(`$${s.sl.value}`)}`
    const tp =
      s.tp.kind === 'none' ? 'no take profit' : s.tp.kind === 'rr' ? `TP ${b(`${s.tp.value}× SL distance`)}` : s.tp.kind === 'atr' ? `TP ${b(`${s.tp.value}× ATR`)}` : `TP ${b(`$${s.tp.value}`)}`
    const size = s.sizing.kind === 'risk' ? `risk ${b(`${s.sizing.value}%`)} of balance per trade` : b(`${s.sizing.value} lot`)
    parts.push(`${sl}, ${tp}, ${size}.`)
    const per = PERIODS.find(([k]) => k === this.periodKey())
    parts.push(`<span class="bt-muted">Candle ${s.tf} · ${per ? per[2] : 'custom date range'}${s.hours.on ? ` · entries ${s.hours.from}–${s.hours.to}h` : ''}</span>`)
    return parts.join(' ')
  }

  private strategyHtml(): string {
    const s = this.spec
    const shift = makeShifter(this.o.zone())
    const spanText = `${formatWall(shift(this.o.span.from), false)} to ${formatWall(shift(this.o.span.to), false)}`
    const opt = (v: string, label: string, cur: string) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`
    const per = this.periodKey()
    const err = this.validate()
    return `
      <div class="st">
        <div class="st-summary" data-summary>${this.sentence()}</div>

        <section class="st-sec">
          <h4><i>1</i> Pick a starting point</h4>
          <div class="st-chips">${PRESETS.map((p, i) => `<button type="button" class="st-chip" data-act="preset" data-v="${i}" aria-pressed="${p.name === s.name}">${esc(p.name)}</button>`).join('')}
            <button type="button" class="st-chip" data-act="mode" data-v="${s.mode === 'code' ? 'rules' : 'code'}">${s.mode === 'code' ? '← Back to rules' : '{ } Write JS code'}</button></div>
          <p class="bt-hint">An example fills in the rules below. Then change whatever you like.</p>
        </section>

        <section class="st-sec">
          <h4><i>2</i> Data</h4>
          <div class="st-row"><span class="st-lab">Candle</span><div class="bt-seg">${TIMEFRAMES.map((t) => `<button type="button" data-act="tf" data-v="${t}" aria-pressed="${t === s.tf}">${t}</button>`).join('')}</div></div>
          <div class="st-row"><span class="st-lab">Period</span><div class="bt-seg">${PERIODS.map(([k, , l]) => `<button type="button" data-act="period" data-v="${k}" aria-pressed="${k === per}">${l}</button>`).join('')}
            <button type="button" data-act="period" data-v="custom" aria-pressed="${per === ''}">Pick dates</button></div></div>
          ${per === '' ? `<div class="st-row"><span class="st-lab"></span><div class="st-dates"><input type="date" data-date="from" value="${this.dateValue(s.from, false)}" aria-label="From date" /><span class="bt-muted">to</span><input type="date" data-date="to" value="${this.dateValue(s.to, true)}" aria-label="To date" /></div></div>` : ''}
          <p class="bt-hint">Data available ${spanText}.</p>
        </section>

        ${s.mode === 'rules' ? this.rulesHtml() : this.codeHtml()}

        <section class="st-sec">
          <h4><i>4</i> Exits & position size</h4>
          <div class="st-grid">
            <label class="st-field"><span>Stop loss</span><div class="bt-pair">
              <select data-path="sl.kind">${opt('atr', '× ATR(14)', s.sl.kind)}${opt('price', 'Distance $', s.sl.kind)}${opt('none', 'No SL', s.sl.kind)}</select>
              ${s.sl.kind === 'none' ? '' : `<input type="number" step="any" min="0" data-path="sl.value" value="${s.sl.value}" aria-label="SL value" />`}</div></label>
            <label class="st-field"><span>Take profit</span><div class="bt-pair">
              <select data-path="tp.kind">${opt('rr', '× SL distance (R:R)', s.tp.kind)}${opt('atr', '× ATR(14)', s.tp.kind)}${opt('price', 'Distance $', s.tp.kind)}${opt('none', 'No TP', s.tp.kind)}</select>
              ${s.tp.kind === 'none' ? '' : `<input type="number" step="any" min="0" data-path="tp.value" value="${s.tp.value}" aria-label="TP value" />`}</div></label>
            <label class="st-field"><span>Position size</span><div class="bt-pair">
              <select data-path="sizing.kind">${opt('risk', '% of balance at risk', s.sizing.kind)}${opt('fixed', 'Fixed lots', s.sizing.kind)}</select>
              <input type="number" step="any" min="0.01" data-path="sizing.value" value="${s.sizing.value}" aria-label="Size value" /></div></label>
          </div>
          <p class="bt-hint">ATR = average candle range over the last 14, so the SL widens when the market is busy. "% of balance" sizes the lots so hitting the SL loses exactly that percentage.</p>
          <details class="st-more"${s.hours.on || s.reverse || s.maxBars > 0 || s.commission > 0 || s.slippage > 0 ? ' open' : ''}>
            <summary>Advanced: trading hours, capital, costs</summary>
            <div class="st-grid">
              <div class="st-field"><span><label><input type="checkbox" data-path="hours.on"${s.hours.on ? ' checked' : ''} /> Only enter between</label></span><div class="bt-pair">
                <input type="number" min="0" max="23" step="1" data-path="hours.from" value="${s.hours.from}" aria-label="Start hour"${s.hours.on ? '' : ' disabled'} />
                <span class="bt-muted">and</span>
                <input type="number" min="0" max="24" step="1" data-path="hours.to" value="${s.hours.to}" aria-label="End hour"${s.hours.on ? '' : ' disabled'} /></div></div>
              <label class="st-field"><span>Force close after</span><div class="bt-pair"><input type="number" min="0" step="1" data-path="maxBars" value="${s.maxBars}" /><span class="bt-muted">candles (0 = never)</span></div></label>
              <label class="st-field"><span>Starting balance $</span><input type="number" min="100" step="100" data-path="balance" value="${s.balance}" /></label>
              <label class="st-field"><span>Leverage</span><select data-path="leverage">${[50, 100, 200, 500, 1000].map((l) => `<option value="${l}"${l === s.leverage ? ' selected' : ''}>1:${l}</option>`).join('')}</select></label>
              <label class="st-field"><span>Commission per lot $</span><input type="number" min="0" step="0.5" data-path="commission" value="${s.commission}" /></label>
              <label class="st-field"><span>Slippage $</span><input type="number" min="0" step="0.01" data-path="slippage" value="${s.slippage}" /></label>
            </div>
            <label class="st-check"><input type="checkbox" data-path="reverse"${s.reverse ? ' checked' : ''} /> An opposite signal closes the position and opens the other way</label>
            <p class="bt-hint">Hours follow the chart time zone. E.g. 14–23 WIB (UTC+7) = London + New York sessions.</p>
          </details>
        </section>

        <div class="st-go">
          <p class="st-err" data-err>${err ? esc(err) : ''}</p>
          <button type="button" class="primary st-run" data-act="run">${this.running ? '■ Cancel' : '▶ Run backtest'}</button>
          <span class="bt-muted bt-kbd">or Ctrl+Enter</span>
        </div>
      </div>`
  }

  private operandHtml(path: string, o: Cond['a']): string {
    const groups = new Map<string, string[]>()
    for (const [k, src] of Object.entries(SOURCES)) {
      const g = groups.get(src.group) ?? []
      g.push(`<option value="${k}"${k === o.src ? ' selected' : ''}>${esc(src.label)}</option>`)
      groups.set(src.group, g)
    }
    const sel = [...groups].map(([g, opts]) => `<optgroup label="${g}">${opts.join('')}</optgroup>`).join('')
    const params = SOURCES[o.src].params
      .map(
        (p, j) =>
          `<label class="st-param"><small>${esc(p.name)}</small><input type="number" step="any" data-path="${path}.p.${j}" value="${o.p[j]}" aria-label="${esc(SOURCES[o.src].label)} ${esc(p.name)}" /></label>`,
      )
      .join('')
    return `<span class="st-operand"><select data-src="${path}" aria-label="Indicator or price">${sel}</select>${params}</span>`
  }

  private condList(list: (typeof LISTS)[number][0]): string {
    const ops = (cur: Op) => (Object.keys(OPS) as Op[]).map((k) => `<option value="${k}"${k === cur ? ' selected' : ''}>${OPS[k]}</option>`).join('')
    return this.spec[list]
      .map((c, i) => {
        const p = `${list}.${i}`
        return `<div class="st-cond">${i ? '<span class="st-and">and</span>' : ''}
          ${this.operandHtml(`${p}.a`, c.a)}
          <select data-path="${p}.op" class="st-op" aria-label="Comparison">${ops(c.op)}</select>
          ${this.operandHtml(`${p}.b`, c.b)}
          <button type="button" class="st-del" data-act="del" data-list="${list}" data-i="${i}" aria-label="Remove condition" title="Remove condition">✕</button></div>`
      })
      .join('')
  }

  private rulesHtml(): string {
    const s = this.spec
    const side = (list: 'long' | 'short', title: string, cls: string) => `
      <div class="st-side ${cls}">
        <h5>${title}</h5>
        ${this.condList(list) || '<p class="bt-muted">Never ' + (list === 'long' ? 'buys' : 'sells') + '.</p>'}
        <div class="st-side-acts">
          <button type="button" class="bt-add" data-act="add" data-list="${list}">+ Add condition</button>
          ${list === 'short' && s.long.length ? '<button type="button" class="bt-link" data-act="mirror" title="Fill the sell conditions with the mirror of the buy conditions">Mirror the buy side</button>' : ''}
        </div>
      </div>`
    const exits = s.exitLong.length + s.exitShort.length > 0
    return `
      <section class="st-sec">
        <h4><i>3</i> When to enter</h4>
        <div class="st-sides">${side('long', 'BUY when all of these are true', 'buy')}${side('short', 'SELL when all of these are true', 'sell')}</div>
        <p class="bt-hint">Checked at every candle close; orders fill at the next candle's open. "Crosses above" = below on the previous candle, above on this one.</p>
        <details class="st-more"${exits ? ' open' : ''}>
          <summary>Close positions on a signal (optional, besides SL/TP)</summary>
          <div class="st-sides">
            <div class="st-side buy"><h5>Close BUY when</h5>${this.condList('exitLong') || '<p class="bt-muted">SL/TP only.</p>'}<div class="st-side-acts"><button type="button" class="bt-add" data-act="add" data-list="exitLong">+ Add condition</button></div></div>
            <div class="st-side sell"><h5>Close SELL when</h5>${this.condList('exitShort') || '<p class="bt-muted">SL/TP only.</p>'}<div class="st-side-acts"><button type="button" class="bt-add" data-act="add" data-list="exitShort">+ Add condition</button></div></div>
          </div>
        </details>
      </section>`
  }

  private codeHtml(): string {
    return `<section class="st-sec"><h4><i>3</i> JavaScript code <button type="button" class="bt-link" data-act="reset-code">restore example</button></h4>
      <textarea class="bt-code" data-path="code" spellcheck="false" aria-label="Strategy code">${esc(this.spec.code)}</textarea>
      <p class="bt-hint">The code runs in a Web Worker, apart from the page. Never paste code from someone you do not trust.</p></section>`
  }

  /** Load a backtest saved on the account: as the strategy to edit, or as comparison A. */
  loadSaved(b: { spec: unknown; metrics: Metrics; curve: { t: number[]; v: number[] }; from: number; to: number }, asCompare: boolean) {
    const spec = normalize(b.spec as Partial<StrategySpec>)
    if (asCompare) {
      this.saved = { spec, metrics: b.metrics, curve: b.curve, from: b.from, to: b.to }
      save(KEY.saved, this.saved)
      return this.show('compare')
    }
    this.spec = spec
    this.changed(false)
    this.show('strategy')
  }

  // ---------- run ----------

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      this.worker.addEventListener('message', (e: MessageEvent<WorkerOut>) => this.onMessage(e.data))
      this.worker.addEventListener('error', (e) => {
        this.setRunning(false, '')
        toast(`Worker error: ${e.message}`, 'bad')
      })
    }
    return this.worker
  }

  private validate(): string | null {
    const s = this.spec
    if (s.mode === 'rules' && !s.long.length && !s.short.length) return 'Add at least one buy or sell condition.'
    if (s.sizing.kind === 'risk' && s.sl.kind === 'none') return 'Sizing by "% of balance" needs a stop loss. Use an SL or fixed lots.'
    if (s.tp.kind === 'rr' && s.sl.kind === 'none') return 'An R:R take profit needs a stop loss.'
    if (!(s.sizing.value > 0)) return 'Position size must be above 0.'
    if (s.from !== null && s.to !== null && s.to <= s.from) return 'The "To" date must be after the "From" date.'
    return null
  }

  private post(msg: WorkerIn) {
    this.getWorker().postMessage(msg)
  }

  run() {
    const err = this.validate()
    if (err) return toast(err, 'bad')
    this.setRunning(true, 'Starting…')
    this.post({ id: ++this.jobId, kind: 'run', spec: structuredClone(this.spec), zone: this.o.zone(), symbol: current().symbol })
  }

  private cancel() {
    this.worker?.terminate()
    this.worker = null
    this.jobId++
    this.setRunning(false, 'Cancelled')
  }

  private setRunning(on: boolean, text: string) {
    this.running = on
    this.status.textContent = text
    this.runBtn.textContent = on ? '■ Cancel' : '▶ Run'
    this.runBtn.classList.toggle('primary', !on)
    const sb = this.body.querySelector<HTMLButtonElement>('.st-run')
    if (sb) sb.textContent = on ? '■ Cancel' : '▶ Run backtest'
    const ob = this.body.querySelector<HTMLButtonElement>('[data-act="optimize"]')
    if (ob) ob.disabled = on
  }

  private onMessage(m: WorkerOut) {
    if (m.id !== this.jobId) return
    if (m.kind === 'progress') return void (this.status.textContent = m.text)
    if (m.kind === 'error') {
      this.setRunning(false, '')
      return toast(m.message, 'bad')
    }
    if (m.kind === 'result') {
      this.report = m.report
      this.setRunning(false, `${m.report.metrics.trades} trades · ${(m.report.ms / 1000).toFixed(1)} s`)
      this.o.onTrades(m.report.trades)
      return this.show('result')
    }
    if (m.kind === 'optimized' && this.opt) {
      this.opt.rows = m.rows
      this.opt.isEnd = m.isEnd
      this.setRunning(false, `${m.rows.length} combinations done`)
      return this.show('optimize')
    }
  }

  // ---------- result tab ----------

  private hourOf() {
    const shift = makeShifter(this.o.zone())
    return {
      hour: (t: number) => new Date(shift(t) * 1000).getUTCHours(),
      day: (t: number) => new Date(shift(t) * 1000).getUTCDay(),
      fmt: (t: number) => formatWall(shift(t)),
      date: (t: number) => formatWall(shift(t), false),
    }
  }

  private resultHtml(): string {
    const r = this.report
    if (!r) return '<p class="bt-empty">No results yet. Set up a strategy and click <b>Run</b>.</p>'
    const m = r.metrics
    const z = this.hourOf()
    const tile = (label: string, value: string, sub = '', c = '') => `<div class="bt-tile"><span>${label}</span><b class="${c}">${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
    const notes: string[] = []
    if (m.trades < 30) notes.push(`<li class="warn">Only ${m.trades} trades: a small sample, so the result is not reliable yet. Use a longer date range.</li>`)
    const sk = Object.entries(r.skipped)
    if (sk.length) notes.push(`<li>Signals not traded: ${sk.map(([k, v]) => `${esc(k)} (${v})`).join(', ')}.</li>`)
    notes.push('<li>Spread comes from broker data. Overnight swap is not included. Past results do not guarantee future results.</li>')

    const zoneLabel = this.o.zone() === 'UTC' ? 'UTC' : this.o.zone().split('/').pop()!.replace('_', ' ')
    const byHour = breakdown(r.trades, [...Array(24).keys()].map(String), (t) => String(z.hour(t.openTime)))
    const byDay = breakdown(r.trades, ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'], (t) => DAYS[z.day(t.openTime)])
    const bySess = breakdown(r.trades, SESSIONS, (t) => sessionOf(t.openTime))
    return `
      <p class="bt-sum">${esc(describe(r.spec))}<br /><span class="bt-muted">${z.date(r.from)} to ${z.date(r.to)} · ${r.bars.toLocaleString('en-US')} ${r.spec.tf} candles · SL/TP checked on ${r.exec}</span></p>
      <div class="bt-tiles">
        ${tile('Net profit', usd(m.net, true), pct(m.netPct, true), cls(m.net))}
        ${tile('Trades', String(m.trades), `buy ${m.long.trades} · sell ${m.short.trades}`)}
        ${tile('Win rate', pct(m.winRate), `${m.wins} wins`)}
        ${tile('Profit factor', num(m.profitFactor), 'gross profit ÷ gross loss')}
        ${tile('Max drawdown', usd(-m.maxDd), pct(-m.maxDdPct), m.maxDd > 0 ? 'neg' : '')}
        ${tile('Average R', Number.isFinite(m.avgR) ? num(m.avgR) + 'R' : '–', 'result ÷ initial risk', cls(m.avgR))}
        ${tile('Expectancy', usd(m.expectancy, true), 'average per trade', cls(m.expectancy))}
        ${tile('Sharpe', num(m.sharpe), 'daily, annualised')}
        ${tile('Average win', usd(m.avgWin), `loss ${usd(m.avgLoss)}`)}
        ${tile('Losing streak', String(m.maxLossStreak), `average length ${num(m.avgBars, 1)} candles`)}
        ${tile('Buy', usd(m.long.net, true), `win ${pct(m.long.winRate)}`, cls(m.long.net))}
        ${tile('Sell', usd(m.short.net, true), `win ${pct(m.short.winRate)}`, cls(m.short.net))}
      </div>
      <div class="bt-canvas"><canvas data-curve="result" aria-label="Equity and drawdown curve"></canvas></div>
      <ul class="bt-notes">${notes.join('')}</ul>
      <div class="bt-cols bt-breakdowns">
        ${this.breakdownHtml(`Entry hour (${esc(zoneLabel)})`, byHour.filter((x) => x.trades), (k) => k.padStart(2, '0') + ':00')}
        ${this.breakdownHtml('Day', byDay)}
        ${this.breakdownHtml('Session (UTC hours)', bySess)}
      </div>
      <div class="bt-actions"><button type="button" data-act="saveA">Save as A to compare</button>${this.o.onSave ? '<button type="button" data-act="save-acct">Save to account</button>' : ''}</div>`
  }

  private breakdownHtml(title: string, rows: { key: string; trades: number; winRate: number; net: number }[], label = (k: string) => k): string {
    const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)))
    const body = rows
      .map(
        (r) => `<tr><td>${label(r.key)}</td><td>${r.trades}</td><td>${r.trades ? pct(r.winRate) : '–'}</td>
          <td class="bt-barcell"><i class="${r.net >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(r.net) / max) * 100}%"></i><span class="${cls(r.net)}">${usd(r.net, true)}</span></td></tr>`,
      )
      .join('')
    return `<section class="bt-card"><h4>${title}</h4><div class="bt-scroll"><table class="bt-table"><thead><tr><th></th><th>Trades</th><th>Win</th><th>Net</th></tr></thead><tbody>${body || '<tr><td colspan="4" class="bt-muted">No trades.</td></tr>'}</tbody></table></div></section>`
  }

  // ---------- trades tab ----------

  private tradesHtml(): string {
    const r = this.report
    if (!r) return '<p class="bt-empty">No results yet.</p>'
    if (!r.trades.length) return '<p class="bt-empty">The strategy opened no trades in this range.</p>'
    const z = this.hourOf()
    const LIMIT = 2000
    const rows = r.trades
      .slice(0, LIMIT)
      .map(
        (t, i) => `<tr data-jump="${i}" tabindex="0"><td>${i + 1}</td><td class="${t.side === 'buy' ? 'buy' : 'sell'}">${t.side.toUpperCase()}</td>
          <td>${z.fmt(t.openTime)}</td><td>${px(t.entry)}</td><td>${z.fmt(t.closeTime)}</td><td>${px(t.exit)}</td>
          <td>${REASON[t.reason] ?? t.reason}</td><td>${t.lots.toFixed(2)}</td><td class="${cls(t.pnl)}">${usd(t.pnl, true)}</td>
          <td class="${cls(t.r ?? 0)}">${t.r === null ? '–' : t.r.toFixed(2) + 'R'}</td></tr>`,
      )
      .join('')
    return `<p class="bt-hint">Click a row to jump to its candle on the chart (timeframe follows the strategy).${r.trades.length > LIMIT ? ` Showing ${LIMIT} of ${r.trades.length} trades.` : ''}</p>
      <div class="bt-scroll bt-trades"><table class="bt-table"><thead><tr><th>#</th><th>Side</th><th>Entry</th><th>Price</th><th>Exit</th><th>Price</th><th>Reason</th><th>Lots</th><th>P/L</th><th>R</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
  }

  // ---------- optimize tab ----------

  private fillRange(slot: 1 | 2) {
    const f = this.optForm!
    const id = slot === 1 ? f.p1 : f.p2
    const p = listParams(this.spec).find((x) => x.id === id)
    if (!p) return
    const v = p.value
    const isInt = Number.isInteger(v) && v >= 2
    const a = isInt ? Math.max(1, Math.round(v * 0.5)) : +(v * 0.5).toFixed(2)
    const b = isInt ? Math.round(v * 1.5) : +(v * 1.5).toFixed(2)
    const s = isInt ? Math.max(1, Math.round((b - a) / 5)) : +((b - a) / 5).toFixed(2) || 0.1
    if (slot === 1) Object.assign(f, { a1: a, b1: b, s1: s })
    else Object.assign(f, { a2: a, b2: b, s2: s })
  }

  private values(a: number, b: number, s: number): number[] {
    if (!(s > 0) || !Number.isFinite(a) || !Number.isFinite(b) || b < a) return []
    const out: number[] = []
    for (let v = a; v <= b + 1e-9 && out.length <= MAX_COMBOS; v += s) out.push(+v.toFixed(6))
    return out
  }

  private combos(): [number[], number[] | null] {
    const f = this.optForm!
    const v1 = this.values(f.a1, f.b1, f.s1)
    const v2 = f.p2 ? this.values(f.a2, f.b2, f.s2) : null
    return [v1, v2]
  }

  private comboText(): string {
    const [v1, v2] = this.combos()
    const n = v1.length * (v2 ? v2.length : 1)
    return n > MAX_COMBOS ? `${n} combinations (max ${MAX_COMBOS})` : `${n} combinations`
  }

  private optimizeHtml(): string {
    const params = listParams(this.spec)
    if (!params.length) return '<p class="bt-empty">This strategy has no numeric parameters to optimise.</p>'
    if (!this.optForm || !params.some((p) => p.id === this.optForm!.p1)) {
      this.optForm = { p1: params[0].id, a1: 0, b1: 0, s1: 1, p2: '', a2: 0, b2: 0, s2: 1 }
      this.fillRange(1)
    }
    const f = this.optForm
    const sel = (key: 'p1' | 'p2', cur: string, none: boolean) =>
      `<select data-opt="${key}">${none ? `<option value="">— none —</option>` : ''}${params.map((p) => `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`
    const range = (n: 1 | 2) =>
      `<input type="number" step="any" data-opt="a${n}" value="${f[`a${n}`]}" aria-label="From" /><span class="bt-muted">to</span>
       <input type="number" step="any" data-opt="b${n}" value="${f[`b${n}`]}" aria-label="To" /><span class="bt-muted">step</span>
       <input type="number" step="any" data-opt="s${n}" value="${f[`s${n}`]}" aria-label="Step" />`
    return `
      <section class="bt-card">
        <h4>Parameter optimisation</h4>
        <p class="bt-hint">The data is split in two: the first ${SPLIT * 100}% finds the best parameters (training data), the last ${Math.round((1 - SPLIT) * 100)}% tests them (test data). The test result is what counts.</p>
        <div class="bt-optrow"><span>Parameter 1</span>${sel('p1', f.p1, false)}${range(1)}</div>
        <div class="bt-optrow"><span>Parameter 2</span>${sel('p2', f.p2, true)}${f.p2 ? range(2) : ''}</div>
        <div class="bt-optrow"><span class="bt-combos">${this.comboText()}</span><button type="button" class="primary" data-act="optimize"${this.running ? ' disabled' : ''}>Run optimisation</button></div>
      </section>
      ${this.optResultsHtml()}`
  }

  private optimize() {
    const err = this.validate()
    if (err) return toast(err, 'bad')
    const f = this.optForm
    if (!f) return
    const [v1, v2] = this.combos()
    const n = v1.length * (v2 ? v2.length : 1)
    if (!n) return toast('Invalid parameter range.', 'bad')
    if (n > MAX_COMBOS) return toast(`Too many combinations (${n}). The maximum is ${MAX_COMBOS}: use a bigger step.`, 'bad')
    const params = listParams(this.spec)
    const name = (id: string) => params.find((p) => p.id === id)?.label.replace(/\s*\([^)]*\)$/, '') ?? id
    const specs: StrategySpec[] = []
    const labels: [number, number | null][] = []
    for (const a of v1)
      for (const b of v2 ?? [null]) {
        const set: [string, number][] = [[f.p1, a]]
        if (b !== null) set.push([f.p2, b])
        specs.push(withParams(this.spec, set))
        labels.push([a, b])
      }
    this.opt = { rows: [], specs, labels, names: [name(f.p1), f.p2 ? name(f.p2) : null], isEnd: 0 }
    this.setRunning(true, 'Starting optimisation…')
    this.post({ id: ++this.jobId, kind: 'optimize', specs, split: SPLIT, zone: this.o.zone(), top: 5, symbol: current().symbol })
  }

  private optResultsHtml(): string {
    const o = this.opt
    if (!o || !o.rows.length) return ''
    const best = o.rows[0]
    const warn: string[] = []
    if (best.is.net > 0 && best.oos && best.oos.net < 0)
      warn.push('<li class="bad">The best parameters win on the training data but lose on the test data. That is overfitting: they just happen to fit the past.</li>')
    if (best.is.trades < 30) warn.push(`<li class="warn">The best combination has only ${best.is.trades} trades in the training data. The sample is too small.</li>`)
    warn.push(
      `<li>The more combinations you try (${o.rows.length}), the more likely the best one is luck. Pick parameters that win on the test data and whose neighbours win too, not the single highest.</li>`,
    )
    const z = this.hourOf()
    const rows = o.rows
      .map((r, rank) => {
        const [a, b] = o.labels[r.index]
        return `<tr><td>${rank + 1}</td><td>${a}</td>${o.names[1] ? `<td>${b}</td>` : ''}<td>${r.is.trades}</td><td>${pct(r.is.winRate)}</td>
          <td>${num(r.is.profitFactor)}</td><td class="neg">${pct(-r.is.maxDdPct)}</td><td class="${cls(r.is.net)}">${usd(r.is.net, true)}</td>
          <td class="${r.oos ? cls(r.oos.net) : ''}">${r.oos ? `${usd(r.oos.net, true)} <small>(${r.oos.trades})</small>` : ''}</td>
          <td><button type="button" class="bt-link" data-act="apply" data-i="${r.index}">Use</button></td></tr>`
      })
      .join('')
    return `<section class="bt-card bt-wide">
      <h4>Results (sorted by training net profit)</h4>
      <p class="bt-hint">Training data until ${z.date(o.isEnd)}; test data after that. The test is run for the top 5.</p>
      <ul class="bt-notes">${warn.join('')}</ul>
      <div class="bt-scroll bt-trades"><table class="bt-table"><thead><tr><th>#</th><th>${esc(o.names[0])}</th>${o.names[1] ? `<th>${esc(o.names[1])}</th>` : ''}
        <th>Trades</th><th>Win</th><th>PF</th><th>DD</th><th>Training net</th><th>Test net (trades)</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`
  }

  // ---------- compare tab ----------

  private compareHtml(): string {
    const A = this.saved
    const B = this.report
    if (!A) return '<p class="bt-empty">Run a backtest, then click <b>Save as A</b> in the Results tab. Change the strategy, run it again and compare here.</p>'
    const z = this.hourOf()
    const rows: [string, (m: Metrics) => string, (m: Metrics) => number][] = [
      ['Net profit', (m) => usd(m.net, true), (m) => m.net],
      ['Return', (m) => pct(m.netPct, true), (m) => m.netPct],
      ['Trades', (m) => String(m.trades), () => 0],
      ['Win rate', (m) => pct(m.winRate), (m) => m.winRate],
      ['Profit factor', (m) => num(m.profitFactor), (m) => (Number.isFinite(m.profitFactor) ? m.profitFactor : 1e9)],
      ['Max drawdown', (m) => pct(-m.maxDdPct), (m) => -m.maxDdPct],
      ['Average R', (m) => (Number.isFinite(m.avgR) ? num(m.avgR) + 'R' : '–'), (m) => (Number.isFinite(m.avgR) ? m.avgR : -1e9)],
      ['Expectancy', (m) => usd(m.expectancy, true), (m) => m.expectancy],
      ['Sharpe', (m) => num(m.sharpe), (m) => (Number.isFinite(m.sharpe) ? m.sharpe : -1e9)],
      ['Losing streak', (m) => String(m.maxLossStreak), (m) => -m.maxLossStreak],
    ]
    const body = rows
      .map(([label, f, score]) => {
        const better = B && label !== 'Trade' ? Math.sign(score(B.metrics) - score(A.metrics)) : 0
        return `<tr><td>${label}</td><td class="${better < 0 ? 'win' : ''}">${f(A.metrics)}</td><td class="${better > 0 ? 'win' : ''}">${B ? f(B.metrics) : '–'}</td></tr>`
      })
      .join('')
    return `<div class="bt-cols">
      <section class="bt-card bt-wide">
        <table class="bt-table bt-cmp"><thead><tr><th></th><th><i class="sw a"></i>A (saved)</th><th><i class="sw b"></i>B (latest result)</th></tr></thead>
        <tbody><tr><td>Strategy</td><td>${esc(describe(A.spec))}</td><td>${B ? esc(describe(B.spec)) : '–'}</td></tr>
        <tr><td>Range</td><td>${z.date(A.from)} to ${z.date(A.to)}</td><td>${B ? `${z.date(B.from)} to ${z.date(B.to)}` : '–'}</td></tr>${body}</tbody></table>
        <p class="bt-hint">Compare over the same date range to be fair. The better one is marked.</p>
        <button type="button" data-act="clearA">Clear A</button>
      </section>
      <section class="bt-card bt-wide"><h4>Equity curve</h4><div class="bt-canvas"><canvas data-curve="compare" aria-label="Equity curves A and B"></canvas></div></section>
    </div>`
  }

  // ---------- canvas ----------

  private redrawCanvases() {
    for (const c of this.body.querySelectorAll<HTMLCanvasElement>('canvas[data-curve]')) {
      if (c.dataset.curve === 'result' && this.report) drawCurves(c, [{ ...this.report.curve, color: '#4c8dff' }], this.report.spec.balance, true, this.report.metrics.maxDdPct)
      if (c.dataset.curve === 'compare' && this.saved) {
        const list = [{ ...this.saved.curve, color: '#f5a524' }]
        if (this.report) list.push({ ...this.report.curve, color: '#4c8dff' })
        drawCurves(c, list, this.saved.spec.balance, false)
      }
    }
  }
}

/** Equity line(s) over time; the first curve's drawdown is drawn as a red area in the bottom band. */
function drawCurves(canvas: HTMLCanvasElement, curves: { t: number[]; v: number[]; color: string }[], start: number, withDd: boolean, ddLabel = NaN) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const g = canvas.getContext('2d')!
  g.scale(dpr, dpr)
  g.clearRect(0, 0, w, h)
  const pts = curves.filter((c) => c.v.length)
  if (!pts.length) return
  const t0 = Math.min(...pts.map((c) => c.t[0]))
  const t1 = Math.max(...pts.map((c) => c.t[c.t.length - 1]))
  let lo = start
  let hi = start
  for (const c of pts) for (const v of c.v) (lo = Math.min(lo, v)), (hi = Math.max(hi, v))
  const pad = (hi - lo) * 0.08 || 1
  lo -= pad
  hi += pad
  const left = 64
  const ddH = withDd ? Math.round(h * 0.24) : 0
  const top = 8
  const bottom = h - ddH - (withDd ? 10 : 8)
  const x = (t: number) => left + ((t - t0) / Math.max(1, t1 - t0)) * (w - left - 8)
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (bottom - top)

  g.font = '11px ui-sans-serif, system-ui, sans-serif'
  g.fillStyle = '#7d8590'
  g.textBaseline = 'middle'
  const used: number[] = []
  for (const v of [start, hi - pad, lo + pad]) {
    if (used.some((u) => Math.abs(u - y(v)) < 14)) continue
    used.push(y(v))
    g.fillText(money.format(Math.round(v)).replace('.00', ''), 4, y(v))
  }
  g.strokeStyle = '#2a3140'
  g.setLineDash([4, 4])
  g.beginPath()
  g.moveTo(left, y(start))
  g.lineTo(w - 8, y(start))
  g.stroke()
  g.setLineDash([])

  for (const c of pts) {
    g.strokeStyle = c.color
    g.lineWidth = 1.5
    g.beginPath()
    c.v.forEach((v, i) => (i ? g.lineTo(x(c.t[i]), y(v)) : g.moveTo(x(c.t[i]), y(v))))
    g.stroke()
  }

  if (withDd) {
    const c = pts[0]
    let peak = start
    const dd = c.v.map((v) => {
      peak = Math.max(peak, v)
      return peak > 0 ? (peak - v) / peak : 0
    })
    const maxDd = Math.max(...dd, 1e-9)
    const base = h - ddH
    g.fillStyle = 'rgba(239,83,80,0.35)'
    g.beginPath()
    g.moveTo(x(c.t[0]), base)
    dd.forEach((d, i) => g.lineTo(x(c.t[i]), base + (d / maxDd) * (ddH - 4)))
    g.lineTo(x(c.t[c.t.length - 1]), base)
    g.closePath()
    g.fill()
    g.fillStyle = '#7d8590'
    g.fillText('Drawdown', 4, base + 8)
    g.fillText(`-${((Number.isFinite(ddLabel) ? ddLabel : maxDd) * 100).toFixed(1)}%`, 4, h - 8)
  }
}
