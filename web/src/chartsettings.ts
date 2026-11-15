/**
 * Chart appearance, like TradingView's "Chart settings" dialog: candle colors (body, border, wick),
 * hollow candles, background, grid, crosshair, price scale mode, which lines and labels show.
 * Stored per browser in localStorage.
 */
import { ColorType, CrosshairMode, PriceScaleMode, type IChartApi, type ISeriesApi } from 'lightweight-charts'

export interface Look {
  candle: 'solid' | 'hollow'
  up: string
  down: string
  body: boolean
  border: boolean
  wick: boolean
  /** null = same as the body color */
  borderUp: string | null
  borderDown: string | null
  wickUp: string | null
  wickDown: string | null
  bg: string
  /** second background color for a vertical gradient; null = flat */
  bg2: string | null
  grid: 'both' | 'vert' | 'horz' | 'none'
  gridColor: string
  crosshair: 'normal' | 'magnet' | 'hidden'
  scale: 'normal' | 'log' | 'percent'
  textColor: string
  fontSize: number
  bidAsk: boolean
  volume: boolean
  /** big symbol + timeframe text behind the candles */
  watermark: boolean
  /** empty bars kept right of the last candle */
  rightOffset: number
}

export const DEFAULT_LOOK: Look = {
  candle: 'solid',
  up: '#2fd4b0',
  down: '#ff6b5e',
  body: true,
  border: false,
  wick: true,
  borderUp: null,
  borderDown: null,
  wickUp: null,
  wickDown: null,
  bg: '#0e0b1f',
  bg2: null,
  grid: 'both',
  gridColor: '#1a1636',
  crosshair: 'normal',
  scale: 'normal',
  textColor: '#a39bc6',
  fontSize: 12,
  bidAsk: true,
  volume: true,
  watermark: false,
  rightOffset: 10,
}

/** Ready-made looks, a quick start before fine-tuning. */
export const THEMES: { name: string; look: Partial<Look> }[] = [
  { name: 'Arena (default)', look: {} },
  { name: 'Neutral dark', look: { up: '#26a69a', down: '#ef5350', bg: '#0b0e14', gridColor: '#141924', textColor: '#7d8590' } },
  { name: 'Classic TradingView', look: { up: '#089981', down: '#f23645', bg: '#131722', gridColor: '#1e222d', textColor: '#b2b5be' } },
  { name: 'Hollow', look: { candle: 'hollow', up: '#e6e9ef', down: '#6b7280', border: true, grid: 'none', bg: '#000000' } },
  { name: 'Light', look: { up: '#089981', down: '#f23645', bg: '#ffffff', gridColor: '#f0f3fa', textColor: '#131722' } },
  { name: 'Night purple', look: { up: '#09bbc8', down: '#e0457b', bg: '#1b1540', bg2: '#07060f', gridColor: '#241d4f', textColor: '#9a8fc4' } },
]

const KEY = 'rc.v1.look'

export function loadLook(): Look {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULT_LOOK, ...(JSON.parse(raw) as Partial<Look>) } : { ...DEFAULT_LOOK }
  } catch {
    return { ...DEFAULT_LOOK }
  }
}

export function saveLook(l: Look) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l))
  } catch {
    /* storage blocked */
  }
}

/** rgba() of a hex color */
export function alpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

export function applyLook(chart: IChartApi, candles: ISeriesApi<'Candlestick'>, volume: ISeriesApi<'Histogram'>, l: Look) {
  const hollow = l.candle === 'hollow'
  candles.applyOptions({
    // hollow: rising candles keep only their outline
    upColor: hollow ? 'rgba(0,0,0,0)' : l.up,
    downColor: l.down,
    wickVisible: l.wick,
    borderVisible: l.border || hollow,
    borderUpColor: l.borderUp ?? l.up,
    borderDownColor: l.borderDown ?? l.down,
    wickUpColor: l.wickUp ?? l.up,
    wickDownColor: l.wickDown ?? l.down,
  })
  if (!l.body) candles.applyOptions({ upColor: 'rgba(0,0,0,0)', downColor: 'rgba(0,0,0,0)', borderVisible: true })
  chart.applyOptions({
    layout: {
      background: l.bg2 ? { type: ColorType.VerticalGradient, topColor: l.bg, bottomColor: l.bg2 } : { type: ColorType.Solid, color: l.bg },
      textColor: l.textColor,
      fontSize: l.fontSize,
    },
    grid: {
      vertLines: { visible: l.grid === 'both' || l.grid === 'vert', color: l.gridColor },
      horzLines: { visible: l.grid === 'both' || l.grid === 'horz', color: l.gridColor },
    },
    crosshair: {
      mode: l.crosshair === 'magnet' ? CrosshairMode.Magnet : l.crosshair === 'hidden' ? CrosshairMode.Hidden : CrosshairMode.Normal,
    },
    timeScale: { rightOffset: l.rightOffset },
  })
  chart.priceScale('right').applyOptions({
    mode: l.scale === 'log' ? PriceScaleMode.Logarithmic : l.scale === 'percent' ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
  })
  volume.applyOptions({ visible: l.volume })
}

