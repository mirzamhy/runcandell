import { runBacktest, type BtTrade } from './run.ts'
import { metrics, downsample } from './report.ts'
import { compileCode, compileRules, defaultSpec, listParams, operand, withParams, toData, withParam, type Signal, type StrategySpec } from './strategy.ts'

let fails = 0
const eq = (name: string, a: unknown, b: unknown) => {
  const ok = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : JSON.stringify(a) === JSON.stringify(b)
  if (!ok) { fails++; console.log('FAIL', name, a, '!=', b) } else console.log('ok  ', name)
}
const bar = (time: number, o: number, h = o, l = o, c = o, spread = 0.2) => ({ time, open: o, high: h, low: l, close: c, volume: 1, spread })
const flat = (n: number, tf = 300) => Array.from({ length: n }, (_, i) => bar(i * tf, 2000))
const spec = (over: Partial<StrategySpec> = {}): StrategySpec => ({
  ...defaultSpec(),
  sl: { kind: 'price', value: 5 },
  tp: { kind: 'price', value: 5 },
  sizing: { kind: 'fixed', value: 1 },
  ...over,
})
const sig = (map: Record<number, Signal>) => (i: number) => map[i] ?? null
const run = (bars: ReturnType<typeof flat>, s: StrategySpec, signal: (i: number) => Signal | null, m1: ReturnType<typeof flat> | null = null) =>
  runBacktest({ spec: s, bars, tfSec: 300, m1, signal, atr: new Float64Array(bars.length).fill(4), start: 0, end: Infinity, hourOf: () => 3 })

// 1. signal on bar 2 close -> entry at bar 3 open (Ask), TP on bar 4
let bars = flat(8)
bars[4] = bar(1200, 2000, 2006, 1999, 2003)
let r = run(bars, spec(), sig({ 2: { enter: { side: 'buy' } } }))
eq('one trade', r.trades.length, 1)
eq('entry at next open', r.trades[0].openTime, 900)
eq('entry = open + spread', r.trades[0].entry, 2000.2)
eq('tp hit', r.trades[0].reason, 'tp')
eq('pnl 5 * 100', r.trades[0].pnl, 500)
eq('equity points = bars', r.eqValue.length, 8)
eq('final equity = balance', r.eqValue[7], 10500)

// 2. both levels inside one strategy bar: M1 decides the order
bars = flat(8)
bars[4] = bar(1200, 2000, 2006, 1994, 2000)
r = run(bars, spec(), sig({ 2: { enter: { side: 'buy' } } }))
eq('no M1 -> worst case SL', r.trades[0].reason, 'sl')
const m1 = flat(40, 60)
m1[21] = bar(1260, 2000, 2006, 2000, 2003) // TP first
m1[23] = bar(1380, 2000, 2000, 1994, 1996) // SL later
r = run(bars, spec(), sig({ 2: { enter: { side: 'buy' } } }), m1)
eq('M1 path -> TP first', r.trades[0].reason, 'tp')
eq('closed on the M1 minute', r.trades[0].closeTime, 1260)

// 3. risk sizing: 1% of 10000 with $5 stop = 0.2 lot, R = 1 at TP
bars = flat(8)
bars[4] = bar(1200, 2000, 2006, 1999, 2003)
r = run(bars, spec({ sizing: { kind: 'risk', value: 1 } }), sig({ 2: { enter: { side: 'buy' } } }))
eq('lots', r.trades[0].lots, 0.2)
eq('risk usd', r.trades[0].risk, 100)
eq('R', r.trades[0].r, 1)

// 4. reverse on opposite signal; open trade closed at end of data
r = run(flat(10), spec({ sl: { kind: 'none', value: 0 }, tp: { kind: 'none', value: 0 }, reverse: true }),
  sig({ 1: { enter: { side: 'buy' } }, 4: { enter: { side: 'sell' } } }))
eq('two trades', r.trades.map((t) => [t.side, t.reason]), [['buy', 'signal'], ['sell', 'end']])
eq('reverse at bar 5 open', r.trades[1].openTime, 1500)
r = run(flat(10), spec({ sl: { kind: 'none', value: 0 }, tp: { kind: 'none', value: 0 } }),
  sig({ 1: { enter: { side: 'buy' } }, 4: { enter: { side: 'sell' } } }))
