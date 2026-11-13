export interface ZoneOption {
  id: string
  label: string
}

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone

export const ZONES: ZoneOption[] = [
  { id: 'UTC', label: 'UTC' },
  { id: 'Asia/Jakarta', label: 'WIB (Jakarta)' },
  { id: 'Europe/London', label: 'London' },
  { id: 'America/New_York', label: 'New York' },
  ...(['UTC', 'Asia/Jakarta', 'Europe/London', 'America/New_York'].includes(browserZone)
    ? []
    : [{ id: browserZone, label: `Lokal (${browserZone})` }]),
]

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(zone: string) {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(zone, f)
  }
  return f
}

/** Seconds to add to a UTC timestamp to get wall-clock time in `zone`. */
export function zoneOffset(zone: string, t: number): number {
  if (zone === 'UTC') return 0
  const parts: Record<string, number> = {}
  for (const p of formatter(zone).formatToParts(new Date(t * 1000))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000
  return wall - Math.floor(t)
}

/**
 * Chart times are "wall-clock seconds as if UTC" (lightweight-charts formats in UTC).
 * Offsets only change on hour boundaries, so cache per hour.
 */
export function makeShifter(zone: string): (t: number) => number {
  const cache = new Map<number, number>()
  return (t) => {
    const key = Math.floor(t / 3600)
    let o = cache.get(key)
    if (o === undefined) {
      o = zoneOffset(zone, key * 3600)
      cache.set(key, o)
    }
    return t + o
  }
}

const nyShift = makeShifter('America/New_York')

/** Gold trading-day id (days since epoch): the day starts 17:00 New York, DST aware. */
export function tradingDay(t: number): number {
  return Math.floor((nyShift(t) + 7 * 3600) / 86400)
}

/** D1 bars start 17:00 New York; show them on their trading date (00:00 of the next calendar day). */
export function d1DisplayTime(t: number): number {
  return Math.floor((t + 12 * 3600) / 86400) * 86400
}

/** Parse "YYYY-MM-DDTHH:mm" typed in `zone` into a UTC timestamp. */
export function parseZoned(value: string, zone: string): number | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/)
  if (!m) return null
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) / 1000
  const guess = wall - zoneOffset(zone, wall)
  return wall - zoneOffset(zone, guess)
}

const pad = (n: number) => String(n).padStart(2, '0')

export function formatWall(wall: number, withTime = true): string {
  const d = new Date(wall * 1000)
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return withTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date
}

export function toInputValue(wall: number): string {
  return formatWall(wall).replace(' ', 'T')
}
