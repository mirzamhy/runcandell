import type { Context } from 'hono'

export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503
  constructor(status: HttpError['status'], message: string) {
    super(message)
    this.status = status
  }
}

// ---------- input validation ----------

export function str(v: unknown, field: string, max: number, min = 0): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`)
  const s = v.trim()
  if (s.length < min || s.length > max) throw new HttpError(400, `${field} must be ${min}–${max} characters.`)
  return s
}
export function int(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `${field} must be a number.`)
  return Math.round(v)
}
export function obj(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `Invalid ${field.toLowerCase()}.`)
  return v as Record<string, unknown>
}
export function idParam(c: Context): number {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found.')
  return id
}
export async function json(c: Context): Promise<Record<string, unknown>> {
  try {
    return obj(await c.req.json(), 'Body')
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(400, 'The body must be JSON.')
  }
}

