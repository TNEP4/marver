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
  connected: boolean                  // dev only: a connect account provides name/email (read-only here)
  commentMode: boolean                // C - picking + composing
  show: boolean                       // Shift+C - pins visible at all
  active: string | null               // open thread id
  draft: { nodeKey: string; frame: string; anchor: unknown } | null   // picked, composing
  needsIdentity: boolean              // published viewer tried to comment while signed out
  inviteToken: string | null          // arrived via an invite link - claim flow, token known

  load(board: string): Promise<void>
  live(board: string): () => void
  /** Fetch the active board's log NOW (Live Jam: the daemon just wrote a reply) - same union path
   *  as the poll, so dedup + the reply notification behave identically. */
  poke(board?: string): void
  send(events: CommentEvent[]): Promise<boolean>
  create(body: string): Promise<void>
  reply(threadId: string, body: string): Promise<void>
  replyOk(threadId: string, body: string): Promise<boolean>
  resolve(threadId: string, reopen?: boolean): Promise<void>
  setMode(on: boolean): void
  setShow(show: boolean): void
  setActive(id: string | null): void
  setDraft(d: CommentsState['draft']): void
  signIn(email: string, password: string): Promise<string | null>
  claim(token: string, password: string, name: string, avatar?: string): Promise<string | null>
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
  // Live Jam (SPEC §9): a Marver reply that arrives AFTER the initial load (load() baselines via
  // derive, so pre-existing replies never notify) raises a persistent bottom-right pill. Keyed on
  // the event id via `union`'s fresh filter, so it fires exactly once; active-board only by
  // construction (union runs against the active board's poll).
  const notifyAgent = (fresh: CommentEvent[]) => {
    const replies = fresh.filter((e) => e.agent && e.type === 'reply')
    if (!replies.length) return
    void import('./store.ts').then(({ useStore }) => {
      const board = get().board ?? ''
      const s = useStore.getState()
      for (const e of replies) {
        const threadId = e.parentId ?? e.commentId ?? ''
        // the FRAME is the news: resolve the reply's thread -> frame -> manifest title + intent
        const frame = get().threads.find((t) => t.id === threadId)?.frame
        const entry = frame ? s.manifest?.frames.find((f) => f.id === frame) : undefined
        s.jamToast({
          threadId, board, ts: e.ts,
          preview: (e.body ?? '').replace(/\s+/g, ' ').slice(0, 90),
          frame, frameTitle: entry?.title ?? frame, intent: entry?.intent,
        })
      }
    })
  }
  const union = (events: CommentEvent[]) => {
    const have = new Set(get().events.map((e) => e.id))
    const fresh = events.filter((e) => !have.has(e.id))
    if (fresh.length) { set(derive([...get().events, ...fresh])); notifyAgent(fresh) }
  }

  return {
    events: [], threads: [], board: null, me: null, local: false, connected: false,
    commentMode: false, show: true, active: null, draft: null, needsIdentity: false, inviteToken: null,

    poke(board) {
      const b = get().board
      if (!b || (board && board !== b)) return   // only the active board renders; others load on switch
      void api(`comments/${b}`).then((r) => { if (r.ok && get().board === b) union(r.data.events ?? []) })
    },

    async load(board) {
      set({ board })
      const me = await api('me')
      if (me.ok) set({ me: me.data.user ?? null, local: !!me.data.local, connected: !!me.data.connected })
      const res = await api(`comments/${board}`)
      if (res.ok && get().board === board) set(derive(res.data.events ?? []))
    },

    /** Liveness: SSE on the published serve; dev has no event rail (its sync loop
     *  writes files) so it polls only - an EventSource there would 404-retry forever. */
    live(board) {
      const stops: (() => void)[] = []
      let es: EventSource | null = null
      const wantSSE = () => {
        if (es || get().local) return
        es = new EventSource(`${ROUTE}/api/events`)
        es.addEventListener('comment', (e) => {
          try {
            const { board: b, ev } = JSON.parse((e as MessageEvent).data)
            if (b === get().board) union([ev])
          } catch { /* ignore */ }
        })
        es.addEventListener('resync', () => { void get().load(board) })
        es.onerror = () => { /* EventSource retries itself; the poll covers the gap */ }
      }
      // `local` is only known once load() has answered - defer the SSE decision past it
      const t = setTimeout(wantSSE, 1500)
      stops.push(() => { clearTimeout(t); es?.close() })
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
      const res = await api(`comments/${board}`, { events })
      if (res.status === 401) { set({ needsIdentity: true }); return false }
      // any other refusal gets said out loud - a silent dead Enter key reads as a bug
      // (the canonical case: a signed-in viewer on a read-only board)
      if (!res.ok) {
        const { useStore } = await import('./store.ts')
        useStore.getState().toast(String((res.data as any)?.error ?? 'comment rejected'))
      }
      // union only what the server took - a rejected send must not leave phantoms -
      // and only if the user is still LOOKING at that board (a slow response after a
      // board switch must not leak events into the wrong client state); client ids
      // keep the eventual SSE/poll echo idempotent either way
      if (res.ok && get().board === board) union(events)
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

    async reply(threadId, body) { await get().replyOk(threadId, body) },
    async replyOk(threadId, body) {
      if (!body.trim()) return false
      return get().send([{
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
    dismissIdentity() { set({ needsIdentity: false }) },   // inviteToken survives dismissal - commenting later reopens the claim

    async signIn(email, password) {
      const res = await api('auth/signin', { email, password })
      if (!res.ok) return res.data?.error ?? 'sign-in failed'
      set({ me: res.data.user, needsIdentity: false })
      return null
    },
    async claim(token, password, name, avatar) {
      const res = await api('auth/claim', { token, password, name, avatar })
      if (!res.ok) return res.data?.error ?? 'claim failed'
      set({ me: res.data.user, needsIdentity: false, inviteToken: null })
      return null
    },
    async saveProfile(patch) {
      const res = await api('profile', patch)
      if (res.ok) set({ me: res.data.user })
    },
  }
})

// dev-only debug handle - the canvas store exposes the same
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__mvComments = useComments

/** Initials + deterministic hue for avatarless authors - the whole fallback ladder. */
export const avatarFallback = (author?: { email?: string; name?: string }) => {
  const name = author?.name || author?.email || '?'
  // the unset dev default ("You", no account) renders in the COMMENT green - it's the mode's
  // own hue, not a fake identity color, until a real profile is set
  if (name === 'You' && !author?.email) return { initials: 'Y', hue: 131 }
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  let h = 0
  for (const c of (author?.email || name)) h = (h * 31 + c.charCodeAt(0)) % 360
  return { initials, hue: h }
}