type Field =
  | { k: keyof Look; label: string; type: 'color'; nullable?: string }
  | { k: keyof Look; label: string; type: 'check' }
  | { k: keyof Look; label: string; type: 'select'; options: [string, string][] }
  | { k: keyof Look; label: string; type: 'number'; min: number; max: number; step?: number }

const TABS: { id: string; title: string; fields: Field[] }[] = [
  {
    id: 'candle',
    title: 'Candle',
    fields: [
      { k: 'candle', label: 'Style', type: 'select', options: [['solid', 'Solid candles'], ['hollow', 'Hollow candles (up candles hollow)']] },
      { k: 'up', label: 'Up colour', type: 'color' },
      { k: 'down', label: 'Down colour', type: 'color' },
      { k: 'body', label: 'Body', type: 'check' },
      { k: 'border', label: 'Border', type: 'check' },
      { k: 'borderUp', label: 'Up border', type: 'color', nullable: 'same as body' },
      { k: 'borderDown', label: 'Down border', type: 'color', nullable: 'same as body' },
      { k: 'wick', label: 'Wick', type: 'check' },
      { k: 'wickUp', label: 'Up wick', type: 'color', nullable: 'same as body' },
      { k: 'wickDown', label: 'Down wick', type: 'color', nullable: 'same as body' },
    ],
  },
  {
    id: 'canvas',
    title: 'Background & grid',
    fields: [
      { k: 'bg', label: 'Background', type: 'color' },
      { k: 'bg2', label: 'Bottom gradient', type: 'color', nullable: 'no gradient' },
      { k: 'grid', label: 'Grid', type: 'select', options: [['both', 'Vertical + horizontal'], ['vert', 'Vertical only'], ['horz', 'Horizontal only'], ['none', 'No grid']] },
      { k: 'gridColor', label: 'Grid colour', type: 'color' },
      { k: 'textColor', label: 'Scale text colour', type: 'color' },
      { k: 'fontSize', label: 'Scale text size', type: 'number', min: 9, max: 18 },
      { k: 'watermark', label: 'Symbol + timeframe watermark', type: 'check' },
    ],
  },
  {
    id: 'scale',
    title: 'Scale & lines',
    fields: [
      { k: 'scale', label: 'Price scale', type: 'select', options: [['normal', 'Normal'], ['log', 'Logarithmic'], ['percent', 'Percent from the first candle']] },
      { k: 'crosshair', label: 'Crosshair', type: 'select', options: [['normal', 'Free'], ['magnet', 'Snap to close'], ['hidden', 'Hidden']] },
      { k: 'bidAsk', label: 'Bid / Ask lines', type: 'check' },
      { k: 'volume', label: 'Volume', type: 'check' },
      { k: 'rightOffset', label: 'Right margin (candles)', type: 'number', min: 0, max: 100 },
    ],
  },
]

/** The settings dialog. Every change applies live; Batal restores the look it opened with. */
export class ChartSettingsDialog {
  private readonly dlg: HTMLDialogElement
  private before: Look
  private tab = 'candle'

  constructor(
    private look: Look,
    private readonly onChange: (l: Look) => void,
  ) {
    this.before = { ...look }
    this.dlg = document.createElement('dialog')
    this.dlg.className = 'cs-dialog'
    document.body.append(this.dlg)
    this.dlg.addEventListener('click', (e) => this.onClick(e))
    this.dlg.addEventListener('input', (e) => this.onInput(e))
    this.dlg.addEventListener('change', (e) => this.onInput(e))
    this.dlg.addEventListener('cancel', () => this.set(this.before))
  }

  open(look: Look) {
    this.look = { ...look }
    this.before = { ...look }
    this.render()
    this.dlg.showModal()
  }