eq('no reverse -> opposite ignored', r.trades.map((t) => t.side), ['buy'])

// 5. exit signal and max bars
r = run(flat(10), spec(), sig({ 1: { enter: { side: 'buy' } }, 3: { exit: 'long' } }))
eq('exit signal at bar 4 open', [r.trades[0].reason, r.trades[0].closeTime], ['signal', 1200])
r = run(flat(10), spec({ maxBars: 2 }), sig({ 1: { enter: { side: 'buy' } } }))
eq('time exit', [r.trades[0].reason, r.trades[0].bars], ['time', 2])

// 6. filters and skips
r = run(flat(10), spec({ hours: { on: true, from: 14, to: 23 } }), sig({ 1: { enter: { side: 'buy' } } }))
eq('hours filter', [r.trades.length, r.skipped['outside entry hours']], [0, 1])
r = run(flat(10), spec({ hours: { on: true, from: 22, to: 5 } }), sig({ 1: { enter: { side: 'buy' } } }))
eq('hours wrap midnight', r.trades.length, 1)
r = run(flat(10), spec({ sl: { kind: 'atr', value: 1 } }), sig({ 1: { enter: { side: 'buy' } } }))
eq('atr stop distance', r.trades[0].sl, 2000.2 - 4)
r = run(flat(10), spec({ slippage: 0.3 }), sig({ 1: { enter: { side: 'sell' } } }))
eq('sell slippage', r.trades[0].entry, 1999.7)

// 7. rules: cross detection on closes
let d = toData([bar(0, 2000), bar(300, 2000), bar(600, 2002, 2002, 2002, 2002)])
const fn = compileRules(spec({ long: [{ a: operand('close'), op: 'xup', b: operand('num', [2001]) }], short: [] }), d)
eq('no signal before cross', fn(1), null)
eq('cross up -> buy', fn(2), { enter: { side: 'buy' } })

// 8. code mode
d = toData(flat(5))
const cf = compileCode('return function (i) { return i === 3 ? { side: "sell", sl: 2010 } : close[i] > 3000 ? "buy" : null }', d)
eq('code object', cf(3), { enter: { side: 'sell', sl: 2010 } })
eq('code null', cf(1), null)

// 9. metrics
const T = (pnl: number, r: number | null = null) => ({ pnl, r, side: 'buy', bars: 2 }) as BtTrade
const m = metrics([T(200, 2), T(-100, -1), T(-100, -1), T(300, 3)], [0, 86400, 172800, 259200], [10200, 10100, 10000, 10300], 10000)
eq('net', m.net, 300)
eq('pf', m.profitFactor, 2.5)
eq('win rate', m.winRate, 0.5)
eq('expectancy', m.expectancy, 75)
eq('avg R', m.avgR, 0.75)
eq('max dd', [m.maxDd, m.maxDdPct], [200, 200 / 10200])
eq('loss streak', m.maxLossStreak, 2)
const ds = downsample([...Array(5000).keys()], [...Array(5000).keys()].map((i) => (i === 2500 ? -1 : i)), 100)
eq('downsample keeps the low and the end', [ds.v.length, ds.v.includes(-1), ds.v[99]], [100, true, 4999])

// 10. params: one knob moves the same EMA in buy and sell rules
const s10 = defaultSpec()
const p = listParams(s10).find((x) => x.label.startsWith('EMA period (20)'))!
const s11 = withParam(s10, p.id, 10)
eq('both EMA 20 changed', [s11.long[0].a.p[0], s11.short[0].a.p[0], s11.long[0].b.p[0]], [10, 10, 50])
eq('original untouched', s10.long[0].a.p[0], 20)
const ids = listParams(s10)
const e20 = ids.find((x) => x.label.startsWith('EMA period (20)'))!.id
const e50 = ids.find((x) => x.label.startsWith('EMA period (50)'))!.id
const s12 = withParams(s10, [[e20, 50], [e50, 100]])
eq('no chaining', [s12.long[0].a.p[0], s12.long[0].b.p[0]], [50, 100])

console.log(fails ? `${fails} FAILED` : 'ALL PASS')
process.exit(fails ? 1 : 0)
