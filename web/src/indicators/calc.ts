/**
 * Indicator math. Pure functions over plain number arrays.
 * Output arrays have the input length; NaN marks "not enough history yet".
 * Conventions follow TradingView defaults (Wilder smoothing for RSI/ATR, EMA seeded with SMA).
 */

export type Series = Float64Array

const nan = (n: number) => new Float64Array(n).fill(NaN)

function firstFinite(src: ArrayLike<number>, from = 0): number {
  for (let i = from; i < src.length; i++) if (Number.isFinite(src[i])) return i
  return src.length
}

export function sma(src: ArrayLike<number>, n: number): Series {
  const out = nan(src.length)
  const start = firstFinite(src)
  let sum = 0
  for (let i = start; i < src.length; i++) {
    sum += src[i]
    if (i - start >= n) sum -= src[i - n]
    if (i - start >= n - 1) out[i] = sum / n
  }
  return out
}

/** EMA with alpha = 2/(n+1), seeded by the SMA of the first n valid values. */
export function ema(src: ArrayLike<number>, n: number, alpha = 2 / (n + 1)): Series {
  const out = nan(src.length)
  const start = firstFinite(src)
  if (start + n > src.length) return out
  let v = 0
  for (let i = start; i < start + n; i++) v += src[i]
  v /= n
  out[start + n - 1] = v
  for (let i = start + n; i < src.length; i++) {
    v = alpha * src[i] + (1 - alpha) * v
    out[i] = v
  }
  return out
}

/** Wilder's moving average (RMA), alpha = 1/n. */
export const rma = (src: ArrayLike<number>, n: number): Series => ema(src, n, 1 / n)

export function stdev(src: ArrayLike<number>, n: number): Series {
  const out = nan(src.length)
  const mean = sma(src, n)
  for (let i = n - 1; i < src.length; i++) {
    const m = mean[i]
    if (!Number.isFinite(m)) continue
    let s = 0
    for (let k = i - n + 1; k <= i; k++) s += (src[k] - m) ** 2
    out[i] = Math.sqrt(s / n) // population stdev, like TradingView ta.stdev
  }
  return out
}

export function highest(src: ArrayLike<number>, n: number): Series {
  const out = nan(src.length)
  for (let i = n - 1; i < src.length; i++) {
    let m = -Infinity
    for (let k = i - n + 1; k <= i; k++) if (src[k] > m) m = src[k]
    out[i] = m
  }
  return out
}

export function lowest(src: ArrayLike<number>, n: number): Series {
  const out = nan(src.length)
  for (let i = n - 1; i < src.length; i++) {
    let m = Infinity
    for (let k = i - n + 1; k <= i; k++) if (src[k] < m) m = src[k]
    out[i] = m
  }
  return out
}

export function trueRange(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>): Series {
  const out = new Float64Array(h.length)
  for (let i = 0; i < h.length; i++) {
    out[i] = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))
  }
  return out
}

export const atr = (h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n: number) =>
  rma(trueRange(h, l, c), n)

export function rsi(c: ArrayLike<number>, n: number): Series {
  const len = c.length
  const up = nan(len)
  const down = nan(len)
  for (let i = 1; i < len; i++) {
    const d = c[i] - c[i - 1]
    up[i] = Math.max(d, 0)
    down[i] = Math.max(-d, 0)
  }
  const au = rma(up, n)
  const ad = rma(down, n)
  const out = nan(len)
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(au[i])) continue
    out[i] = ad[i] === 0 ? 100 : au[i] === 0 ? 0 : 100 - 100 / (1 + au[i] / ad[i])
  }
  return out
}

export function macd(c: ArrayLike<number>, fast: number, slow: number, signal: number) {
  const f = ema(c, fast)
  const s = ema(c, slow)
  const line = nan(c.length)
  for (let i = 0; i < c.length; i++) line[i] = f[i] - s[i]
  const sig = ema(line, signal)
  const hist = nan(c.length)
  for (let i = 0; i < c.length; i++) hist[i] = line[i] - sig[i]
  return { line, signal: sig, hist }
}

export function stochastic(
  h: ArrayLike<number>,
  l: ArrayLike<number>,
  c: ArrayLike<number>,
  kLen: number,
  kSmooth: number,
  dLen: number,
) {
  const hh = highest(h, kLen)
  const ll = lowest(l, kLen)
  const raw = nan(c.length)
  for (let i = 0; i < c.length; i++) {
    const r = hh[i] - ll[i]
    if (Number.isFinite(r)) raw[i] = r === 0 ? 50 : (100 * (c[i] - ll[i])) / r
  }
  const k = sma(raw, kSmooth)
  return { k, d: sma(k, dLen) }
}

export function obv(c: ArrayLike<number>, v: ArrayLike<number>): Series {
  const out = new Float64Array(c.length)
  for (let i = 1; i < c.length; i++) {
    out[i] = out[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0)
  }
  return out
}

