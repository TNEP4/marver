/**
 * The canvas's half of the notification relay (04-solution §2.3, §9.5; v1.1
 * additions in 07-v1.1 §A/§B).
 *
 * Transactional moments: you were invited, your request was approved, someone
 * asked for access. Activity moments (v1.1): a thread you are in moved
 * (`reply`), somebody named you (`mentioned`). Delivery is the ID service's
 * relay; the canvas never talks to Resend. The action token is signed by the
 * canvas identity key - owner authorization is implicit in the signature,
 * since only the canvas server holds it.
 *
 * Fire-and-forget, always: a notification that failed must never be the reason
 * a comment or grant did not land - delivery is best-effort at this boundary,
 * durable only once the relay's outbox row exists. Idempotency lives at the
 * relay, keyed on (origin, template, eventId) - the eventId is derived from
 * the STATE TRANSITION, so a re-invite at the same role sends nothing, a
 * mention mails once per person per comment ever, and replies throttle to one
 * mail per recipient per thread per window.
 *
 * All relay requests ride ONE promise chain: however wide a reply fans out,
 * this process holds at most one in-flight relay request (each bounded by its
 * own 5s timeout) - a comment-authorized caller cannot burst sockets.
 */
import { createHash } from 'node:crypto'
import { signCanvasJws } from './summary.ts'
import type { CommentEvent } from '../shared/events.ts'

export type RelayTemplate = 'invited' | 'request-approved' | 'access-requested' | 'reply' | 'mentioned'

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

let chain: Promise<void> = Promise.resolve()

/** WHO and WHAT an activity mail may say (07-v1.1 §D amendment 2): a bounded
 *  actor display name and comment snippet, riding the signed token. The relay
 *  re-bounds and HTML-escapes; the caps here just keep tokens small. */
export interface MailContent { actor?: string; snippet?: string; link?: string }

const capped = (s: string | undefined, cap: number): string | undefined => {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t ? (t.length > cap ? `${t.slice(0, cap - 1)}…` : t) : undefined
}

export function relayNotify(ctx: NotifyCtx, template: RelayTemplate, recipient: string, eventId: string, content?: MailContent): void {
  if (!ctx.enabled || !ctx.issuer || !ctx.origin) return
  if (recipient.startsWith('@') || !recipient.includes('@')) return   // domains have no inbox
  const { dataDir, origin } = ctx
  const actor = capped(content?.actor, 60)
  const snippet = capped(content?.snippet, 180)
  const link = content?.link && content.link.length <= 160 ? content.link : undefined
  const url = `${ctx.issuer.replace(/\/+$/, '')}/relay/notify`
  // the token is minted WHEN its turn in the chain comes, not at enqueue - a
  // deep queue must never dispatch an already-expired credential
  chain = chain.then(() => {
    const now = Math.floor(Date.now() / 1000)
    let token: string
    try {
      token = signCanvasJws(dataDir, {
        origin, template, recipient, eventId, iat: now, exp: now + 600,
        ...(actor ? { actor } : {}), ...(snippet ? { snippet } : {}), ...(link ? { link } : {}),
      }, 'marver-relay+jwt')
    } catch { return }                                // no identity key yet - nothing to sign with
    return fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    }).then(() => undefined, () => undefined)         // the outbox is the relay's problem; nothing waits on mail
  })
}

// ---- comment activity (v1.1) ----

const FRESH_MS = 15 * 60_000            // the intent line: live writes notify, history imports never do
const REPLY_WINDOW_MS = 6 * 3600_000    // one reply mail per recipient per thread per window (a throttle, not a digest)
const MAX_REPLY_RECIPIENTS = 10         // the most recent distinct participants; bounds every fan-out

/**
 * Mail the people a fresh comment batch concerns. `accepted` is what
 * appendEvents actually took (never the raw POST body); `log` is the board's
 * full event list including them; `allowed` is the resolver's answer for THIS
 * board (≥ view), injected so this stays pure of store plumbing. Recipients
 * are canonical emails - by the time events land here the write boundary has
 * already inverted the projection.
 *
 * Windows use SERVER time, never ev.ts - a client-datable timestamp must not
 * pick its own throttle bucket. The board is in every key because comment ids
 * are only board-local.
 */
export function notifyCommentActivity(
  ctx: NotifyCtx, board: string, accepted: CommentEvent[], log: CommentEvent[],
  allowed: (email: string) => boolean,
): void {
  if (!ctx.enabled || !ctx.issuer || !ctx.origin) return
  for (const [eventId, job] of activityJobs(board, accepted, log, allowed, Date.now()))
    relayNotify(ctx, job.template, job.recipient, eventId, { actor: job.actor, snippet: job.snippet, link: job.link })
}

/** The pure half: which (template, recipient, transition) a batch owes. Split
 *  out so the fan-out rules are testable without a relay or a signing key. */
export function activityJobs(
  board: string, accepted: CommentEvent[], log: CommentEvent[],
  allowed: (email: string) => boolean, now: number,
): Map<string, { template: RelayTemplate; recipient: string; actor?: string; snippet?: string; link?: string }> {
  const jobs = new Map<string, { template: RelayTemplate; recipient: string; actor?: string; snippet?: string; link?: string }>()
  // the canvas's own thread deep link (hash.ts: #/b/<board>?c=<id>) - the mail
  // CTA lands ON the conversation, not just the front door
  const threadLink = (threadId: string | undefined) =>
    threadId ? `/#/b/${encodeURIComponent(board)}?c=${encodeURIComponent(threadId)}` : undefined
  for (const ev of accepted) {
    if ((ev.type !== 'create' && ev.type !== 'reply') || Math.abs(now - ev.ts) > FRESH_MS) continue
    const author = ev.author?.email?.toLowerCase()
    const mentioned = new Set<string>()
    for (const m of ev.mentions ?? []) {
      const email = m.email?.toLowerCase()
      if (!email || email === author || !allowed(email)) continue
      mentioned.add(email)
      jobs.set(transitionId('mention', email, board, ev.commentId ?? ev.id),
        { template: 'mentioned', recipient: email, actor: ev.author?.name, snippet: ev.body,
          link: threadLink(ev.type === 'reply' ? ev.parentId : ev.commentId) })
    }
    if (ev.type !== 'reply' || !ev.parentId) continue
    // thread participants, most recent first: prior replies to this thread + its root.
    // A mentioned participant gets only the mention - the more specific fact.
    const recent: string[] = []
    for (let i = log.length - 1; i >= 0 && recent.length < MAX_REPLY_RECIPIENTS; i--) {
      const p = log[i]
      if (p.id === ev.id) continue
      const inThread = p.type === 'reply' ? p.parentId === ev.parentId : p.type === 'create' && p.commentId === ev.parentId
      const email = inThread ? p.author?.email?.toLowerCase() : undefined
      if (email && email !== author && !mentioned.has(email) && !recent.includes(email)) recent.push(email)
    }
    const window = String(Math.floor(now / REPLY_WINDOW_MS))
    for (const email of recent) {
      if (!allowed(email)) continue
      jobs.set(transitionId('reply', email, board, ev.parentId, window),
        { template: 'reply', recipient: email, actor: ev.author?.name, snippet: ev.body, link: threadLink(ev.parentId) })
    }
  }
  return jobs
}
