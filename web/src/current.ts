/** The instrument open on the chart page, and price formatting that follows its decimals. */
import { instrument, type Instrument } from './instruments'

const KEY = 'rc.v1.symbol'
const DEFAULT = 'XAUUSD'

let cur: Instrument = instrument(readSaved())

function readSaved(): string {
  try {
    return localStorage.getItem(KEY) || DEFAULT
  } catch {
    return DEFAULT
  }
}

export const current = () => cur
export const savedSymbol = readSaved

export function setCurrent(symbol: string) {
  cur = instrument(symbol)
  try {
    localStorage.setItem(KEY, symbol)
  } catch {
    // private mode: the choice just isn't remembered
  }
}

/** duel rounds show normalised prices (~1000) whatever the chart's pair: 2 decimals */
let override: number | null = null
export function setDigitsOverride(d: number | null) {
  override = d
}
export const digits = () => override ?? cur.digits

/** price with the instrument's decimals */
export const px = (n: number) => n.toFixed(digits())
/** smallest price step, for number inputs */
export const pxStep = () => String(10 ** -digits())
/** price-like values (indicator readouts): instrument decimals for small prices, 2 otherwise */
export const pxAuto = (n: number) => n.toFixed(Math.abs(n) < 20 ? Math.max(2, digits()) : 2)
