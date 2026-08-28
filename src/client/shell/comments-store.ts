/**
 * Comment state for the shell - its own small store beside the canvas
 * store. One API client for both worlds: `marver dev` (api.ts mirror, local profile,
 * poll) and the published serve (collab.ts, sessions, SSE). The shell never branches
 * on which one it is beyond capability flags the endpoints themselves report.
 */
import { create } from 'zustand'
import { replay, type CommentEvent, type Thread } from '../../shared/events.ts'
import { ROUTE } from '../const.ts'

export interface Me {
  email: string
  name: string
  avatar?: string
  /** The viewer's own opaque author id on a published canvas - what projected
   *  events carry instead of an email. "Is this mine" compares ids first. */
  id?: string
}

/** The author snapshot a POST carries: the canonical profile, never the opaque
 *  id - that field is server-assigned, and the server refuses it in writes. */
const postAuthor = (me: Me | null): { email: string; name?: string; avatar?: string } | undefined =>
  me ? { email: me.email, name: me.name, ...(me.avatar ? { avatar: me.avatar } : {}) } : undefined

interface CommentsState {
  events: CommentEvent[]              // EVERY board's log, unioned - comments are frame-scoped
  threads: Thread[]                   // derived on every change; each carries its origin board
  board: string | null
  me: Me | null                       // null on published until signed in
  local: boolean                      // dev mirror (identity is the local profile)
  connected: boolean                  // dev only: a connect account provides name/email (read-only here)
  commentMode: boolean                // C - picking + composing
  show: boolean                       // Shift+C - pins visible at all
  showAnchor: boolean                 // Shift+L - light the tagged ELEMENT while its thread is open
  active: string | null               // open thread id
  // picked, composing. `board` is captured at pick time - the write must land in the
  // log of the board the user was LOOKING at, however long the composer stays open
  draft: { nodeKey: string; frame: string; anchor: unknown; board?: string } | null
  needsIdentity: boolean              // published viewer tried to comment while signed out
  inviteToken: string | null          // arrived via an invite link - claim flow, token known

