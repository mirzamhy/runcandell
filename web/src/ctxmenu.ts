/** Small right-click menu. One instance, closes on outside click, Escape, scroll or resize. */

export type MenuItem = { label: string; hint?: string; act: () => void; danger?: boolean; disabled?: boolean } | 'sep'

let el: HTMLElement | null = null

function close() {
  if (el) el.hidden = true
}

function ensure(): HTMLElement {
  if (el) return el
  el = document.createElement('div')
  el.className = 'ctx-menu'
  el.setAttribute('role', 'menu')
  el.hidden = true
  document.body.append(el)
  // capture phase: the chart stops pointer events from bubbling
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (el && !el.contains(e.target as Node)) close()
    },
    true,
  )
  window.addEventListener('keydown', (e) => e.key === 'Escape' && close())
  window.addEventListener('resize', close)
  window.addEventListener('blur', close)
  return el
}

export function openMenu(x: number, y: number, items: MenuItem[]) {
  const m = ensure()
  m.innerHTML = ''
  for (const it of items) {
    if (it === 'sep') {
      m.append(Object.assign(document.createElement('div'), { className: 'ctx-sep' }))
      continue
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    b.disabled = !!it.disabled
    if (it.danger) b.classList.add('danger')
    b.innerHTML = `<span></span>${it.hint ? '<kbd></kbd>' : ''}`
    b.querySelector('span')!.textContent = it.label
    if (it.hint) b.querySelector('kbd')!.textContent = it.hint
    b.addEventListener('click', () => {
      close()
      it.act()
    })
    m.append(b)
  }
  m.hidden = false
  // keep it on screen
  const w = m.offsetWidth
  const h = m.offsetHeight
  m.style.left = `${Math.min(x, innerWidth - w - 6)}px`
  m.style.top = `${Math.min(y, innerHeight - h - 6)}px`
  m.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
}
