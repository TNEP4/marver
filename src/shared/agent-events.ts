import type { AgentMeta, CommentEvent } from './events.ts'

/** One eligibility rule for published intake, sync and build seeds. The caller supplies only
 *  the log the canvas holds (or is about to hold); authentication remains at the transport. */
export function publishableAgentEvent(e: CommentEvent, log: readonly CommentEvent[]): boolean {
  if (e.agent !== true || e.capture) return false
  const message = (id?: string) => id ? log.find((m) => m && (m.type === 'create' || m.type === 'reply') && m.commentId === id) : undefined
  const target = message(e.type === 'reply' ? e.parentId : e.commentId)
  const root = target?.type === 'reply' ? message(target.parentId) : target
  if (!root || root.type !== 'create' || root.agent || root.capture) return false
  if (e.type === 'reply') return target === root
  if (e.type === 'edit' || e.type === 'delete') return target?.type === 'reply' && target.agent === true
  return e.type === 'reanchor' && target === root && e.frame === undefined && e.anchor != null
}

/** Only these provenance fields may leave the machine, including historical build seeds. */
export function publicAgentMeta(meta: unknown): AgentMeta | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const raw = meta as Record<string, unknown>, out: AgentMeta = {}
  for (const k of ['harness', 'model', 'effort'] as const) if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, 80)
  if (raw.runner === 'session' || raw.runner === 'fork' || raw.runner === 'fresh') out.runner = raw.runner
  return Object.keys(out).length ? out : undefined
}

export function publicCommentEvent(e: CommentEvent): CommentEvent {
  const { agentMeta, alsoChanged, ...rest } = e
  // Historical logs may carry a client-supplied author.agent. Provenance belongs to the event.
  if (rest.author && 'agent' in rest.author) {
    const { agent: _agent, ...author } = rest.author as NonNullable<CommentEvent['author']> & { agent?: unknown }
    rest.author = author
  }
  const meta = e.agent === true ? publicAgentMeta(agentMeta) : undefined
  return { ...rest, ...(meta ? { agentMeta: meta } : {}) }
}

export const reservedMarverName = (name: unknown): boolean => typeof name === 'string' && /^@?marver\b/i.test(name.trim())
export const operatorId = (id: unknown): boolean => typeof id === 'string' && id.startsWith('jam-')
