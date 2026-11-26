import { asks, type CommentEvent, type Thread } from './events.ts'

export const COMMENT_FRESH_MS = 15 * 60_000
type Identity = { email?: string; id?: string }
export const sameReader = (a: Identity | undefined, me: Identity | null): boolean =>
  !!a && !!me && (!!a.id && a.id === me.id || !!a.email && !!me.email && a.email.toLowerCase() === me.email.toLowerCase())

/** Agent authors carry the operator's identity; they never make that person a participant. */
export function participates(t: Thread | undefined, me: Identity | null, except?: string): boolean {
  return !!t && ((!t.agent && sameReader(t.author, me)) || t.replies.some((r) => !r.agent && r.id !== except && sameReader(r.author, me)))
}

export function commentNotice(e: CommentEvent, t: Thread | undefined, me: Identity | null, local: boolean, owner: boolean): 'question' | 'reply' | 'mention' | null {
  if (e.agent) {
    if (e.type !== 'create' && e.type !== 'reply' && !(e.type === 'edit' && e.asks === true)) return null
    if (!local && !participates(t, me, e.commentId)) return null
    const question = asks(e, e.type === 'create')
    if ((local || owner) && question) return 'question'
    return !local && e.type === 'reply' ? 'reply' : null
  }
  if (!me || !e.author || sameReader(e.author, me) || (e.type !== 'create' && e.type !== 'reply')) return null
  if (e.mentions?.some((m) => sameReader(m, me))) return 'mention'
  return e.type === 'reply' && participates(t, me, e.commentId) ? 'reply' : null
}