export function mfi(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, v: ArrayLike<number>, n: number) {
  const len = c.length
  const tp = new Float64Array(len)
  for (let i = 0; i < len; i++) tp[i] = (h[i] + l[i] + c[i]) / 3
  const out = nan(len)
  let pos = 0
  let neg = 0
  const pf = new Float64Array(len)
  const nf = new Float64Array(len)
  for (let i = 1; i < len; i++) {
    const flow = tp[i] * v[i]
    pf[i] = tp[i] > tp[i - 1] ? flow : 0
    nf[i] = tp[i] < tp[i - 1] ? flow : 0
    pos += pf[i]
    neg += nf[i]
    if (i > n) {
      pos -= pf[i - n]
      neg -= nf[i - n]
    }
    if (i >= n) out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg)
  }
  return out
}

export function bollinger(c: ArrayLike<number>, n: number, mult: number) {
  const mid = sma(c, n)
  const sd = stdev(c, n)
  const upper = nan(c.length)
  const lower = nan(c.length)
  for (let i = 0; i < c.length; i++) {
    upper[i] = mid[i] + mult * sd[i]
    lower[i] = mid[i] - mult * sd[i]
  }
  return { mid, upper, lower }
}

export function donchian(h: ArrayLike<number>, l: ArrayLike<number>, n: number) {
  const upper = highest(h, n)
  const lower = lowest(l, n)
  const mid = nan(h.length)
  for (let i = 0; i < h.length; i++) mid[i] = (upper[i] + lower[i]) / 2
  return { upper, lower, mid }
}

/** Session VWAP: resets whenever `session[i]` changes. Uses typical price × tick volume. */
export function vwap(
  h: ArrayLike<number>,
  l: ArrayLike<number>,
  c: ArrayLike<number>,
  v: ArrayLike<number>,
  session: ArrayLike<number>,
): Series {
  const out = nan(c.length)
  let pv = 0
  let vol = 0
  for (let i = 0; i < c.length; i++) {
    if (i === 0 || session[i] !== session[i - 1]) {
      pv = 0
      vol = 0
    }
    const tp = (h[i] + l[i] + c[i]) / 3
    pv += tp * v[i]
    vol += v[i]
    out[i] = vol > 0 ? pv / vol : tp
  }
  return out
}

/** Supertrend (ATR bands, flips on close). dir = 1 uptrend (line below price), -1 downtrend. */
export function supertrend(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n: number, mult: number) {
  const len = c.length
  const a = atr(h, l, c, n)
  const line = nan(len)
  const dir = new Int8Array(len)
  let upper = NaN
  let lower = NaN
  let d = 1
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(a[i])) continue
    const mid = (h[i] + l[i]) / 2
    const bu = mid + mult * a[i]
    const bl = mid - mult * a[i]
    const prevClose = i > 0 ? c[i - 1] : c[i]
    // bands only ratchet toward price unless the previous close broke through them
    lower = !Number.isFinite(lower) || bl > lower || prevClose < lower ? bl : lower
    upper = !Number.isFinite(upper) || bu < upper || prevClose > upper ? bu : upper
    if (d === 1 && c[i] < lower) d = -1
    else if (d === -1 && c[i] > upper) d = 1
    line[i] = d === 1 ? lower : upper
    dir[i] = d
  }
  return { line, dir }
}

/**
 * Ichimoku. Spans are returned unshifted (value computed at bar i);
 * the caller plots span A/B `shift` bars forward and the lagging line `shift` bars back.
 */
export function ichimoku(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, conv: number, base: number, spanB: number) {
  const mid = (n: number) => {
    const hh = highest(h, n)
    const ll = lowest(l, n)
    const out = nan(h.length)
    for (let i = 0; i < h.length; i++) out[i] = (hh[i] + ll[i]) / 2
    return out
  }
  const tenkan = mid(conv)
  const kijun = mid(base)
  const spanA = nan(h.length)
  for (let i = 0; i < h.length; i++) spanA[i] = (tenkan[i] + kijun[i]) / 2
  return { tenkan, kijun, spanA, spanB: mid(spanB), lagging: Float64Array.from(c) }
}

/** Classic floor pivots from the previous session's high/low/close, held for the whole session. */
export function pivots(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, session: ArrayLike<number>) {
  const len = c.length
  const keys = ['p', 'r1', 'r2', 'r3', 's1', 's2', 's3'] as const
  const out = Object.fromEntries(keys.map((k) => [k, nan(len)])) as Record<(typeof keys)[number], Series>
  let curH = -Infinity
  let curL = Infinity
  let curC = NaN
  let lv: Record<string, number> | null = null
  for (let i = 0; i < len; i++) {
    if (i > 0 && session[i] !== session[i - 1]) {
      const p = (curH + curL + curC) / 3
      const r = curH - curL
      lv = { p, r1: 2 * p - curL, s1: 2 * p - curH, r2: p + r, s2: p - r, r3: curH + 2 * (p - curL), s3: curL - 2 * (curH - p) }
      curH = -Infinity
      curL = Infinity
    }
    curH = Math.max(curH, h[i])
    curL = Math.min(curL, l[i])
    curC = c[i]
    if (lv) for (const k of keys) out[k][i] = lv[k]
  }
  return out
}
