/**
 * Email + password accounts: scrypt hashes (node:crypto, no native module), email checks,
 * and a small in-memory brake on repeated wrong passwords.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { HttpError } from './http.ts'

// N = 2^15, r = 8, p = 1: ±32 MB and ±60 ms per hash (OWASP minimum for scrypt)
const N = 32768
const R = 8
const P = 1
const KEYLEN = 32
const MAXMEM = 64 * 1024 * 1024

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  )

/** `scrypt$N$r$p$salt$hash` (base64url), so the cost can rise later without breaking old hashes */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, N, R, P)
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const want = Buffer.from(hash, 'base64url')
  const got = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p))
  return got.length === want.length && timingSafeEqual(got, want)
}

/** a real hash of nothing, checked when the account does not exist so both cases take as long */
let dummy: Promise<string> | null = null
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(12).toString('hex')))

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
export function checkEmail(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError(400, 'Email is required.')
  const email = v.trim().toLowerCase()
  if (email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, 'Invalid email address.')
  return email
}

export function checkPassword(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError(400, 'Password is required.')
  if (v.length < 8) throw new HttpError(400, 'The password needs at least 8 characters.')
  if (v.length > 200) throw new HttpError(400, 'The password can have at most 200 characters.')
  return v
}

/**
 * Wrong-password brake: after `max` misses for one login (or one IP) within `windowSec`,
 * further tries answer 429 until the window passes. A success clears that login's count.
 */
export function loginBrake(now: () => number, max = 8, windowSec = 15 * 60) {
  const misses = new Map<string, number[]>()
  const recent = (k: string) => (misses.get(k) ?? []).filter((t) => t > now() - windowSec)
  return {
    check(...keys: string[]) {
      for (const k of keys) if (recent(k).length >= max) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.')
    },
    miss(...keys: string[]) {
      for (const k of keys) misses.set(k, [...recent(k), now()])
      if (misses.size > 10_000) for (const [k, v] of misses) if (!v.some((t) => t > now() - windowSec)) misses.delete(k)
    },
    clear(key: string) {
      misses.delete(key)
    },
  }
}
