import { readItem } from '../lib/webStorage'
import type { ConsentConfig } from '../types'

export type Denial = 'disabled' | 'dnt' | 'optout'

/** Do Not Track (every historical spelling) or Global Privacy Control. */
export function privacySignal(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string }
  const win = globalThis as { doNotTrack?: string }
  return (
    nav.globalPrivacyControl === true ||
    nav.doNotTrack === '1' ||
    nav.doNotTrack === 'yes' ||
    nav.msDoNotTrack === '1' ||
    win.doNotTrack === '1'
  )
}

export function isOptedOut(optOutKey: string | undefined): boolean {
  return !!optOutKey && readItem('local', optOutKey) === 'true'
}

/** Why tracking must not run at all, or `null` if it may. Sampling is decided per visit,
 *  separately — see `IdentityManager.sampleRoll`. */
export function consentDenial(consent: ConsentConfig = {}): Denial | null {
  if (consent.enabled === false) return 'disabled'
  if (consent.respectDnt !== false && privacySignal()) return 'dnt'
  if (isOptedOut(consent.optOutKey)) return 'optout'
  return null
}

/** `roll` is fixed for a visit, so a visit is either tracked whole or not at all —
 *  per-event sampling would make step B of a funnel appear to out-convert step A. */
export function sampledIn(roll: number, sampleRate: number | undefined): boolean {
  return roll < (sampleRate ?? 1)
}
