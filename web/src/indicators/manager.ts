import type { Time } from 'lightweight-charts'
import type { Bar } from '../data'
import { tradingDay } from '../time'
import {
  INDICATORS,
  INDICATOR_BY_TYPE,
  defaultConfig,
  type Ctx,
  type Env,
  type IndicatorConfig,
  type IndicatorDef,
  type Instance,
} from './registry'

/** Indicators that only make sense once on a chart. */
const SINGLETON = new Set(['sessions', 'vwap', 'pivots'])

const ICON_GEAR =
  '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/></svg>'
const ICON_X = '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>'

export class IndicatorManager {
  configs: IndicatorConfig[] = []
  private readonly instances = new Map<string, Instance>()
  private ctx: Ctx | null = null
  private lastIndex = -1
  private readonly paneChipEls: HTMLElement[] = []
  private readonly paneBoxes = new Map<number, HTMLElement>()
  onSave: (list: IndicatorConfig[]) => void = () => {}

  constructor(
    private readonly env: Env,
    private readonly chipsEl: HTMLElement,
    private readonly paneLayer: HTMLElement,
    private readonly dialog: HTMLDialogElement,
  ) {
    // The chart lays out panes on its own schedule (resize, pane drag, add/remove),
    // so re-check pane chip positions every frame; DOM is only written when something moved.
    const tick = () => {
      this.positionPaneChips()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  load(list: IndicatorConfig[]) {
    for (const cfg of list) {
      const def = INDICATOR_BY_TYPE[cfg.type]
      if (!def) continue
      // fill params/colors added in newer versions
      const base = defaultConfig(def)
      const merged = { ...cfg, params: { ...base.params, ...cfg.params }, colors: { ...base.colors, ...cfg.colors } }
      this.configs.push(merged)
      this.instances.set(merged.id, def.create(this.env, merged))
    }
    this.renderChips()
  }

  has(type: string) {
    return this.configs.some((c) => c.type === type)
  }

  canAdd(def: IndicatorDef) {
    return !(SINGLETON.has(def.type) && this.has(def.type))
  }

  add(type: string) {
    const def = INDICATOR_BY_TYPE[type]
    if (!def || !this.canAdd(def)) return
    const cfg = defaultConfig(def)
    this.configs.push(cfg)
    const inst = def.create(this.env, cfg)
    this.instances.set(cfg.id, inst)
    if (this.ctx) inst.update({ ...this.ctx, incremental: false })
    this.save()
  }

  remove(id: string) {
    this.instances.get(id)?.destroy()
    this.instances.delete(id)
    this.configs = this.configs.filter((c) => c.id !== id)
    this.dropEmptyPanes()
    this.save()
  }

  /** Recompute every indicator for the bars currently loaded on the chart. */
  update(bars: Bar[], times: Time[], tfSec: number, incremental = false) {
    const n = bars.length
    const ctx: Ctx = {
      times,
      rawTimes: new Float64Array(n),
      o: new Float64Array(n),
      h: new Float64Array(n),
      l: new Float64Array(n),
      c: new Float64Array(n),
      v: new Float64Array(n),
      day: new Float64Array(n),
      intraday: tfSec < 86400,
      tfSec,
      incremental,
    }
    for (let i = 0; i < n; i++) {
      const b = bars[i]
      ctx.rawTimes[i] = b.time
      ctx.o[i] = b.open
      ctx.h[i] = b.high
      ctx.l[i] = b.low
      ctx.c[i] = b.close
      ctx.v[i] = b.volume
      ctx.day[i] = tradingDay(b.time)
    }
    this.ctx = ctx
    this.lastIndex = -1 // old crosshair index belongs to the previous bar window
    for (const inst of this.instances.values()) inst.update(ctx)
    this.renderChips()
  }

  /** Update chip values for the bar under the crosshair (or the last bar). */
  legend(i: number) {
    this.lastIndex = i
    this.positionPaneChips()
    for (const cfg of this.configs) {
      const el = document.querySelector<HTMLElement>(`[data-ind="${cfg.id}"] .chip-vals`)
      const inst = this.instances.get(cfg.id)
      if (!el || !inst) continue
      el.innerHTML = inst
        .values(i)
        .map(([label, value, color]) =>
          value === ''
            ? `<span style="color:${color}">${label}</span>`
            : `<span style="color:${color}">${label ? `<span class="k">${label}</span>` : ''}${value}</span>`,
        )
        .join('')
    }
  }

  private save() {
    this.renderChips()
    this.onSave(this.configs)
  }

  private dropEmptyPanes() {
    const panes = this.env.chart.panes()
    // pane 0 = candles, pane 1 = volume; remove from the bottom so indices stay valid
    for (let i = panes.length - 1; i >= 2; i--) {
      if (panes[i].getSeries().length === 0) this.env.chart.removePane(i)
    }
  }

  // ---------- chips ----------

  private chip(cfg: IndicatorConfig): HTMLElement {
    const def = INDICATOR_BY_TYPE[cfg.type]
    const el = document.createElement('div')
    el.className = 'chip'
    el.dataset.ind = cfg.id
    el.innerHTML =
      `<span class="chip-name">${def.label(cfg)}</span><span class="chip-vals"></span>` +
      (def.params.length || def.colors.length
        ? `<button type="button" class="chip-btn" data-act="edit" title="Settings" aria-label="Settings for ${def.label(cfg)}">${ICON_GEAR}</button>`
        : '') +
      `<button type="button" class="chip-btn" data-act="remove" title="Remove" aria-label="Remove ${def.label(cfg)}">${ICON_X}</button>`
    el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act === 'remove') this.remove(cfg.id)
      if (act === 'edit') this.openEditor(cfg.id)
    })
    return el
  }

  collapsed = false
  onCollapse: (collapsed: boolean) => void = () => {}

  private renderChips() {
    this.chipsEl.replaceChildren()
    const overlays = this.configs.filter((c) => INDICATOR_BY_TYPE[c.type]?.place === 'overlay')
    if (overlays.length) {
      const t = document.createElement('button')
      t.type = 'button'
      t.className = 'chips-toggle'
      t.setAttribute('aria-expanded', String(!this.collapsed))
      t.textContent = this.collapsed ? `▸ ${overlays.length} indicators` : '▾ hide'
      t.addEventListener('click', () => {
        this.collapsed = !this.collapsed
        this.onCollapse(this.collapsed)
        this.renderChips()
      })
      this.chipsEl.append(t)
    }
    for (const el of this.paneChipEls) el.remove()
    this.paneChipEls.length = 0
    this.paneBoxes.clear()

    const byPane = new Map<number, HTMLElement>()
    for (const cfg of this.configs) {
      const def = INDICATOR_BY_TYPE[cfg.type]
      const inst = this.instances.get(cfg.id)
      if (!def || !inst) continue
      if (def.place === 'overlay') {
        if (!this.collapsed) this.chipsEl.append(this.chip(cfg))
        continue
      }
      const paneIdx = inst.pane()
      let box = byPane.get(paneIdx)
      if (!box) {
        box = document.createElement('div')
        box.className = 'pane-chips'
        this.paneLayer.append(box)
        byPane.set(paneIdx, box)
        this.paneChipEls.push(box)
        this.paneBoxes.set(paneIdx, box)
      }
      box.append(this.chip(cfg))
    }
    this.positionPaneChips()
    if (this.lastIndex >= 0 || this.ctx) this.legend(this.lastIndex >= 0 ? this.lastIndex : (this.ctx?.c.length ?? 1) - 1)
  }

  /**
   * Pane chips live in our own layer over the chart (lightweight-charts rebuilds its pane DOM),
   * placed at the top-left of each pane's plot area.
   */
  positionPaneChips() {
    if (!this.paneBoxes.size) return
    const base = this.paneLayer.getBoundingClientRect()
    const panes = this.env.chart.panes()
    for (const [idx, box] of this.paneBoxes) {
      const row = panes[idx]?.getHTMLElement()
      if (!row) {
        box.hidden = true
        continue
      }
      const r = row.getBoundingClientRect()
      const top = `${Math.round(r.top - base.top + 4)}px`
      const left = `${Math.round(r.left - base.left + 8)}px`
      if (box.hidden) box.hidden = false
      if (box.style.top !== top) box.style.top = top
      if (box.style.left !== left) box.style.left = left
    }
  }

  // ---------- add menu ----------

  buildMenu(menu: HTMLElement) {
    const groups: [string, IndicatorDef[]][] = [
      ['On the chart', INDICATORS.filter((d) => d.place === 'overlay')],
      ['Lower panel', INDICATORS.filter((d) => d.place === 'pane')],
    ]
    const render = () => {
      menu.replaceChildren()
      for (const [title, defs] of groups) {
        const h = document.createElement('div')
        h.className = 'menu-title'
        h.textContent = title
        menu.append(h)
        for (const def of defs) {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'menu-item'
          b.textContent = def.name
          b.disabled = !this.canAdd(def)
          if (b.disabled) b.title = 'Already on the chart'
          b.addEventListener('click', () => {
            this.add(def.type)
            render()
          })
          menu.append(b)
        }
      }
    }
    render()
    return render
  }

  // ---------- settings dialog ----------

  private openEditor(id: string) {
    const cfg = this.configs.find((c) => c.id === id)
    if (!cfg) return
    const def = INDICATOR_BY_TYPE[cfg.type]
    const d = this.dialog
    const before = structuredClone(cfg)
    d.innerHTML = `<form method="dialog" class="ind-form">
      <h2>${def.name}</h2>
      ${def.params
        .map(
          (p) => `<label><span>${p.label}</span>
            <input type="number" name="p:${p.key}" value="${cfg.params[p.key]}" min="${p.min}" max="${p.max}" step="${p.step}" required></label>`,
        )
        .join('')}
      ${def.colors
        .map((c) => `<label><span>${c.label}</span><input type="color" name="c:${c.key}" value="${cfg.colors[c.key]}"></label>`)
        .join('')}
      <div class="form-actions">
        <button type="button" data-act="reset">Default</button>
        <span class="spacer"></span>
        <button type="button" data-act="cancel">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>`
    const form = d.querySelector('form')!

    const apply = () => {
      for (const p of def.params) {
        const v = Number((form.elements.namedItem(`p:${p.key}`) as HTMLInputElement).value)
        if (Number.isFinite(v) && v >= p.min && v <= p.max) cfg.params[p.key] = v
      }
      for (const c of def.colors) cfg.colors[c.key] = (form.elements.namedItem(`c:${c.key}`) as HTMLInputElement).value
      this.refreshOne(cfg.id)
    }
    form.addEventListener('input', apply)
    form.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act === 'cancel') {
        Object.assign(cfg, structuredClone(before))
        this.refreshOne(cfg.id)
        d.close()
      } else if (act === 'reset') {
        const base = defaultConfig(def)
        for (const p of def.params) (form.elements.namedItem(`p:${p.key}`) as HTMLInputElement).value = String(base.params[p.key])
        for (const c of def.colors) (form.elements.namedItem(`c:${c.key}`) as HTMLInputElement).value = base.colors[c.key]
        apply()
      }
    })
    form.addEventListener('submit', () => {
      apply()
      this.save()
    })
    d.addEventListener(
      'cancel',
      () => {
        Object.assign(cfg, structuredClone(before))
        this.refreshOne(cfg.id)
      },
      { once: true },
    )
    d.showModal()
  }

  private refreshOne(id: string) {
    const inst = this.instances.get(id)
    if (!inst) return
    inst.restyle()
    if (this.ctx) inst.update({ ...this.ctx, incremental: false })
    this.renderChips()
  }
}
