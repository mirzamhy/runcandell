import { Account, TradeError, stats } from './account.ts'
let fails = 0
const eq = (name: string, a: unknown, b: unknown) => {
  const ok = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : JSON.stringify(a) === JSON.stringify(b)
  if (!ok) { fails++; console.log('FAIL', name, a, '!=', b) } else console.log('ok  ', name)
}
const bar = (time: number, o: number, h: number, l: number, c: number, spread = 0.2) => ({ time, open: o, high: h, low: l, close: c, spread })
const throws = (name: string, f: () => void) => { try { f(); fails++; console.log('FAIL', name, 'no throw') } catch (e) { eq(name, e instanceof TradeError, true) } }

// 1. market buy fills at ask, closes at bid; pnl = move * 100 * lots
let a = new Account({ balance: 10000, leverage: 100, contractSize: 100, commissionPerLot: 0, stopOutLevel: 0.5 })
a.onBar(bar(0, 2000, 2001, 1999, 2000))
const p = a.market('buy', 0.1, 1995, 2010)
eq('buy entry = ask', p.entry, 2000.2)
eq('floating at same bar = -spread', a.floating(), -2)
a.onBar(bar(60, 2000, 2010.5, 1999, 2008))
eq('tp hit closes', a.positions.length, 0)
eq('tp pnl (2010-2000.2)*10', a.history[0].pnl, 98)
eq('balance', a.balance, 10098)
eq('reason tp', a.history[0].reason, 'tp')

// 2. SL and TP in same bar -> SL (worst case)
a = new Account(); a.onBar(bar(0, 2000, 2000, 2000, 2000))
a.market('buy', 1, 1990, 2010)
a.onBar(bar(60, 2000, 2015, 1985, 2000))
eq('both hit -> sl', a.history[0].reason, 'sl')
eq('sl pnl (1990-2000.2)*100', a.history[0].pnl, -1020)

// 3. gap through SL fills at open
a = new Account(); a.onBar(bar(0, 2000, 2000, 2000, 2000))
a.market('buy', 1, 1990, null)
a.onBar(bar(60, 1980, 1982, 1975, 1978))
eq('gap fill at open', a.history[0].exit, 1980)

// 4. sell closes at ask: TP must be reached by ask (low + spread)
a = new Account(); a.onBar(bar(0, 2000, 2000, 2000, 2000))
const s = a.market('sell', 1, 2010, 1990)
eq('sell entry = bid', s.entry, 2000)
a.onBar(bar(60, 1999, 1999, 1989.9, 1995)) // ask low = 1990.1 > 1990, not hit
eq('sell tp not hit by bid alone', a.positions.length, 1)
a.onBar(bar(120, 1995, 1995, 1989.7, 1992)) // ask low 1989.9
eq('sell tp hit by ask', a.history[0].reason, 'tp')
eq('sell pnl (2000-1990)*100', a.history[0].pnl, 1000)

// 5. buy limit triggers on ask, fills at limit; TP not taken in fill bar
a = new Account(); a.onBar(bar(0, 2000, 2000, 2000, 2000))
a.pending('buy', 'limit', 1, 1995, 1990, 2001)
a.onBar(bar(60, 2000, 2002, 1994.9, 1996)) // ask low 1995.1 -> no fill
eq('limit not filled yet', a.orders.length, 1)
a.onBar(bar(120, 1996, 2003, 1994.5, 1997)) // ask low 1994.7 -> fill 1995; high ask 2003.2 >= tp but same bar
eq('limit filled', a.positions.length, 1)
eq('limit fill price', a.positions[0].entry, 1995)
eq('tp skipped in fill bar', a.history.length, 0)
a.onBar(bar(180, 1997, 2001.5, 1996, 2000))
eq('tp next bar', a.history[0]?.reason, 'tp')

// 6. sell stop with gap fills at open
a = new Account(); a.onBar(bar(0, 2000, 2000, 2000, 2000))
a.pending('sell', 'stop', 1, 1990)
a.onBar(bar(60, 1985, 1986, 1984, 1985))
eq('sell stop gap fill at open', a.positions[0].entry, 1985)

// 7. validation
a = new Account(); a.onBar(bar(0, 2000, 2000, 2000, 2000))
throws('buy sl above price', () => a.market('buy', 1, 2001, null))
throws('sell tp above price', () => a.market('sell', 1, null, 2001))
throws('buy limit above ask', () => a.pending('buy', 'limit', 1, 2005))
throws('lot step', () => a.market('buy', 0.015))
throws('margin', () => a.market('buy', 6)) // 6 lots * 2000*100/100 = 12000 > 10000

// 8. stop-out
a = new Account(); a.onBar(bar(0, 2000, 2000, 2000, 2000))
a.market('buy', 4.5) // margin 9000
a.onBar(bar(60, 1990, 1990, 1985, 1985)) // loss ~ (1985-2000.2)*450 = -6840 -> equity 3160 / 9000 = 35%
eq('stop-out closes all', a.positions.length, 0)
eq('stop-out reason', a.history[0].reason, 'stopout')

// 9. stats
const st = stats([{ pnl: 100 }, { pnl: -50 }, { pnl: 50 }] as never, 1000)
eq('winrate', st.winRate, 2 / 3)
eq('pf', st.profitFactor, 3)
eq('maxdd', st.maxDrawdown, 50 / 1100)

// 10. persistence roundtrip
const j = JSON.parse(JSON.stringify(a.toJSON()))
eq('roundtrip balance', Account.fromJSON(j).balance, a.balance)

console.log(fails ? `${fails} FAILED` : 'ALL PASS')
process.exit(fails ? 1 : 0)
