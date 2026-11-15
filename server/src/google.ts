/**
 * "Sign in with Google": checks the ID token (a JWT) the Google button hands the browser.
 * Signature against Google's public keys (RS256), then issuer, audience (our client ID) and expiry.
 * No library: node:crypto verifies the signature, the keys are fetched and cached here.
 */
import { createPublicKey, verify, type webcrypto } from 'node:crypto'
import { HttpError } from './http.ts'

export interface GoogleClaims {
  /** stable Google account id */
  sub: string
  email: string | null
  name: string | null
}

export type Jwk = webcrypto.JsonWebKey & { kid?: string }
/** `fresh`: skip the cache (a key we do not know yet, Google rotated them) */
export type JwksSource = (fresh?: boolean) => Promise<Jwk[]>

const CERTS = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])

/** Google's keys, cached for as long as their Cache-Control allows (they rotate every few weeks). */
export function googleJwks(): JwksSource {
  let keys: Jwk[] = []
  let until = 0
  let fetched = 0
  return async (fresh = false) => {
    // a forced refetch at most once a minute: made-up key ids must not turn into a flood of requests to Google
    if (Date.now() < until && (!fresh || Date.now() - fetched < 60_000)) return keys
    const res = await fetch(CERTS)
    if (!res.ok) throw new HttpError(503, 'Could not reach Google. Try again.')
    keys = ((await res.json()) as { keys: Jwk[] }).keys
    fetched = Date.now()
    const age = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600)
    until = Date.now() + age * 1000
    return keys
  }
}

const part = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))

export async function verifyGoogleToken(credential: string, clientId: string, jwks: JwksSource, now: number): Promise<GoogleClaims> {
  const bad = () => new HttpError(401, 'Invalid Google sign-in. Try again.')
  const pieces = credential.split('.')
  if (pieces.length !== 3) throw bad()
  let header: { alg?: string; kid?: string }
  let claims: Record<string, unknown>
  try {
    header = part(pieces[0])
    claims = part(pieces[1])
  } catch {
    throw bad()
  }
  if (header.alg !== 'RS256') throw bad()
  const jwk = (await jwks()).find((k) => k.kid === header.kid) ?? (await jwks(true)).find((k) => k.kid === header.kid)
  if (!jwk) throw bad()
  const ok = verify('RSA-SHA256', Buffer.from(`${pieces[0]}.${pieces[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(pieces[2], 'base64url'))
  if (!ok) throw bad()
  if (!ISSUERS.has(claims.iss as string) || claims.aud !== clientId) throw bad()
  // a minute of clock slack either way
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new HttpError(401, 'The Google sign-in expired. Try again.')
  if (typeof claims.iat === 'number' && claims.iat > now + 60) throw bad()
  if (typeof claims.sub !== 'string' || !claims.sub) throw bad()
  const email = typeof claims.email === 'string' && claims.email_verified === true ? claims.email : null
  return { sub: claims.sub, email, name: typeof claims.name === 'string' ? claims.name : null }
}

/** A nickname to offer a new Google user: never their real name (it would show on the leaderboard). */
export function suggestNickname(taken: (n: string) => boolean): string {
  for (let i = 0; i < 50; i++) {
    const n = `trader${Math.floor(1000 + Math.random() * 9000)}`
    if (!taken(n)) return n
  }
  return `trader${Date.now() % 1_000_000}`
}
