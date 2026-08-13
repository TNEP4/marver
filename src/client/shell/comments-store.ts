/**
 * Comment state for the shell (SPEC-M3 §6) - its own small store beside the canvas
 * store. One API client for both worlds: `marver dev` (api.ts mirror, local profile,
 * poll) and the published serve (collab.ts, sessions, SSE). The shell never branches
 * on which one it is beyond capability flags the endpoints themselves report.
 */
import { create } from 'zustand'
import { replay, type CommentEvent, type Thread } from '../../shared/events.ts'
import { ROUTE } from '../const.ts'

export interface Me { email: string; name: string; avatar?: string }

interface CommentsState {
  events: CommentEvent[]              // the active board's log
  threads: Thread[]                   // derived on every change
  board: string | null
  me: Me | null                       // null on published until signed in
  local: boolean                      // dev mirror (identity is the local profile)
  commentMode: boolean                // C - picking + composing
  show: boolean                       // Shift+C - pins visible at all
  active: string | null               // open thread id
  draft: { nodeKey: string; frame: string; anchor: unknown } | null   // picked, composing
  needsIdentity: boolean              // published viewer tried to comment while signed out

  load(board: string): Promise<void>
  live(board: string): () => void
  send(events: CommentEvent[]): Promise<boolean>
  create(body: string): Promise<void>
  reply(threadId: string, body: string): Promise<void>
  resolve(threadId: string, reopen?: boolean): Promise<void>
  setMode(on: boolean): void
  setShow(show: boolean): void
  setActive(id: string | null): void
  setDraft(d: CommentsState['draft']): void
  signIn(email: string, password: string): Promise<string | null>
  claim(token: string, password: string, name: string): Promise<string | null>
  saveProfile(patch: Partial<Me>): Promise<void>
  dismissIdentity(): void
}

const uuid = () => crypto.randomUUID()
const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
const api = async (path: string, body?: unknown) => {
  const res = await fetch(`${ROUTE}/api/${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() },
    body: JSON.stringify(body),
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
}

export const useComments = create<CommentsState>((set, get) => {
  const derive = (events: CommentEvent[]) => ({ events, threads: replay(events) })
  const union = (events: CommentEvent[]) => {
    const have = new Set(get().events.map((e) => e.id))
    const fresh = events.filter((e) => !have.has(e.id))
    if (fresh.length) set(derive([...get().events, ...fresh]))
  }

  return {
    events: [], threads: [], board: null, me: null, local: false,
    commentMode: false, show: true, active: null, draft: null, needsIdentity: false,

    async load(board) {
      set({ board })
      const me = await api('me')
      if (me.ok) set({ me: me.data.user ?? null, local: !!me.data.local })
      const res = await api(`comments/${board}`)
      if (res.ok && get().board === board) set(derive(res.data.events ?? []))
    },

    /** Liveness: SSE when the server offers it, 30s+focus poll as the floor. */
    live(board) {
      const stops: (() => void)[] = []
      const es = new EventSource(`${ROUTE}/api/events`)
      es.addEventListener('comment', (e) => {
        try {
          const { board: b, ev } = JSON.parse((e as MessageEvent).data)
          if (b === get().board) union([ev])
        } catch { /* ignore */ }
      })
      es.addEventListener('resync', () => { void get().load(board) })
      es.onerror = () => { /* EventSource retries itself; the poll covers the gap */ }
      stops.push(() => es.close())
      const poll = () => { if (get().board === board) void api(`comments/${board}`).then((r) => r.ok && union(r.data.events ?? [])) }
      const iv = setInterval(poll, 30_000)
      const onFocus = () => poll()
      window.addEventListener('focus', onFocus)
      stops.push(() => { clearInterval(iv); window.removeEventListener('focus', onFocus) })
      return () => stops.forEach((f) => f())
    },

    async send(events) {
      const { board } = get()
      if (!board) return false
      union(events)                                     // optimistic - the id makes retries safe
      const res = await api(`comments/${board}`, { events })
      if (res.status === 401) { set({ needsIdentity: true }); return false }
      return res.ok
    },

    async create(body) {
      const { draft, me } = get()
      if (!draft || !body.trim()) return
      const id = uuid()
      const ok = await get().send([{
        id: uuid(), ts: Date.now(), type: 'create', commentId: id,
        nodeKey: draft.nodeKey, frame: draft.frame, anchor: draft.anchor,
        author: me ?? undefined, body: body.trim(),
      }])
      if (ok) set({ draft: null, active: id, commentMode: false })
    },

    async reply(threadId, body) {
      if (!body.trim()) return
      await get().send([{
        id: uuid(), ts: Date.now(), type: 'reply', commentId: uuid(), parentId: threadId,
        author: get().me ?? undefined, body: body.trim(),
      }])
    },

    async resolve(threadId, reopen = false) {
      await get().send([{ id: uuid(), ts: Date.now(), type: reopen ? 'reopen' : 'resolve', commentId: threadId }])
    },

    setMode(on) { set({ commentMode: on, ...(on ? { show: true } : { draft: null }) }) },
    setShow(show) { set({ show }) },
    setActive(active) { set({ active }) },
    setDraft(draft) { set({ draft }) },
    dismissIdentity() { set({ needsIdentity: false }) },

    async signIn(email, password) {
      const res = await api('auth/signin', { email, password })
      if (!res.ok) return res.data?.error ?? 'sign-in failed'
      set({ me: res.data.user, needsIdentity: false })
      return null
    },
    async claim(token, password, name) {
      const res = await api('auth/claim', { token, password, name })
      if (!res.ok) return res.data?.error ?? 'claim failed'
      set({ me: res.data.user, needsIdentity: false })
      return null
    },
    async saveProfile(patch) {
      const res = await api('profile', patch)
      if (res.ok) set({ me: res.data.user })
    },
  }
})

/** Initials + deterministic hue for avatarless authors - the whole fallback ladder. */
export const avatarFallback = (author?: { email?: string; name?: string }) => {
  const name = author?.name || author?.email || '?'
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  let h = 0
  for (const c of (author?.email || name)) h = (h * 31 + c.charCodeAt(0)) % 360
  return { initials, hue: h }
}
