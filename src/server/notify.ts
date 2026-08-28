/**
 * The canvas's half of the notification relay (04-solution §2.3, §9.5).
 *
 * Three transactional moments, exactly: you were invited (a view/comment grant
 * landed on an address), your request was approved, someone asked for access
 * (to the owner - and that mail carries only "someone"). Delivery is the ID
 * service's relay; the canvas never talks to Resend. The action token is
 * signed by the canvas identity key - owner authorization is implicit in the
 * signature, since only the canvas server holds it.
 *
 * Fire-and-forget, always: a notification that failed must never be the reason
 * a grant did not land. Idempotency lives at the relay, keyed on
 * (origin, template, eventId) - the eventId is derived from the STATE
 * TRANSITION, so a re-invite at the same role sends nothing and a role change
 * sends one.
 */
import { createHash } from 'node:crypto'
import { signCanvasJws } from './summary.ts'

export type RelayTemplate = 'invited' | 'request-approved' | 'access-requested'

export interface NotifyCtx {
  dataDir: string
  /** The identity issuer - the relay lives there. Null = sovereign, no mail. */
  issuer: string | null
  /** This canvas's exact public origin. */
  origin: string | null
  /** `share: { notify: false }` - the owner declined the relay entirely. */
  enabled: boolean
}

export const transitionId = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)

export function relayNotify(ctx: NotifyCtx, template: RelayTemplate, recipient: string, eventId: string): void {
  if (!ctx.enabled || !ctx.issuer || !ctx.origin) return
  if (recipient.startsWith('@') || !recipient.includes('@')) return   // domains have no inbox
  const now = Math.floor(Date.now() / 1000)
  let token: string
  try {
    token = signCanvasJws(ctx.dataDir, {
      origin: ctx.origin, template, recipient, eventId, iat: now, exp: now + 600,
    }, 'marver-relay+jwt')
  } catch { return }                                  // no identity key yet - nothing to sign with
  void fetch(`${ctx.issuer.replace(/\/+$/, '')}/relay/notify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  }).catch(() => { /* the outbox is the relay's problem; a grant never waits on mail */ })
}
