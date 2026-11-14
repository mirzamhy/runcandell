import { checkDecision, findCut, makeNorm, normBar, normPrice, realPrice, runDecision, snapshotTF } from './duel.ts'

let fails = 0
const eq = (name: string, a: unknown, b: unknown) => {
  const ok = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : JSON.stringify(a) === JSON.stringify(b)
  if (!ok) { fails++; console.log('FAIL', name, a, '!=', b) } else console.log('ok  ', name)
}
const bar = (time: number, o: number, h = o, l = o, c = o, spread = 0.2) => ({ time, open: o, high: h, low: l, close: c, volume: 1, spread })

// 1. snapshot: forming M15 candle is rebuilt from M1 up to the cut, never from the finished pyramid bar
const m1 = Array.from({ length: 30 }, (_, i) => bar(i * 60, 2000 + i, 2000 + i + 0.5, 2000 + i - 0.5, 2000 + i))
const m15 = [bar(0, 2000, 2014.5, 1999.5, 2014), bar(900, 2015, 2029.5, 2014.5, 2029)] // full candles (the second has a future high)
const snap = snapshotTF(m15, m1, 20 * 60, 10, false)
eq('finished candles kept', snap.length, 2)
eq('forming high only up to cut', snap[1].high, 2020.5)
eq('forming close = cut close', snap[1].close, 2020)
eq('forming time = period start', snap[1].time, 900)
eq('M1 snapshot ends at cut', snapshotTF([], m1, 20 * 60, 5, true).map((b) => b.time), [960, 1020, 1080, 1140, 1200])

// 2. normalisation round-trips and keeps the weekday/hour
const cut = bar(1786701600, 4357, 4358, 4356, 4357.5, 0.17)
const n = makeNorm(cut, 1.25)
eq('anchor -> 1000', normPrice(n, 4357.5), 1000)
eq('scaled move', normPrice(n, 4359.5), 1002.5)
eq('round trip within 0.001', Math.abs(realPrice(n, normPrice(n, 4321.123)) - 4321.123) < 0.001, true)
const nb = normBar(n, cut)
eq('spread scaled', nb.spread, 0.213)
const real = new Date(cut.time * 1000)
eq('same weekday + time', [new Date(nb.time * 1000).getUTCDay(), new Date(nb.time * 1000).getUTCHours()], [real.getUTCDay(), real.getUTCHours()])
eq('date moved to ~2000', new Date(nb.time * 1000).getUTCFullYear() <= 2000, true)

// 3. decision validation (real prices); entry buy = ask 2000.2
const c = bar(0, 2000, 2000, 2000, 2000, 0.2)
eq('skip ok', checkDecision({ side: 'skip' }, c, 1), null)
eq('sl required', checkDecision({ side: 'buy' }, c, 1), 'SL wajib diisi.')
eq('sl wrong side', checkDecision({ side: 'buy', sl: 2001 }, c, 1), 'SL buy harus di bawah harga.')
eq('sl too close', checkDecision({ side: 'buy', sl: 1999.5 }, c, 1), 'SL terlalu dekat. Jarak minimal 1.00.')
eq('tp wrong side', checkDecision({ side: 'sell', sl: 2002, tp: 2001 }, c, 1), 'TP sell harus di bawah harga entry.')
eq('valid sell', checkDecision({ side: 'sell', sl: 2002, tp: 1995 }, c, 1), null)

// 4. results in R, spread included
let o = runDecision(c, [bar(60, 2000, 2006.5, 1999, 2004)], { side: 'buy', sl: 1998.2, tp: 2006.2 })
eq('tp: (2006.2-2000.2)/2 = 3R', [o.reason, o.r], ['tp', 3])
o = runDecision(c, [bar(60, 2000, 2001, 1990, 1995)], { side: 'buy', sl: 1998.2, tp: 2006.2 })
eq('sl = -1R', [o.reason, o.r], ['sl', -1])
o = runDecision(c, [bar(60, 2000, 2001, 1999, 2000), bar(120, 2000, 2001, 1999, 2001.2)], { side: 'buy', sl: 1998.2 })
eq('timeout at last close: (2001.2-2000.2)/2', [o.reason, o.r, o.exitTime], ['time', 0.5, 120])
o = runDecision(c, [bar(60, 2000, 2000.1, 1999.9, 2000)], { side: 'sell', sl: 2004 })
eq('sell timeout pays spread: (2000-2000.2)/4', o.r, -0.05)
eq('skip = 0R', runDecision(c, [], { side: 'skip' }).r, 0)

// 4b. limit / stop orders: fill when the run reaches the price, 1R = order price to SL
o = runDecision(c, [bar(60, 2000, 2000.5, 1997, 1999), bar(120, 1999, 2002.5, 1999, 2002)], { side: 'buy', type: 'limit', price: 1998, sl: 1996, tp: 2002 })
eq('buy limit fills at 1998, TP 2002 = 2R', [o.reason, o.r, o.entry, o.type, o.price], ['tp', 2, 1998, 'limit', 1998])
o = runDecision(c, [bar(60, 2000, 2001, 1999.5, 2000)], { side: 'buy', type: 'limit', price: 1998, sl: 1996 })
eq('limit never reached = unfilled 0R', [o.reason, o.r, o.entry], ['unfilled', 0, null])
o = runDecision(c, [bar(60, 1996, 1996, 1994, 1994)], { side: 'sell', type: 'stop', price: 1995, sl: 1999 })
eq('sell stop fills at 1995, closes at Ask 1994.2', [o.reason, o.r], ['time', 0.2])
eq('buy limit above Ask rejected', checkDecision({ side: 'buy', type: 'limit', price: 2001, sl: 1995 }, c, 1), 'Buy limit harus di bawah harga Ask.')
eq('sell stop above Bid rejected', checkDecision({ side: 'sell', type: 'stop', price: 2001, sl: 2005 }, c, 1), 'Sell stop harus di bawah harga Bid.')
eq('pending SL measured from the order price', checkDecision({ side: 'buy', type: 'stop', price: 2003, sl: 2002.5 }, c, 1), 'SL terlalu dekat. Jarak minimal 1.00.')
eq('valid buy stop', checkDecision({ side: 'buy', type: 'stop', price: 2003, sl: 2001 }, c, 1), null)

// 5. cut search skips windows crossing a gap
const gap = [...Array.from({ length: 10 }, (_, i) => bar(i * 60, 1)), ...Array.from({ length: 10 }, (_, i) => bar(100000 + i * 60, 1))]
eq('first window without a gap', findCut(gap, 5, 5), 10)
eq('none', findCut(gap.slice(0, 8), 0, 10), -1)

console.log(fails ? `${fails} FAILED` : 'ALL PASS')
process.exit(fails ? 1 : 0)
