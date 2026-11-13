/**
 * Drawing UI around DrawingLayer: the left toolbar (tool groups with flyouts, magnet),
 * and the floating style bar for the selected drawing (color, width, line style, text).
 */
import { DEFAULT_STYLE, TOOL_LABEL, type Dash, type DrawingLayer, type DrawKind, type DrawStyle, type Magnet, type Tool } from './drawings'

const ICON: Record<Tool | 'magnet' | 'delete' | 'clear' | 'copy', string> = {
  cursor: '<path class="solid" d="M5 3l10 6-4.5 1.2L13 15l-1.8.9-2.4-4.8L5 14z"/>',
  trend: '<path d="M4 16L16 4"/><circle cx="4" cy="16" r="1.8"/><circle cx="16" cy="4" r="1.8"/>',
  ray: '<path d="M4 16L18 2"/><circle cx="4" cy="16" r="1.8"/><circle cx="10" cy="10" r="1.8"/>',
  extline: '<path d="M1 19L19 1"/><circle cx="7" cy="13" r="1.8"/><circle cx="13" cy="7" r="1.8"/>',
  arrow: '<path d="M4 16L15 5M15 5H9M15 5v6"/>',
  hline: '<path d="M2 10h16"/><circle cx="10" cy="10" r="1.8"/>',
  hray: '<path d="M6 10h12"/><circle cx="6" cy="10" r="1.8"/>',
  vline: '<path d="M10 2v16"/><circle cx="10" cy="10" r="1.8"/>',
  cross: '<path d="M2 10h16M10 2v16"/><circle cx="10" cy="10" r="1.8"/>',
  channel: '<path d="M3 12L12 3M8 17L17 8"/><path d="M5.5 14.5l9-9" stroke-dasharray="2 2"/>',
  fib: '<path d="M3 4h14M3 8h14M3 12h14M3 16h14"/>',
  fibext: '<path d="M3 17l4-9 3 5 2-4"/><path d="M12 5h6M12 9h6M12 13h6M12 17h6"/>',
  rect: '<rect x="3.5" y="5.5" width="13" height="9"/>',
  ellipse: '<ellipse cx="10" cy="10" rx="7" ry="5"/>',
  long: '<path d="M4 3h12v7H4zM4 10h12v7H4z"/><path d="M10 14V6M7.5 8.5L10 6l2.5 2.5"/>',
  short: '<path d="M4 3h12v7H4zM4 10h12v7H4z"/><path d="M10 6v8M7.5 11.5L10 14l2.5-2.5"/>',
  range: '<rect x="3.5" y="3.5" width="13" height="13"/><path d="M10 6v8M8 8l2-2 2 2M8 12l2 2 2-2"/>',
  text: '<path d="M5 5h10M10 5v11M8 16h4"/>',
  magnet: '<path d="M5 3v7a5 5 0 0 0 10 0V3h-3.5v7a1.5 1.5 0 0 1-3 0V3z"/><path d="M5 6.5h3.5M11.5 6.5H15"/>',
  delete: '<path d="M5 6h10M8 6V4h4v2M6.5 6l.8 10h5.4l.8-10"/>',
  clear: '<path d="M4 4l12 12M16 4L4 16"/>',
  copy: '<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M13 7V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3"/>',
}
const svg = (k: keyof typeof ICON) => `<svg viewBox="0 0 20 20" aria-hidden="true">${ICON[k]}</svg>`

const GROUPS: { name: string; tools: Tool[] }[] = [
  { name: 'Kursor', tools: ['cursor'] },
  { name: 'Garis', tools: ['trend', 'ray', 'extline', 'arrow', 'hline', 'hray', 'vline', 'cross', 'channel'] },
  { name: 'Fibonacci', tools: ['fib', 'fibext'] },
  { name: 'Bentuk', tools: ['rect', 'ellipse'] },
  { name: 'Posisi', tools: ['long', 'short'] },
  { name: 'Ukur', tools: ['range'] },
  { name: 'Teks', tools: ['text'] },
]
const MAGNET_NEXT: Record<Magnet, Magnet> = { off: 'weak', weak: 'strong', strong: 'off' }
const MAGNET_LABEL: Record<Magnet, string> = { off: 'Magnet mati', weak: 'Magnet lemah', strong: 'Magnet kuat' }
const COLORS = ['#4c8dff', '#2ec4b6', '#26a69a', '#f5a524', '#ef5350', '#a78bfa', '#e6e9ef', '#9aa4b2']
const KEY = { magnet: 'rc.v1.magnet', styles: 'rc.v1.drawStyles', groups: 'rc.v1.toolGroups' }

function read<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function write(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage full or blocked */
  }
}

