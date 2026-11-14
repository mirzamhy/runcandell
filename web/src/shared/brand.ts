import { maskSvg } from '../home/mask'

/** Fill every `.logo` with the red flame mask (the one logo used on all pages). */
export function mountLogos(root: ParentNode = document) {
  for (const el of root.querySelectorAll('.logo')) el.innerHTML = maskSvg()
}

/** Same mask as a favicon data URL. */
export function setFavicon() {
  const svg = maskSvg().replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.append(link)
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`
}