  load(board: string): Promise<void>
  live(board: string): () => void
  /** Fetch a board's log NOW (Live Jam: the daemon just wrote a reply THERE) - same union
   *  path as the poll, so dedup + the reply notification behave identically. ANY board:
   *  notifications must reach the user wherever they are on the canvas. */
  poke(board?: string): void
  /** `board` routes the write to a thread's ORIGIN log; default = the active board. */
  send(events: CommentEvent[], board?: string): Promise<boolean>
  create(body: string): Promise<void>
  reply(threadId: string, body: string): Promise<void>
  replyOk(threadId: string, body: string): Promise<boolean>
  resolve(threadId: string, reopen?: boolean): Promise<void>
  setMode(on: boolean): void
  setShow(show: boolean): void
  setShowAnchor(on: boolean): void
  setActive(id: string | null): void
  setDraft(d: CommentsState['draft']): void
  signIn(email: string, password: string): Promise<string | null>
  claim(token: string, password: string, name: string, avatar?: string): Promise<string | null>
  saveProfile(patch: Partial<Me>): Promise<string | null>
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
  // replay PER BOARD, then concatenate: replay keys threads by commentId alone, so a
  // (copied, malicious, or just colliding) id in two logs must not merge across boards
  const derive = (events: CommentEvent[]) => {
    const byBoard = new Map<string, CommentEvent[]>()
    for (const e of events) {
      const k = e.board ?? ''
      const arr = byBoard.get(k) ?? []
      arr.push(e)
      byBoard.set(k, arr)
    }
    return { events, threads: [...byBoard.values()].flatMap((evs) => replay(evs)) }
  }
  // a static 0.8.1 serve answers every /api/* with 404 - comments simply do not exist
  // there. Latch off after detection so N boards are not swept into 404s every 30s.
  let apiOff = false
  // the boot instant: an event younger than the page can never be "history", so it may
  // notify even before its board's baseline sweep lands (the poke/SSE-beats-load race)
  const bootTs = Date.now()
  // Live Jam: a Marver reply that arrives AFTER the baseline raises a persistent
  // bottom-right pill - from ANY board (the store holds every log), keyed on the event id
  // via `union`'s fresh filter so it fires exactly once. The pill's board is the THREAD's
  // origin board, so View can navigate there.
  const notifyAgent = (fresh: CommentEvent[]) => {
    const replies = fresh.filter((e) => e.agent && e.type === 'reply')
    if (!replies.length) return
    void import('./store.ts').then(({ useStore }) => {
      const s = useStore.getState()
      for (const e of replies) {
        const threadId = e.parentId ?? e.commentId ?? ''
        // the FRAME is the news: resolve the reply's thread -> frame -> manifest title + intent
        const t = get().threads.find((t) => t.id === threadId)
        const entry = t?.frame ? s.manifest?.frames.find((f) => f.id === t.frame) : undefined
        s.jamToast({
          threadId, board: t?.board ?? e.board ?? get().board ?? '', ts: e.ts,
          preview: (e.body ?? '').replace(/\s+/g, ' ').slice(0, 90),
          frame: t?.frame, frameTitle: entry?.title ?? t?.frame, intent: entry?.intent,
        })
      }
    })
  }
  // events are append-only everywhere, so union is ALWAYS safe - the one rule is the
  // baseline, PER BOARD: a board's first successful read must never replay its history
  // as notifications (the switcher list can arrive after the first sweep, so a global
  // flag would announce a late board's whole past as news)
  const baselinedBoards = new Set<string>()
  // dedup by (board, id): the same id in two DIFFERENT logs is two events, never one
  const key = (e: CommentEvent) => `${e.board ?? ''}|${e.id}`
  const union = (events: CommentEvent[]) => {
    const have = new Set(get().events.map(key))
    // dedupe within the batch too - a union-merged log can carry a duplicated line
    const fresh = events.filter((e) => !have.has(key(e)) && (have.add(key(e)), true))
    if (!fresh.length) return
    set(derive([...get().events, ...fresh]))
    notifyAgent(fresh.filter((e) => (e.board && baselinedBoards.has(e.board)) || e.ts > bootTs))
  }
  /** Legacy logs (0.8.0 clients never sent `board`) get it from the endpoint they came
   *  from - without it, replies to their threads would route to whatever board is open. */
  const stamped = (events: CommentEvent[] | undefined, board: string): CommentEvent[] =>
    (events ?? []).map((e) => (e.board ? e : { ...e, board }))
  /** Every board that could hold a log: the switcher list plus the active board -
   *  the sum of what this client can navigate to. Transport failure = just the
   *  active board; the next sweep widens again. */
  const watchNames = async (): Promise<string[]> => {
    const names = new Set<string>()
    try {
      const { fetchBoardNames } = await import('./store.ts')
      for (const n of await fetchBoardNames()) names.add(n)
    } catch { /* keep what we have */ }
    const b = get().board
    if (b) names.add(b)
    return [...names]
  }
  /** One sweep across every board's log - the notification feed and the frame-scoped
   *  thread state are the same fetch. Boards baseline AFTER their events land. */
  const fetchAll = async () => {
    if (apiOff) return
    const names = await watchNames()
    const results = await Promise.all(names.map((n) =>
      api(`comments/${n}`).then((r) => (r.ok ? stamped(r.data.events as CommentEvent[] | undefined, n) : null))))
    union(results.flatMap((evs) => evs ?? []))
    names.forEach((n, i) => { if (results[i] !== null) baselinedBoards.add(n) })
  }

