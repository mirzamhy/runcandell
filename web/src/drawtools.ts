/**
 * Drawing UI around DrawingLayer: the left toolbar (tool groups with flyouts, magnet),
 * and the floating style bar for the selected drawing (color, width, line style, text).
 */
import { CAN, DEFAULT_STYLE, TOOL_LABEL, type Dash, type Drawing, type DrawingLayer, type DrawKind, type DrawStyle, type Magnet, type Tool } from './drawings'

const ICON: Record<Tool | 'magnet' | 'delete' | 'clear' | 'copy' | 'undo' | 'redo' | 'eye' | 'eyeoff' | 'lock' | 'unlock' | 'list' | 'gear', string> = {
  undo: '<path d="M7 5L3 9l4 4"/><path d="M3 9h9a5 5 0 0 1 0 10H9"/>',
  redo: '<path d="M13 5l4 4-4 4"/><path d="M17 9H8a5 5 0 0 0 0 10h3"/>',
  eye: '<path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z"/><circle cx="10" cy="10" r="2.5"/>',
  eyeoff: '<path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z"/><path d="M3 3l14 14"/>',
  lock: '<rect x="4.5" y="9" width="11" height="8" rx="1"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
  unlock: '<rect x="4.5" y="9" width="11" height="8" rx="1"/><path d="M7 9V6.5a3 3 0 0 1 5.8-1"/>',
  list: '<path d="M7 5h10M7 10h10M7 15h10"/><circle cx="3.5" cy="5" r="1"/><circle cx="3.5" cy="10" r="1"/><circle cx="3.5" cy="15" r="1"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/>',
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
const KEY = { magnet: 'rc.v1.magnet', styles: 'rc.v1.drawStyles', groups: 'rc.v1.toolGroups', hideAll: 'rc.v1.drawHideAll' }
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
/** names for the points of each tool in the coordinates list */
const PT_NAMES: Partial<Record<DrawKind, string[]>> = {
  long: ['Entry', 'Target', 'Stop'],
  short: ['Entry', 'Target', 'Stop'],
  channel: ['Awal', 'Akhir', 'Lebar'],
  fibext: ['Titik 1', 'Titik 2', 'Titik 3'],
}

export interface DrawToolsOptions {
  /** UTC seconds to a datetime-local value in the chart's zone, and back */
  toInput: (t: number) => string
  fromInput: (v: string) => number | null
  timeframes: readonly string[]
}

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
  private undoBtn!: HTMLButtonElement
  private redoBtn!: HTMLButtonElement
  private eyeBtn!: HTMLButtonElement
  private listBtn!: HTMLButtonElement
  private readonly tree: HTMLElement
  private readonly dlg: HTMLDialogElement
  private dlgBefore: Drawing | null = null

  constructor(
    nav: HTMLElement,
    chartWrap: HTMLElement,
    layer: DrawingLayer,
    private readonly opts: DrawToolsOptions,
  ) {
    this.nav = nav
    this.layer = layer
    layer.hideAll = read<boolean>(KEY.hideAll, false)
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

    this.tree = document.createElement('aside')
    this.tree.className = 'obj-tree'
    this.tree.hidden = true
    this.tree.setAttribute('aria-label', 'Daftar gambar')
    chartWrap.append(this.tree)
    this.tree.addEventListener('click', (e) => this.onTreeClick(e))

    this.dlg = document.createElement('dialog')
    this.dlg.className = 'cs-dialog dd-dialog'
    document.body.append(this.dlg)
    this.dlg.addEventListener('input', (e) => this.onDlgInput(e))
    this.dlg.addEventListener('change', (e) => this.onDlgInput(e))
    this.dlg.addEventListener('click', (e) => this.onDlgClick(e))
    this.dlg.addEventListener('cancel', () => this.dlgRestore())
    layer.onOpen = (d) => this.openSettings(d.id)

    this.buildNav()
    layer.onToolChange = () => this.syncNav()
    layer.onSelect = (d) => {
      this.renderBar(d ? d.id : null)
      this.renderTree()
    }
    const prevChange = layer.onChange
    layer.onChange = () => {
      prevChange()
      this.afterChange()
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
      this.afterChange()
    }
  }

  private afterChange() {
    write(KEY.styles, this.layer.styles)
    this.syncNav()
    this.renderTree()
    // the bar shows lock state and the label: keep it current after undo or the list
    if (this.layer.selected && !this.bar.contains(document.activeElement)) this.renderBar(this.layer.selected)
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
    this.undoBtn = this.button('undo', 'Batalkan (Ctrl+Z)', () => this.layer.undo())
    this.redoBtn = this.button('redo', 'Ulangi (Ctrl+Y)', () => this.layer.redo())
    this.eyeBtn = this.button('eye', '', () => {
      this.layer.hideAll = !this.layer.hideAll
      write(KEY.hideAll, this.layer.hideAll)
      if (this.layer.hideAll) this.layer.select(null)
      this.layer.refresh()
      this.syncNav()
      this.renderTree()
    })
    this.listBtn = this.button('list', 'Daftar gambar: sembunyikan, kunci, hapus satu per satu', () => {
      this.tree.hidden = !this.tree.hidden
      this.renderTree()
      this.syncNav()
    })
    n.append(
      this.undoBtn,
      this.redoBtn,
      sep(),
      this.listBtn,
      this.eyeBtn,
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
    this.undoBtn.disabled = !this.layer.canUndo
    this.redoBtn.disabled = !this.layer.canRedo
    const hid = this.layer.hideAll
    this.eyeBtn.innerHTML = svg(hid ? 'eyeoff' : 'eye')
    this.eyeBtn.title = hid ? 'Tampilkan semua gambar' : 'Sembunyikan semua gambar'
    this.eyeBtn.setAttribute('aria-label', this.eyeBtn.title)
    this.eyeBtn.setAttribute('aria-pressed', String(hid))
    this.listBtn.setAttribute('aria-pressed', String(!this.tree.hidden))
  }

  // ---------- object list ----------

  private describe(d: Drawing): string {
    const px = (p: number) => p.toFixed(2)
    const st = this.layer.styleOf(d)
    if (d.kind === 'text') return st.text || 'Teks'
    if (st.text) return st.text
    if (d.kind === 'vline') return this.opts.toInput(d.pts[0].t).replace('T', ' ')
    if (d.pts.length === 1) return px(d.pts[0].p)
    return `${px(d.pts[0].p)} → ${px(d.pts[1].p)}`
  }

  private renderTree() {
    if (this.tree.hidden) return
    const list = [...this.layer.drawings].reverse()
    const row = (d: Drawing) => {
      const tfNote = d.tfs ? ` <small>(${d.tfs.length} TF)</small>` : ''
      return `<li class="${d.id === this.layer.selected ? 'sel' : ''}${d.hidden ? ' off' : ''}" data-id="${d.id}">
        <i style="color:${this.layer.styleOf(d).color}">${svg(d.kind)}</i>
        <button type="button" class="ot-name" data-ot="select">${TOOL_LABEL[d.kind]}<small>${esc(this.describe(d))}</small>${tfNote}</button>
        <button type="button" data-ot="hide" title="${d.hidden ? 'Tampilkan' : 'Sembunyikan'}" aria-label="${d.hidden ? 'Tampilkan' : 'Sembunyikan'}">${svg(d.hidden ? 'eyeoff' : 'eye')}</button>
        <button type="button" data-ot="lock" title="${d.locked ? 'Buka kunci' : 'Kunci'}" aria-label="${d.locked ? 'Buka kunci' : 'Kunci'}" aria-pressed="${!!d.locked}">${svg(d.locked ? 'lock' : 'unlock')}</button>
        <button type="button" data-ot="delete" title="Hapus" aria-label="Hapus">${svg('delete')}</button>
      </li>`
    }
    this.tree.innerHTML = `
      <header><b>Gambar (${list.length})</b>
        <button type="button" data-ot="lockall" title="Kunci / buka semua">${svg('lock')}</button>
        <button type="button" data-ot="close" aria-label="Tutup daftar">✕</button></header>
      ${this.layer.hideAll ? '<p class="ot-note">Semua gambar sedang disembunyikan (ikon mata di toolbar).</p>' : ''}
      ${list.length ? `<ul>${list.map(row).join('')}</ul>` : '<p class="ot-note">Belum ada gambar. Pilih alat di toolbar kiri.</p>'}
      <p class="ot-note">Klik dua kali gambar di chart untuk pengaturan lengkap: koordinat, isi, label, timeframe.</p>`
  }

  private onTreeClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ot]')
    if (!b) return
    const a = b.dataset.ot
    if (a === 'close') {
      this.tree.hidden = true
      return this.syncNav()
    }
    if (a === 'lockall') {
      const lock = this.layer.drawings.some((d) => !d.locked)
      for (const d of this.layer.drawings) this.layer.patch(d.id, (x) => (x.locked = lock || undefined))
      return
    }
    const id = b.closest<HTMLElement>('[data-id]')?.dataset.id
    if (!id) return
    if (a === 'select') {
      const d = this.layer.drawings.find((x) => x.id === id)
      if (d && this.layer.isVisible(d)) this.layer.select(id)
      return
    }
    if (a === 'hide') return this.layer.patch(id, (d) => (d.hidden = !d.hidden || undefined))
    if (a === 'lock') return this.layer.patch(id, (d) => (d.locked = !d.locked || undefined))
    if (a === 'delete') {
      this.layer.select(id)
      this.layer.removeSelected()
    }
  }

  // ---------- settings dialog (double click a drawing) ----------

  openSettings(id: string) {
    const d = this.layer.drawings.find((x) => x.id === id)
    if (!d) return
    this.dlgBefore = structuredClone(d)
    this.dlg.dataset.id = id
    this.renderDlg(d)
    this.dlg.showModal()
  }

  private renderDlg(d: Drawing) {
    const st = this.layer.styleOf(d)
    const k = d.kind
    const names = PT_NAMES[k] ?? d.pts.map((_, i) => `Titik ${i + 1}`)
    const sel = (key: string, cur: string | number, opts: [string | number, string][]) =>
      `<select data-st="${key}">${opts.map(([v, l]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${l}</option>`).join('')}</select>`
    const row = (label: string, ctl: string) => `<div class="cs-row"><span>${label}</span><div class="cs-ctl">${ctl}</div></div>`
    const style = [
      row('Warna garis', `<input type="color" data-st="color" value="${st.color}">`),
      k === 'text' ? '' : row('Tebal', sel('width', st.width, [1, 2, 3, 4].map((w) => [w, `${w}px`]))),
      k === 'text' ? '' : row('Jenis garis', sel('dash', st.dash, [['solid', 'Penuh'], ['dash', 'Putus-putus'], ['dot', 'Titik-titik']])),
      CAN.fill(k)
        ? row('Isi', `<input type="color" data-st="fill" value="${st.fill ?? st.color}"><input type="range" min="0" max="80" data-st="fillAlpha" value="${st.fillAlpha ?? 15}" aria-label="Tebal isi"><output>${st.fillAlpha ?? 15}%</output>`)
        : '',
      CAN.extend(k)
        ? row('Perpanjang', `<label class="cs-null"><input type="checkbox" data-st="extendL"${st.extendL ? ' checked' : ''}> ke kiri</label><label class="cs-null"><input type="checkbox" data-st="extendR"${st.extendR ? ' checked' : ''}> ke kanan</label>`)
        : '',
    ].join('')
    const text =
      k === 'text'
        ? `<textarea data-st="text" rows="3">${esc(st.text ?? '')}</textarea>${row('Ukuran teks', sel('fontSize', st.fontSize ?? 10 + st.width * 2, [10, 12, 14, 16, 20, 24, 32].map((v) => [v, `${v}px`])))}`
        : CAN.label(k)
          ? `<input type="text" data-st="text" maxlength="80" placeholder="Contoh: Support kuat, Zona supply" value="${esc(st.text ?? '')}">${row('Ukuran label', sel('fontSize', st.fontSize ?? 12, [10, 12, 14, 16, 20].map((v) => [v, `${v}px`])))}`
          : ''
    const coords = d.pts
      .map(
        (p, i) => `<div class="dd-pt"><b>${names[i] ?? `Titik ${i + 1}`}</b>
          <label>Harga <input type="number" step="0.01" data-pt="${i}" data-f="p" value="${p.p.toFixed(2)}"></label>
          ${k === 'hline' ? '' : `<label>Waktu <input type="datetime-local" data-pt="${i}" data-f="t" value="${this.opts.toInput(p.t)}"></label>`}</div>`,
      )
      .join('')
    const all = !d.tfs
    const tfs = this.opts.timeframes
      .map((tf) => `<label class="cs-null"><input type="checkbox" data-tf="${tf}"${all || d.tfs!.includes(tf) ? ' checked' : ''}> ${tf}</label>`)
      .join('')
    this.dlg.innerHTML = `
      <header class="cs-head"><b>${TOOL_LABEL[k]}</b><button type="button" data-dd="cancel" aria-label="Tutup">✕</button></header>
      <div class="dd-body">
        <section><h5>Gaya</h5>${style}</section>
        ${text ? `<section><h5>${k === 'text' ? 'Teks' : 'Label'}</h5>${text}</section>` : ''}
        <section><h5>Koordinat</h5>${coords}</section>
        <section><h5>Tampil di timeframe</h5><div class="dd-tfs">${tfs}</div>
          <label class="cs-null"><input type="checkbox" data-st="locked"${d.locked ? ' checked' : ''}> Kunci posisi (tidak bisa tergeser)</label></section>
      </div>
      <footer class="cs-foot"><button type="button" data-dd="delete" class="danger">Hapus</button><span></span>
        <button type="button" data-dd="cancel">Batal</button><button type="button" class="primary" data-dd="ok">OK</button></footer>`
  }

  private dlgRestore() {
    const b = this.dlgBefore
    if (!b) return
    this.layer.patch(b.id, (d) => Object.assign(d, structuredClone(b), { locked: b.locked, hidden: b.hidden, tfs: b.tfs }))
    this.dlgBefore = null
  }

  private onDlgClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dd]')
    if (!b) return
    const a = b.dataset.dd
    if (a === 'cancel') this.dlgRestore()
    if (a === 'delete') {
      this.layer.select(this.dlg.dataset.id!)
      this.layer.removeSelected()
    }
    this.dlgBefore = null
    this.dlg.close()
  }

  private onDlgInput(e: Event) {
    const el = e.target as HTMLInputElement
    const id = this.dlg.dataset.id!
    if (el.dataset.pt) {
      const i = +el.dataset.pt
      if (el.dataset.f === 'p') {
        const v = parseFloat(el.value)
        if (Number.isFinite(v)) this.layer.patch(id, (d) => (d.pts[i] = { ...d.pts[i], p: v }))
      } else if (e.type === 'change') {
        const t = this.opts.fromInput(el.value)
        if (t !== null) this.layer.patch(id, (d) => (d.pts[i] = { ...d.pts[i], t }))
      }
      return
    }
    if (el.dataset.tf) {
      const on = [...this.dlg.querySelectorAll<HTMLInputElement>('[data-tf]')].filter((c) => c.checked).map((c) => c.dataset.tf!)
      this.layer.patch(id, (d) => (d.tfs = on.length === this.opts.timeframes.length ? undefined : on))
      return
    }
    const key = el.dataset.st
    if (!key) return
    if (key === 'locked') return this.layer.patch(id, (d) => (d.locked = el.checked || undefined))
    let v: string | number | boolean = el.value
    if (el.type === 'checkbox') v = el.checked
    else if (key === 'width' || key === 'fontSize' || key === 'fillAlpha') v = Number(el.value)
    if (key === 'fillAlpha') {
      const out = el.nextElementSibling
      if (out) out.textContent = `${v}%`
    }
    this.layer.select(id)
    this.layer.setStyle({ [key]: v } as Partial<DrawStyle>)
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
      ${d.kind === 'text' ? `<span class="db-sep"></span><input class="db-text" type="text" maxlength="120" value="${esc(st.text ?? '')}" aria-label="Isi teks">` : ''}
      ${CAN.label(d.kind) ? `<span class="db-sep"></span><input class="db-text db-label" type="text" maxlength="80" placeholder="+ label" value="${esc(st.text ?? '')}" aria-label="Label">` : ''}
      <span class="db-sep"></span>
      <button type="button" data-act="lock" title="${d.locked ? 'Buka kunci' : 'Kunci posisi'}" aria-label="Kunci" aria-pressed="${!!d.locked}">${svg(d.locked ? 'lock' : 'unlock')}</button>
      <button type="button" data-act="settings" title="Pengaturan lengkap (klik dua kali gambar)" aria-label="Pengaturan">${svg('gear')}</button>
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
      else if (b.dataset.act === 'lock') this.layer.patch(d.id, (x) => (x.locked = !x.locked || undefined))
      else if (b.dataset.act === 'settings') this.openSettings(d.id)
      else if (b.dataset.act === 'delete') this.layer.removeSelected()
    }
    this.bar.querySelector<HTMLInputElement>('input[type=color]')!.oninput = (e) => this.apply({ color: (e.target as HTMLInputElement).value }, false)
    const text = this.bar.querySelector<HTMLInputElement>('.db-text')
    if (text) {
      text.oninput = () => this.layer.setStyle({ text: text.value })
      // a fresh text drawing: type straight away
      if (d.kind === 'text' && st.text === DEFAULT_STYLE.text.text) queueMicrotask(() => text.select())
    }
  }

  private apply(patch: Partial<DrawStyle>, rerender = true) {
    this.layer.setStyle(patch)
    if (rerender) this.renderBar(this.layer.selected)
  }
}
