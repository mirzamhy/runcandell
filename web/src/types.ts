/** Plain data types and constants, shared with the server (no Vite or browser code here). */

export const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const
export type TF = (typeof TIMEFRAMES)[number]

export const TF_SECONDS: Record<TF, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
}

export interface Bar {
  time: number // unix seconds UTC, bar open
  open: number
  high: number
  low: number
  close: number
  volume: number
  spread: number // price units
}

export interface ChunkInfo {
  file: string
  bars: number
  from: number
  to: number
  bytes: number
}

export interface Manifest {
  symbol: string
  digits: number
  point: number
  timeframes: Record<TF, ChunkInfo[]>
}