export const magnetLabel = (m: Magnet) => MAGNET_LABEL[m]

export class DrawTools {
  private readonly nav: HTMLElement
  private readonly layer: DrawingLayer
  private readonly bar: HTMLElement
  private readonly fly: HTMLElement
  /** last tool picked in each group (the group button shows it) */
  private current: Record<string, Tool>
  private magnetBtn!: HTMLButtonElement

  constructor(nav: HTMLElement, chartWrap: HTMLElement, layer: DrawingLayer) {
    this.nav = nav
    this.layer = layer
    layer.magnet = read<Magnet>(KEY.magnet, 'off')
    layer.styles = read<Partial<Record<DrawKind, DrawStyle>>>(KEY.styles, {})
    this.current = { ...Object.fromEntries(GROUPS.map((g) => [g.name, g.tools[0]])), ...read<Record<string, Tool>>(KEY.groups, {}) }

    this.fly = document.createElement('div')
    this.fly.className = 'tool-fly'
    this.fly.hidden = true
    this.fly.setAttribute('role', 'menu')
    document.body.append(this.fly)

    this.bar = document.createElement('div')
    this.bar.className = 'draw-bar'
    this.bar.hidden = true
    this.bar.setAttribute('role', 'toolbar')
    this.bar.setAttribute('aria-label', 'Gaya gambar')
    chartWrap.append(this.bar)

    this.buildNav()
    layer.onToolChange = () => this.syncNav()
    layer.onSelect = (d) => this.renderBar(d ? d.id : null)
    const prevChange = layer.onChange
    layer.onChange = () => {
      prevChange()
      write(KEY.styles, layer.styles)
    }
    this.syncNav()

    // capture phase: the chart stops pointer events from bubbling
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.fly.hidden && !this.fly.contains(e.target as Node) && !(e.target as HTMLElement).closest('.tool-caret, [data-group]')) this.fly.hidden = true
      },
      true,
    )
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.fly.hidden = true
    })
  }

  /** onChange is reassigned by duel mode: keep style saving attached */
  rebindChange(fn: () => void) {
    this.layer.onChange = () => {
      fn()
      write(KEY.styles, this.layer.styles)
    }
  }

  cycleMagnet() {
    this.setMagnet(MAGNET_NEXT[this.layer.magnet])
  }

  private setMagnet(m: Magnet) {
    this.layer.magnet = m
    write(KEY.magnet, m)
    this.syncNav()
  }

  // ---------- toolbar ----------

  private buildNav() {
    const n = this.nav
    n.innerHTML = ''
    for (const g of GROUPS) {
      const wrap = document.createElement('div')
      wrap.className = 'tool-group'
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.group = g.name
      b.addEventListener('click', () => {
        const t = this.current[g.name]
        // a second click on the active group opens its list, like TradingView
        if (this.layer.tool === t && g.tools.length > 1) return this.openFly(g, wrap)
        this.layer.setTool(t)
      })
      wrap.append(b)
      if (g.tools.length > 1) {
        const c = document.createElement('button')
        c.type = 'button'
        c.className = 'tool-caret'
        c.title = `Pilih alat ${g.name.toLowerCase()}`
        c.setAttribute('aria-label', c.title)
        c.addEventListener('click', () => (this.fly.hidden || this.fly.dataset.group !== g.name ? this.openFly(g, wrap) : (this.fly.hidden = true)))
        wrap.append(c)
      }
      n.append(wrap)
    }
    const sep = () => Object.assign(document.createElement('div'), { className: 'tools-sep' })
    n.append(sep())
    this.magnetBtn = this.button('magnet', '', () => this.cycleMagnet())
    this.magnetBtn.classList.add('magnet')
    n.append(this.magnetBtn, sep())
    n.append(
      this.button('delete', 'Hapus gambar terpilih (Delete)', () => this.layer.removeSelected()),
      this.button('clear', 'Hapus semua gambar', () => {
        if (this.layer.drawings.length && confirm('Hapus semua gambar di chart?')) this.layer.clear()
      }),
    )
  }

  private button(icon: keyof typeof ICON, title: string, onClick: () => void) {
    const b = document.createElement('button')
    b.type = 'button'
    b.innerHTML = svg(icon)
    if (title) {
      b.title = title
      b.setAttribute('aria-label', title)
    }
    b.addEventListener('click', onClick)
    return b
  }

  private openFly(g: (typeof GROUPS)[number], anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect()
    this.fly.dataset.group = g.name
    this.fly.innerHTML = `<p>${g.name}</p>` + g.tools.map((t) => `<button type="button" role="menuitem" data-tool="${t}" aria-pressed="${this.layer.tool === t}">${svg(t)}<span>${TOOL_LABEL[t]}</span></button>`).join('')
    this.fly.hidden = false
    const h = this.fly.offsetHeight
    this.fly.style.left = `${r.right + 6}px`
    this.fly.style.top = `${Math.max(8, Math.min(r.top, innerHeight - h - 8))}px`
    for (const b of this.fly.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      b.addEventListener('click', () => {
        const t = b.dataset.tool as Tool
        this.current[g.name] = t
        write(KEY.groups, this.current)
        this.fly.hidden = true
        this.layer.setTool(t)
      })
    }
  }

  private syncNav() {
    const tool = this.layer.tool
    for (const g of GROUPS) {
      if (g.tools.includes(tool)) this.current[g.name] = tool
      const b = this.nav.querySelector<HTMLButtonElement>(`[data-group="${g.name}"]`)!
      const t = this.current[g.name]
      b.innerHTML = svg(t)
      b.title = TOOL_LABEL[t] + (t === 'cursor' ? ' (Esc)' : '')
      b.setAttribute('aria-label', b.title)
      b.setAttribute('aria-pressed', String(tool === t))
    }
    const m = this.layer.magnet
    this.magnetBtn.setAttribute('aria-pressed', String(m !== 'off'))
    this.magnetBtn.dataset.mode = m
    this.magnetBtn.title = `${MAGNET_LABEL[m]} (klik untuk ganti, tahan Ctrl saat menggambar untuk membalik)`
    this.magnetBtn.setAttribute('aria-label', MAGNET_LABEL[m])
  }

  // ---------- style bar ----------

  private renderBar(id: string | null) {
    const d = id ? this.layer.drawings.find((x) => x.id === id) : null
    if (!d) {
      this.bar.hidden = true
      return
    }
    const st = this.layer.styleOf(d)
    const dash = (v: Dash, label: string, pattern: string) =>
      `<button type="button" data-dash="${v}" aria-pressed="${st.dash === v}" title="${label}"><svg viewBox="0 0 24 8"><path d="M1 4h22" stroke-dasharray="${pattern}"/></svg></button>`
    this.bar.innerHTML = `
      <span class="db-name">${TOOL_LABEL[d.kind]}</span>
      <span class="db-colors">${COLORS.map((c) => `<button type="button" class="sw" data-color="${c}" style="--c:${c}" aria-pressed="${st.color.toLowerCase() === c}" aria-label="Warna ${c}"></button>`).join('')}
        <label class="sw custom" title="Warna lain"><input type="color" value="${st.color}" aria-label="Warna lain"></label></span>
      <span class="db-sep"></span>
      <span class="db-widths">${[1, 2, 3, 4].map((w) => `<button type="button" data-width="${w}" aria-pressed="${st.width === w}" title="Tebal ${w}px"><i style="height:${w}px"></i></button>`).join('')}</span>
      <span class="db-sep"></span>
      <span class="db-dash">${dash('solid', 'Garis penuh', '')}${dash('dash', 'Putus-putus', '5 3')}${dash('dot', 'Titik-titik', '1.5 2.5')}</span>
      ${d.kind === 'text' ? `<span class="db-sep"></span><input class="db-text" type="text" maxlength="120" value="${(st.text ?? '').replace(/"/g, '&quot;')}" aria-label="Isi teks">` : ''}
      <span class="db-sep"></span>
      <button type="button" data-act="copy" title="Duplikat (Ctrl+D)" aria-label="Duplikat">${svg('copy')}</button>
      <button type="button" data-act="delete" title="Hapus (Delete)" aria-label="Hapus">${svg('delete')}</button>`
    this.bar.hidden = false
    this.bar.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button')
      if (!b) return
      if (b.dataset.color) this.apply({ color: b.dataset.color })
      else if (b.dataset.width) this.apply({ width: Number(b.dataset.width) })
      else if (b.dataset.dash) this.apply({ dash: b.dataset.dash as Dash })
      else if (b.dataset.act === 'copy') this.layer.duplicate()
      else if (b.dataset.act === 'delete') this.layer.removeSelected()
    }
    this.bar.querySelector<HTMLInputElement>('input[type=color]')!.oninput = (e) => this.apply({ color: (e.target as HTMLInputElement).value }, false)
    const text = this.bar.querySelector<HTMLInputElement>('.db-text')
    if (text) {
      text.oninput = () => this.layer.setStyle({ text: text.value })
      // a fresh text drawing: type straight away
      if (st.text === DEFAULT_STYLE.text.text) queueMicrotask(() => text.select())
    }
  }

  private apply(patch: Partial<DrawStyle>, rerender = true) {
    this.layer.setStyle(patch)
    if (rerender) this.renderBar(this.layer.selected)
  }
}
