/** The arena warrior mask, drawn on a 200 × 262 grid. One source for the 3D mesh and the SVG logo. */

const RIGHT: [number, number][] = [
  [100, 0], [110, 60], [128, 72], [150, 34], [152, 84], [176, 90], [198, 48], [194, 110],
  [178, 140], [190, 166], [168, 170], [160, 200], [140, 222], [118, 246], [100, 262],
]
export const MASK_W = 200
export const MASK_H = 262
export const OUTLINE: [number, number][] = [...RIGHT, ...RIGHT.slice(1, -1).reverse().map(([x, y]): [number, number] => [MASK_W - x, y])]
export const EYE_R: [number, number][] = [[106, 146], [124, 134], [156, 118], [146, 140], [120, 152]]
export const EYE_L: [number, number][] = EYE_R.map(([x, y]): [number, number] => [MASK_W - x, y]).reverse()

const toD = (pts: [number, number][]) => 'M' + pts.map((p) => p.join(' ')).join('L') + 'Z'
export const MASK_D = toD(OUTLINE)
export const EYES_D = toD(EYE_R) + toD(EYE_L)

/** Flat logo: mask with see-through eyes. */
export const maskSvg = (fill = '#ff2a2a') =>
  `<svg viewBox="0 0 ${MASK_W} ${MASK_H}" aria-hidden="true"><path d="${MASK_D}${EYES_D}" fill-rule="evenodd" fill="${fill}"/></svg>`

/** The glowing blue eyes ("welcome" sigil). */
export const EYES_SIGIL = '<svg viewBox="0 0 120 44" aria-hidden="true"><path d="M4 6C26 6 50 18 54 40 30 38 10 26 4 6Z"/><path d="M116 6C94 6 70 18 66 40 90 38 110 26 116 6Z"/></svg>'

/** Just the two eye holes, same grid as the mask, as separate paths (each eye animates on its own). */
export const maskEyesSvg = () =>
  `<svg viewBox="0 0 ${MASK_W} ${MASK_H}" aria-hidden="true"><path d="${toD(EYE_L)}"/><path d="${toD(EYE_R)}"/></svg>`