  private set(l: Look) {
    this.look = { ...l }
    this.onChange(this.look)
  }

  private render() {
    const l = this.look
    const t = TABS.find((x) => x.id === this.tab)!
    const field = (f: Field) => {
      const v = l[f.k]
      const id = `cs-${f.k}`
      if (f.type === 'check') return `<label class="cs-row cs-check"><input type="checkbox" id="${id}" data-k="${f.k}"${v ? ' checked' : ''} /> ${f.label}</label>`
      let ctl = ''
      if (f.type === 'color') {
        const val = (v as string | null) ?? (f.k.endsWith('Up') ? l.up : f.k.endsWith('Down') ? l.down : l.bg)
        ctl = `<input type="color" id="${id}" data-k="${f.k}" value="${val}"${v === null ? ' class="cs-off"' : ''} />`
        if (f.nullable) ctl += `<label class="cs-null"><input type="checkbox" data-null="${f.k}"${v === null ? ' checked' : ''} /> ${f.nullable}</label>`
      } else if (f.type === 'select') {
        ctl = `<select id="${id}" data-k="${f.k}">${f.options.map(([o, lab]) => `<option value="${o}"${o === v ? ' selected' : ''}>${lab}</option>`).join('')}</select>`
      } else {
        ctl = `<input type="number" id="${id}" data-k="${f.k}" min="${f.min}" max="${f.max}" step="${f.step ?? 1}" value="${v}" />`
      }
      return `<div class="cs-row"><label for="${id}">${f.label}</label><div class="cs-ctl">${ctl}</div></div>`
    }
    this.dlg.innerHTML = `
      <header class="cs-head"><b>Chart settings</b><button type="button" data-cs="cancel" aria-label="Close">✕</button></header>
      <div class="cs-themes"><span>Quick themes</span>${THEMES.map((th, i) => `<button type="button" data-theme="${i}">${th.name}</button>`).join('')}</div>
      <div class="cs-main">
        <nav class="cs-tabs">${TABS.map((x) => `<button type="button" data-tab="${x.id}" aria-selected="${x.id === this.tab}">${x.title}</button>`).join('')}</nav>
        <div class="cs-body">${t.fields.map(field).join('')}</div>
      </div>
      <footer class="cs-foot">
        <button type="button" data-cs="reset">Restore defaults</button>
        <span></span>
        <button type="button" data-cs="cancel">Cancel</button>
        <button type="button" class="primary" data-cs="ok">OK</button>
      </footer>`
  }

  private onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tab],[data-cs],[data-theme]')
    if (!el) {
      // click on the backdrop closes like Batal
      if (e.target === this.dlg) {
        this.set(this.before)
        this.dlg.close()
      }
      return
    }
    if (el.dataset.tab) {
      this.tab = el.dataset.tab
      return this.render()
    }
    if (el.dataset.theme) {
      this.set({ ...DEFAULT_LOOK, ...THEMES[+el.dataset.theme].look })
      return this.render()
    }
    const a = el.dataset.cs
    if (a === 'reset') {
      this.set({ ...DEFAULT_LOOK })
      return this.render()
    }
    if (a === 'cancel') this.set(this.before)
    if (a === 'ok') saveLook(this.look)
    this.dlg.close()
  }

  private onInput(e: Event) {
    const el = e.target as HTMLInputElement | HTMLSelectElement
    const l = { ...this.look } as Record<string, unknown>
    if (el.dataset.null) {
      const k = el.dataset.null
      const picker = this.dlg.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!
      l[k] = (el as HTMLInputElement).checked ? null : picker.value
      picker.classList.toggle('cs-off', (el as HTMLInputElement).checked)
    } else if (el.dataset.k) {
      const k = el.dataset.k
      if (el instanceof HTMLInputElement && el.type === 'checkbox') l[k] = el.checked
      else if (el instanceof HTMLInputElement && el.type === 'number') {
        const n = parseFloat(el.value)
        if (!Number.isFinite(n)) return
        l[k] = n
      } else l[k] = el.value
      // picking a color for an "ikut badan" field switches it on
      const nul = this.dlg.querySelector<HTMLInputElement>(`[data-null="${k}"]`)
      if (nul && el.type === 'color') {
        nul.checked = false
        el.classList.remove('cs-off')
      }
    } else return
    this.set(l as unknown as Look)
  }
}