  return {
    events: [], threads: [], board: null, me: null, local: false, connected: false,
    commentMode: false, show: true, showAnchor: true, active: null, draft: null, needsIdentity: false, inviteToken: null,

    poke(board) {
      const b = board ?? get().board
      if (!b || apiOff) return
      void api(`comments/${b}`).then((r) => {
        if (!r.ok) return
        union(stamped(r.data.events, b))   // brand-new events still notify via the bootTs rule
        baselinedBoards.add(b)
      })
    },

    async load(board) {
      // threads are frame-scoped and global - a board switch keeps them all (the same
      // frame on another board keeps its pins); only the open card and a draft reset
      if (get().board !== board) set({ board, active: null, draft: null })
      else set({ board })
      const me = await api('me')
      if (me.status === 404) { apiOff = true; return }   // static serve: no comments API at all
      if (me.ok) set({
        me: me.data.user ? { ...me.data.user, ...(me.data.id ? { id: me.data.id } : {}) } : null,
        local: !!me.data.local, connected: !!me.data.connected,
      })
      await fetchAll()
      // mark-seen: the board was actually PRESENTED (load runs on open, never
      // from the background poll), so the viewer's unread mark advances - the
      // front door's counter moves on this and nothing else (02-home §4)
      if (!get().local && get().me) void api('seen', { board }).catch(() => {})
    },

    /** Liveness: SSE on the published serve; dev has no event rail (its sync loop
     *  writes files) so it polls only - an EventSource there would 404-retry forever. */
    live(board) {
      const stops: (() => void)[] = []
      let es: EventSource | null = null
      const wantSSE = () => {
        if (es || get().local || apiOff) return
        es = new EventSource(`${ROUTE}/api/events`)
        es.addEventListener('comment', (e) => {
          try {
            const { board: b, ev } = JSON.parse((e as MessageEvent).data)
            // every board: notifications reach the viewer anywhere (envelope names the log)
            union(stamped([ev], typeof b === 'string' ? b : ''))
          } catch { /* ignore */ }
        })
        es.addEventListener('resync', () => { void get().load(board) })
        es.onerror = () => { /* EventSource retries itself; the poll covers the gap */ }
      }
      // `local` is only known once load() has answered - defer the SSE decision past it
      const t = setTimeout(wantSSE, 1500)
      stops.push(() => { clearTimeout(t); es?.close() })
      const poll = () => { if (get().board === board) void fetchAll() }
      const iv = setInterval(poll, 30_000)
      const onFocus = () => poll()
      window.addEventListener('focus', onFocus)
      stops.push(() => { clearInterval(iv); window.removeEventListener('focus', onFocus) })
      return () => stops.forEach((f) => f())
    },

    async send(events, board) {
      const target = board ?? get().board
      if (!target) return false
      // stamp the origin board BEFORE the POST: the dev server fills it at origin, but
      // the published server stores events as sent - an unstamped event would come back
      // board-less on the next load and its replies could then route to the wrong log.
      // Stamping client-side keeps the stored bytes and the optimistic copy identical.
      const stamped = events.map((e) => ({ ...e, board: e.board ?? target }))
      const res = await api(`comments/${target}`, { events: stamped })
      if (res.status === 401) { set({ needsIdentity: true }); return false }
      // any other refusal gets said out loud - a silent dead Enter key reads as a bug
      // (the canonical case: a signed-in viewer on a read-only board)
      if (!res.ok) {
        const { useStore } = await import('./store.ts')
        useStore.getState().toast(String((res.data as any)?.error ?? 'comment rejected'))
      }
      // union only what the server took - a rejected send must not leave phantoms; the
      // store is global now, so an accepted write lands regardless of the viewed board
      // (client ids keep the eventual SSE/poll echo idempotent)
      if (res.ok) union(stamped)
      return res.ok
    },

    async create(body) {
      const { draft, me } = get()
      if (!draft || !body.trim()) return
      const id = uuid()
      const ok = await get().send([{
        id: uuid(), ts: Date.now(), type: 'create', commentId: id,
        nodeKey: draft.nodeKey, frame: draft.frame, anchor: draft.anchor,
        author: postAuthor(me), body: body.trim(),
      }], draft.board)
      if (ok) set({ draft: null, active: id, commentMode: false })
    },

    async reply(threadId, body) { await get().replyOk(threadId, body) },
    async replyOk(threadId, body) {
      if (!body.trim()) return false
      // route to the thread's ORIGIN log - the viewer may be reading it from another
      // board (frame-scoped display); a reply landing in the wrong log would fork it
      const origin = get().threads.find((t) => t.id === threadId)?.board
      return get().send([{
        id: uuid(), ts: Date.now(), type: 'reply', commentId: uuid(), parentId: threadId,
        author: postAuthor(get().me), body: body.trim(),
      }], origin)
    },

    async resolve(threadId, reopen = false) {
      const origin = get().threads.find((t) => t.id === threadId)?.board
      await get().send([{ id: uuid(), ts: Date.now(), type: reopen ? 'reopen' : 'resolve', commentId: threadId }], origin)
    },

    setMode(on) { set({ commentMode: on, ...(on ? { show: true } : { draft: null }) }) },
    setShow(show) { set({ show }) },
    setShowAnchor(showAnchor) { set({ showAnchor }) },
    setActive(active) { set({ active }) },
    setDraft(draft) { set({ draft: draft ? { ...draft, board: draft.board ?? get().board ?? undefined } : null }) },
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
      if (!res.ok) return res.data?.error ?? 'could not save - try again'
      set({ me: res.data.user })
      return null
    },
  }
})

// dev-only debug handle - the canvas store exposes the same
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) (window as any).__mvComments = useComments

/** Initials + deterministic hue for avatarless authors - the whole fallback ladder.
 *  Hue keys on the stable identity: email locally, the opaque id when projected. */
export const avatarFallback = (author?: { email?: string; id?: string; name?: string }) => {
  const name = author?.name || author?.email || '?'
  // the unset dev default ("You", no account) renders in the COMMENT green - it's the mode's
  // own hue, not a fake identity color, until a real profile is set
  if (name === 'You' && !author?.email && !author?.id) return { initials: 'Y', hue: 131 }
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  let h = 0
  for (const c of (author?.email || author?.id || name)) h = (h * 31 + c.charCodeAt(0)) % 360
  return { initials, hue: h }
}
