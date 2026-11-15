/** In-page confirm, used instead of the browser's confirm() popup. Styles live in theme.css. */

export interface AskOptions {
  title?: string
  ok?: string
  cancel?: string
  /** red OK button for deleting things */
  danger?: boolean
}

let open: HTMLDialogElement | null = null

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** resolves true on OK, false on cancel, Esc or a click outside */
export function ask(message: string, o: AskOptions = {}): Promise<boolean> {
  open?.close()
  const d = document.createElement('dialog')
  d.className = 'ask'
  d.innerHTML = `
    <form method="dialog">
      ${o.title ? `<h3>${esc(o.title)}</h3>` : ''}
      <p>${esc(message)}</p>
      <div class="ask-acts">
        <button type="submit" value="no">${esc(o.cancel ?? 'Cancel')}</button>
        <button type="submit" value="yes" class="${o.danger ? 'danger' : 'primary'}" autofocus>${esc(o.ok ?? 'Ya')}</button>
      </div>
    </form>`
  document.body.append(d)
  open = d
  return new Promise((resolve) => {
    let done = false
    // settle right away: the 'close' event is queued and can lag in a background tab
    const finish = (yes: boolean) => {
      if (done) return
      done = true
      if (open === d) open = null
      if (d.open) d.close()
      d.remove()
      resolve(yes)
    }
    d.addEventListener('click', (e) => {
      if (e.target === d) return finish(false)
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[value]')
      if (b) {
        e.preventDefault()
        finish(b.value === 'yes')
      }
    })
    d.addEventListener('cancel', (e) => {
      e.preventDefault()
      finish(false)
    })
    d.addEventListener('close', () => finish(d.returnValue === 'yes'))
    d.showModal()
  })
}
