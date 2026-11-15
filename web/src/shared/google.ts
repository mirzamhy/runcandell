/**
 * "Masuk dengan Google" (Google Identity Services). The button only shows when the server has a
 * client ID (env RC_GOOGLE_CLIENT_ID); the server checks the token Google hands us.
 */
import { api } from '../api'

interface GisButtonOptions {
  theme?: 'outline' | 'filled_blue' | 'filled_black'
  size?: 'large' | 'medium'
  text?: 'signin_with' | 'signup_with' | 'continue_with'
  shape?: 'pill' | 'rectangular'
  width?: number
  locale?: string
  click_listener?: () => void
}
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: 'popup'; use_fedcm_for_button?: boolean }): void
          renderButton(el: HTMLElement, o: GisButtonOptions): void
        }
      }
    }
  }
}

let clientId: Promise<string | null> | null = null
export const googleClientId = () =>
  (clientId ??= api
    .authConfig()
    .then((c) => c.googleClientId)
    .catch(() => null))

let script: Promise<void> | null = null
const loadGis = () =>
  (script ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      script = null
      reject(new Error('The Google button failed to load.'))
    }
    document.head.append(s)
  }))

// one Google callback per page; the button that was clicked last decides where the answer goes
let initialized = ''
let target: ((credential: string) => void) | null = null

/**
 * Draws the Google button into `el`. False (and `el` stays empty) when Google login is off
 * on the server or the script cannot load (offline, blocked).
 */
export async function mountGoogleButton(el: HTMLElement, onCredential: (credential: string) => void, text: GisButtonOptions['text'] = 'continue_with'): Promise<boolean> {
  const id = await googleClientId()
  if (!id) return false
  try {
    await loadGis()
  } catch {
    return false
  }
  const gis = window.google?.accounts.id
  if (!gis) return false
  if (initialized !== id) {
    gis.initialize({ client_id: id, ux_mode: 'popup', use_fedcm_for_button: true, callback: (r) => target?.(r.credential) })
    initialized = id
  }
  target = onCredential
  el.replaceChildren()
  gis.renderButton(el, {
    theme: 'filled_black',
    size: 'large',
    text,
    shape: 'pill',
    locale: 'en',
    // hidden slot (width 0): a width that fits a phone card
    width: Math.min(400, Math.max(200, Math.round(el.clientWidth || 280))),
    click_listener: () => (target = onCredential),
  })
  return true
}

