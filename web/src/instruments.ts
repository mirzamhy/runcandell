/**
 * Instruments the app offers (the data side lives in tools/symbols.py). Shared by web and server,
 * so plain erasable TS only.
 *
 * digits      price decimals shown to users
 * contract    units per 1.00 lot (P&L = price move x contract x lots, in the quote currency)
 * quote       quote currency; JPY P&L is converted to USD at the closing price
 * duelScale   duel price normalisation: (price - cut) x k x duelScale + 1000, so every pair moves
 *             about like gold (~4000) on screen and its real price stays hidden
 */
export interface Instrument {
  symbol: string
  label: string
  digits: number
  contract: number
  quote: 'USD' | 'JPY'
  duelScale: number
  /** default lot size step for the paper-trading ticket */
  lotStep: number
}

export const INSTRUMENTS: Record<string, Instrument> = {
  XAUUSD: { symbol: 'XAUUSD', label: 'Gold / USD', digits: 2, contract: 100, quote: 'USD', duelScale: 1, lotStep: 0.01 },
  EURUSD: { symbol: 'EURUSD', label: 'Euro / USD', digits: 5, contract: 100000, quote: 'USD', duelScale: 3500, lotStep: 0.01 },
  USDJPY: { symbol: 'USDJPY', label: 'USD / Japanese yen', digits: 3, contract: 100000, quote: 'JPY', duelScale: 27, lotStep: 0.01 },
  US100: { symbol: 'US100', label: 'Nasdaq 100', digits: 2, contract: 1, quote: 'USD', duelScale: 0.18, lotStep: 0.1 },
  BTCUSD: { symbol: 'BTCUSD', label: 'Bitcoin / USD', digits: 2, contract: 1, quote: 'USD', duelScale: 0.04, lotStep: 0.01 },
}

export const SYMBOL_LIST = Object.keys(INSTRUMENTS)

export const instrument = (symbol: string): Instrument => INSTRUMENTS[symbol] ?? { ...INSTRUMENTS.XAUUSD, symbol, label: symbol }
