/**
 * Comment state for the shell - its own small store beside the canvas
 * store. One API client for both worlds: `marver dev` (api.ts mirror, local profile,
 * poll) and the published serve (collab.ts, sessions, SSE). The shell never branches
 * on which one it is beyond capability flags the endpoints themselves report.
 */
import { create } from 'zustand'
import { asks, asSentBy, replay, type CommentEvent, type Thread } from '../../shared/events.ts'
import { mentionPeople, mentionsIn } from './mentions.ts'
import { playPing } from './sound.ts'
import { ROUTE } from '../const.ts'
import { ALL_SCENES } from '../../shared/board-tree.ts'
import { UNPLACED } from './hash.ts'
import { api as request, canvasStopped, scoped, stoppedLink, useLink } from './api.ts'
import type { CmdHandle } from './commands.ts'
import { hasDraftWords } from './drafts.ts'

/** What the Not on a board view says when asked for a comment: a note needs a board to live on. */
export const NO_COMMENTS_HERE = 'pin it on a board to comment'

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
  /** The viewer's effective role per board (published) - what makes a locked
   *  capability honest: `view` on a comment board = "not available for you YET". */
  myBoards: Record<string, string> | null
  local: boolean                      // dev mirror (identity is the local profile)
  connected: boolean                  // dev only: a connect account provides name/email (read-only here)
  commentMode: boolean                // C - picking + composing
  show: boolean                       // Shift+C - pins visible at all
  showAnchor: boolean                 // Shift+L - light the tagged ELEMENT while its thread is open
  active: string | null               // open thread id
  /** threadId -> when I last opened it; feeds the mention-alert pulse. This
   *  browser only (localStorage) - a per-person server mark is v1.2 territory. */
  mentionSeen: Record<string, number>
  // picked, composing. `board` is captured at pick time - the write must land in the
  // log of the board the user was LOOKING at, however long the composer stays open
  draft: { nodeKey: string; frame: string; anchor: unknown; board?: string } | null
  needsIdentity: boolean              // published viewer tried to comment while signed out
  inviteToken: string | null          // arrived via an invite link - claim flow, token known
  /** dev (spec 31 C.2): the messages this machine's human wrote, per board - the server's record (own.json), never
   *  the email. null until read (or on a published canvas, where the opaque author id decides) */
  ownership: Record<string, Set<string>> | null
  /** what the server's comment API takes (spec 31 C.6): an older published server has no `delete` - the shell hides it */
  caps: { delete: boolean }
  /** Spec 36: every write not yet stored by the server - kept in this browser until it is, shown where it will be. */
  pending: Pending[]
  /** Spec 36: the server said this viewer's session is gone (a 401) - set until a request proves it is back. */
  signedOut: boolean
  /** How this canvas lets a person back in, as the server says: Marver ID or a password (null: dev, or not told yet). */
  signInMode: 'marver-id' | 'password' | null
  /** Take the signed-out viewer back in: Marver ID through its own pages (nothing is lost - the outbox is on disk), a
   *  password canvas through the dialog, a guest through the gate. */
  signInAgain(): void
  /** Send what waits now (after a sign-in, back online, a Retry). */
  flush(): Promise<void>
  /** Try a refused write again, or let it go - the only way a person's words leave the outbox unsent. */
  retry(key: string): void
  discard(key: string): void

  load(board: string): Promise<void>
  live(board: string): () => void
  /** Fetch a board's log NOW (Live Jam: the daemon just wrote a reply THERE) - same union
   *  path as the poll, so dedup + the reply notification behave identically. ANY board:
   *  notifications must reach the user wherever they are on the canvas. */
  poke(board?: string): void
  /** Read a board's log now and answer whether the read succeeded (spec 28 A4.6 #30): `poke`'s read, awaited, its
   *  events merged - the board, the open thread and a draft stay as they are (never `load`, which clears them first). */
  refresh(board: string): Promise<boolean>
  /** A thread by id, from any board's log - one sweep first when it is not loaded yet. */
  findThread(id: string): Promise<Thread | null>
  /** `board` routes the write to a thread's ORIGIN log; default = the active board. `h` (spec 30): the command behind the
   *  write, ended here on its answer - `done`, `failed signed-out` on a 401, else `failed send-failed`. */
  send(events: CommentEvent[], board?: string, h?: CmdHandle): Promise<boolean>
  create(body: string, h?: CmdHandle): Promise<void>
  reply(threadId: string, body: string): Promise<void>
  replyOk(threadId: string, body: string, h?: CmdHandle): Promise<boolean>
  resolve(threadId: string, reopen?: boolean, h?: CmdHandle): Promise<void>
  /** Is this message mine to edit or delete (spec 31 C.2)? Never an agent's; locally the server's record decides, on a
   *  published canvas the original message's opaque author id against /me's. */
  isMine(board: string | undefined, msg: { id: string; author?: { id?: string }; agent?: boolean }): boolean
  /** Edit one of my messages (spec 31 C.3): an `edit` event with the new words, to the thread's own log. */
  edit(threadId: string, msgId: string, body: string, h?: CmdHandle): Promise<boolean>
  /** Delete one of my messages (spec 31 C.4): a `delete` tombstone, to the thread's own log. */
  remove(threadId: string, msgId: string, h?: CmdHandle): Promise<boolean>
  /** One sweep of every board's log now (after a resolve-all or its Undo). */
  sweep(): Promise<void>
  setMode(on: boolean): void
  setShow(show: boolean): void
  setShowAnchor(on: boolean): void
  setActive(id: string | null): void
  setDraft(d: CommentsState['draft']): void
  signIn(email: string, password: string, h?: CmdHandle): Promise<string | null>
  claim(token: string, password: string, name: string, avatar?: string, h?: CmdHandle): Promise<string | null>
  saveProfile(patch: Partial<Me>, h?: CmdHandle): Promise<string | null>
  dismissIdentity(): void
  /** The admitted viewer's "Ask to comment" - one request into the owner's queue. */
  askToComment(): Promise<boolean>
}

const uuid = () => crypto.randomUUID()
const loadMentionSeen = (): Record<string, number> => {
  try { return JSON.parse(localStorage.getItem(scoped('mv-mention-seen')) ?? '{}') } catch { return {} }
}
const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''
/** One call to the comment API. Only JSON is an answer (spec 36): a page - an old server's sign-in page with its 200,
 *  a proxy's error page - or a body that will not parse is status 0, never `ok`. That 200 page once made a reviewer's
 *  comments look sent (#31). A write that has no answer in 20 s is abandoned (thrown) - the outbox sends it again. */
const api = async (path: string, body?: unknown) => {
  const res = await request(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  const data = /json/.test(res.headers.get('content-type') ?? '') ? await res.json().catch(() => null) : null
  return { ok: res.ok && data !== null, status: data === null && res.ok ? 0 : res.status, data: (data ?? {}) as any }
}

/** A write the server has not stored yet (spec 36 §3): its events exactly as they will be posted, the board's log it
 *  goes to, and the account that wrote it - it is sent only while that account is signed in. `refused`: the server
 *  said no and saying it again will not change that - kept, with the reason, until the person retries or lets it go. */
export interface Pending { key: string; board: string; events: CommentEvent[]; account: string; refused?: string }
/** The outbox lives in localStorage, per canvas: it survives a reload, a closed tab, a crash, and the sign-in pages a
 *  Marver ID canvas sends the tab through. Storage that throws (a private window) leaves it in this page alone. */
const OUTBOX = () => scoped('mv-outbox')
const readOutbox = (): Pending[] | null => {
  try {
    const v = JSON.parse(localStorage.getItem(OUTBOX()) ?? '[]')
    return Array.isArray(v) ? v.filter((p) => p && typeof p.key === 'string' && typeof p.board === 'string' && Array.isArray(p.events)) : []
  } catch { return null }
}
const writeOutbox = (list: Pending[]): boolean => {
  try { if (list.length) localStorage.setItem(OUTBOX(), JSON.stringify(list)); else localStorage.removeItem(OUTBOX()); return true }
  catch { return false }
}
const sameAccount = (a: string, b?: string) => !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
/** The server's clock less this browser's (from /me, spec 36): events are stamped on the server's time, so a reviewer
 *  whose clock runs fast is not refused ("timestamp out of bounds") on every write. */
let skew = 0
const now = () => Date.now() + skew
/** Set while the tab leaves on purpose (to sign in): the leave-page question is for leaving by accident. */
let leaving = false
/** An identity write and the command behind it (spec 30's `sign-in`, `claim`, `profile-save`): ok → done, the answer
 *  said no → `rejected`, no answer → `api`. */
const identityWrite = async (path: string, body: unknown, h?: CmdHandle) => {
  try {
    const res = await api(path, body)
    if (res.ok) h?.done(); else h?.fail(res.status < 500 ? 'rejected' : 'api')
    return res
  } catch (e) { h?.fail('api'); throw e }
}

export const useComments = create<CommentsState>((set, get) => {
  // replay PER BOARD, then concatenate: replay keys threads by commentId alone, so a
  // (copied, malicious, or just colliding) id in two logs must not merge across boards
  const derive = (events: CommentEvent[], pending: Pending[] = get()?.pending ?? []) => {
    const byBoard = new Map<string, CommentEvent[]>()
    // what waits in the outbox shows where it will be (spec 36): as mine, beside what is stored - never twice
    const stored = new Set(events.map((e) => `${e.board ?? ''}|${e.id}`))
    const waiting = pending.flatMap((p) => asSentBy(p.events, get()?.me?.id)).filter((e) => !stored.has(`${e.board ?? ''}|${e.id}`))
    for (const e of [...events, ...waiting]) {
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
  // Marver - a Live Jam reply, or a note or reply an agent left from the CLI - that ASKS, arriving
  // AFTER the baseline, raises a persistent bottom-right pill - from ANY board (the store holds
  // every log), keyed on the event id via `union`'s fresh filter so it fires exactly once. The
  // pill's board is the THREAD's origin board, so View can navigate there. One ping per batch. A
  // reply that does not ask raises nothing (spec 27): it is read in its thread. A jam job whose
  // final block asks what its opening line already said re-flags that line (an edit carrying
  // `asks`): the question gets its notice.
  const notifyAgent = (fresh: CommentEvent[]) => {
    const news = fresh.flatMap((e) => {
      if (!e.agent) return []
      if (e.type === 'reply' || e.type === 'create') return [{ e, threadId: e.parentId ?? e.commentId ?? '', body: e.body, ask: asks(e, e.type === 'create') }]
      if (e.type !== 'edit' || e.asks !== true) return []
      const t = get().threads.find((t) => t.id === e.commentId || t.replies.some((r) => r.id === e.commentId))
      return t ? [{ e, threadId: t.id, body: (t.id === e.commentId ? t : t.replies.find((r) => r.id === e.commentId))?.body, ask: true }] : []
    })
    // only a question interrupts (spec 27): a reply that says it is done is read in its thread, and
    // the sidebar marks its frame - no notice, no ping
    // one notice per batch: a jam job's questions (`jam-<batch>-m<n>`) fold into one, the rest under it
    const questions = news.filter((n) => n.ask)
    if (!questions.length) return
    const groups = new Map<string, typeof questions>()
    for (const n of questions) { const k = /^jam-(.+)-m\d+$/.exec(n.e.id)?.[1] ?? n.e.id; groups.set(k, [...(groups.get(k) ?? []), n]) }
    const asking = [...groups].map(([batch, g]) => ({ ...g[g.length - 1], batch, rest: g.slice(0, -1) }))
    void import('./store.ts').then(({ useStore }) => {
      const s = useStore.getState()
      // a batch whose notice is already up folds in quietly: one ping per batch, like one notice
      if (asking.some((n) => !s.toasts.some((t) => t.jam?.batch === n.batch))) playPing()
      // the FRAME is the news: resolve the reply's thread -> frame -> manifest title + intent
      const noteOf = ({ e, threadId, body }: { e: CommentEvent; threadId: string; body?: string }) => {
        const t = get().threads.find((t) => t.id === threadId)
        const entry = t?.frame ? s.manifest?.frames.find((f) => f.id === t.frame) : undefined
        return {
          threadId, board: t?.board ?? e.board ?? get().board ?? '', ts: e.ts,
          preview: (body ?? '').replace(/\s+/g, ' ').slice(0, 90),
          frame: t?.frame, frameTitle: entry?.title ?? t?.frame, intent: entry?.intent,
        }
      }
      // a batch's other questions ride under its notice - View walks through them
      for (const n of asking) s.jamToast({ ...noteOf(n), batch: n.batch, ...(n.rest.length ? { stack: n.rest.map((r) => ({ ...noteOf(r), batch: n.batch })) } : {}) })
    })
  }
  // A HUMAN's fresh comment that concerns me raises the same pill the agent
  // gets, person-first: a mention of me anywhere, or a reply in a thread I am
  // part of. Same freshness rules as notifyAgent; one ping per batch, not per
  // event - a burst must not become a drum roll.
  const notifyHuman = (fresh: CommentEvent[]) => {
    const me = get().me
    if (!me) return
    const isMe = (a?: { id?: string; email?: string }) =>
      !!a && ((!!a.id && a.id === me.id) || (!!a.email && !!me.email && a.email.toLowerCase() === me.email.toLowerCase()))
    const news = fresh.filter((e) => !e.agent && (e.type === 'create' || e.type === 'reply') && e.author && !isMe(e.author))
    if (!news.length) return
    const notes: { e: CommentEvent; kind: 'mention' | 'reply' }[] = []
    for (const e of news) {
      if ((e.mentions ?? []).some((m) => isMe(m))) { notes.push({ e, kind: 'mention' }); continue }
      if (e.type !== 'reply' || !e.parentId) continue
      const t = get().threads.find((t) => t.id === e.parentId)
      const mine = !!t && (isMe(t.author) || t.replies.some((r) => r.id !== e.commentId && isMe(r.author)))
      if (mine) notes.push({ e, kind: 'reply' })
    }
    if (!notes.length) return
    playPing()
    void import('./store.ts').then(({ useStore }) => {
      const s = useStore.getState()
      for (const { e, kind } of notes) {
        const threadId = e.type === 'reply' ? e.parentId! : e.commentId!
        const t = get().threads.find((t) => t.id === threadId)
        const entry = t?.frame ? s.manifest?.frames.find((f) => f.id === t.frame) : undefined
        s.jamToast({
          threadId, board: t?.board ?? e.board ?? get().board ?? '', ts: e.ts, kind, author: e.author,
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
    const news = fresh.filter((e) => (e.board && baselinedBoards.has(e.board)) || e.ts > bootTs)
    notifyAgent(news)
    notifyHuman(news)
  }
  /** Legacy logs (0.8.0 clients never sent `board`) get it from the endpoint they came
   *  from - without it, replies to their threads would route to whatever board is open. */
  const stamped = (events: CommentEvent[] | undefined, board: string): CommentEvent[] =>
    (events ?? []).map((e) => (e.board ? e : { ...e, board }))
  /** Every board that could hold a log: the switcher list plus the active board -
   *  the sum of what this client can navigate to - and the old all-scenes log, whose threads
   *  outlive their board (spec 26) until a published canvas says it has none. Transport
   *  failure = just the active board; the next sweep widens again. */
  let allScenesOff = false
  const watchNames = async (): Promise<string[]> => {
    const names = new Set<string>(allScenesOff ? [] : [ALL_SCENES])
    try {
      const { fetchBoardNames } = await import('./store.ts')
      for (const n of await fetchBoardNames()) names.add(n)
    } catch { /* keep what we have */ }
    const b = get().board
    if (b && b !== UNPLACED) names.add(b)
    return [...names]
  }
  /** One sweep across every board's log - the notification feed and the frame-scoped
   *  thread state are the same fetch. Boards baseline AFTER their events land. */
  const fetchAll = async () => {
    if (apiOff) return
    const names = await watchNames()
    const results = await Promise.all(names.map((n) =>
      api(`comments/${n}`).then((r) => {
        if (n === ALL_SCENES && r.status === 404) allScenesOff = true   // a canvas published before 0.25 serves none
        heard(r)
        return r.ok ? stamped(r.data.events as CommentEvent[] | undefined, n) : null
      }, () => null)))
    union(results.flatMap((evs) => evs ?? []))
    names.forEach((n, i) => { if (results[i] !== null) baselinedBoards.add(n) })
    if (get().local) await readOwnership()
  }
  /** dev: the messages this machine's human wrote (spec 31 C.2) - read with each sweep; a 404 (an older server) leaves
   *  none mine, so nothing offers an edit the server would refuse */
  const readOwnership = async () => {
    try {
      const r = await request('comment-ownership', { headers: { 'x-mv-c': csrf() } })
      if (!r.ok) return
      const b = await r.json() as { boards?: Record<string, string[]> }
      // (no prototype: a board may be called `constructor`)
      const next: Record<string, Set<string>> = Object.create(null)
      for (const [k, ids] of Object.entries(b.boards ?? {})) if (Array.isArray(ids)) next[k] = new Set(ids)
      // what this page wrote since stays mine (its sweep may have read the file a moment before the write)
      for (const [k, ids] of Object.entries(get().ownership ?? {})) for (const id of ids) (Object.hasOwn(next, k) ? next[k] : (next[k] = new Set())).add(id)
      set({ ownership: next })
    } catch { /* the next sweep */ }
  }
  /** The server's capabilities (spec 31 C.6): only a JSON answer that says `delete` counts - an older server's 404 or
   *  gate page is an older server. */
  const readCaps = async () => {
    try {
      const r = await request('capabilities')
      const b = r.ok && (r.headers.get('content-type') ?? '').includes('application/json') ? await r.json() as { delete?: unknown } : null
      set({ caps: { delete: b?.delete === true } })
    } catch { /* keep what we have */ }
  }

  /** What every answer says about the session (spec 36 §4): a 401 is signed out, said at once - by the poll, the live
   *  stream, a send - so a reviewer learns it before writing, not after. Only /me or a stored write says it is back. */
  const heard = (r: { status: number; data: any }) => {
    if (r.status !== 401 || get().local) return
    const mode = r.data?.signIn === 'marver-id' || r.data?.signIn === 'password' ? r.data.signIn : get().signInMode
    if (!get().signedOut || mode !== get().signInMode) set({ signedOut: true, signInMode: mode ?? 'password' })
  }
  /** Change the outbox: read what storage holds (another tab of this canvas may have changed it), apply, write back. */
  const mutate = (fn: (list: Pending[]) => Pending[]) => {
    const next = fn(readOutbox() ?? get().pending)
    writeOutbox(next)
    set({ pending: next, ...derive(get().events, next) })
  }
  /** Post one waiting write. `stored`: the server took it (JSON `accepted` - a resend it already holds answers 0, which
   *  is stored too: ids are idempotent). `wait`: signed out, down, a page, no answer - kept, sent again. `refused`: a
   *  4xx that saying it again will not change - kept with its reason. */
  const post = async (p: Pending): Promise<'stored' | 'wait' | 'refused'> => {
    let r: Awaited<ReturnType<typeof api>>
    try { r = await api(`comments/${p.board}`, { events: p.events }) } catch { return 'wait' }
    heard(r)
    if (r.ok && typeof r.data?.accepted === 'number') {
      union(asSentBy(p.events, get().me?.id))   // stored first, then out of the outbox: the message never blinks
      mutate((list) => list.filter((x) => x.key !== p.key))
      if (get().signedOut) set({ signedOut: false })
      return 'stored'
    }
    if (r.status === 403 && r.data?.code === 'csrf') { void api('me').catch(() => {}); return 'wait' }   // /me mends mv_c
    if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 408 && r.status !== 429) {
      const why = String(r.data?.error ?? 'refused')
      mutate((list) => list.map((x) => (x.key === p.key ? { ...x, refused: why } : x)))
      return 'refused'
    }
    return 'wait'
  }
  /** Send what waits, oldest first, for the account signed in now. A `wait` stops the round: the next one comes on the
   *  timer, on focus, on `online`, after a sign-in, at the next load. */
  let flushing = false
  const flush = async () => {
    if (flushing || get().local || apiOff) return
    flushing = true
    try {
      for (const p of readOutbox() ?? get().pending) {
        if (p.refused || !sameAccount(p.account, get().me?.email)) continue
        if (await post(p) === 'wait') break
      }
    } finally { flushing = false }
  }
  /** While anything waits: try again every 10 s - and while signed out, ask /me first, so a sign-in in another tab is
   *  noticed here too. */
  const probe = async () => {
    if (get().local || apiOff || !get().pending.some((p) => !p.refused)) return
    if (get().signedOut) {
      const me = await api('me').catch(() => null)
      if (!me?.ok) return
      adoptMe(me.data)
    }
    await flush()
  }
  /** /me's answer, taken in: who I am, my boards, the server's clock and how this canvas signs people in. */
  const adoptMe = (d: any) => {
    if (typeof d.now === 'number') skew = d.now - Date.now()
    set({
      me: d.user ? { ...d.user, ...(d.id ? { id: d.id } : {}) } : null,
      myBoards: d.boards && typeof d.boards === 'object' ? d.boards : null,
      local: !!d.local, connected: !!d.connected,
      ...(d.signIn === 'marver-id' || d.signIn === 'password' ? { signInMode: d.signIn } : {}),
      ...(d.user ? { signedOut: false } : {}),
    })
  }
  if (typeof window !== 'undefined') {
    setInterval(() => { void probe() }, 10_000)
    window.addEventListener('online', () => { void probe() })
    window.addEventListener('focus', () => { void probe() })
    // another tab of this canvas sent (or kept) something: this one shows the same outbox
    window.addEventListener('storage', (e) => {
      if (e.key !== OUTBOX()) return
      const list = readOutbox()
      if (list) set({ pending: list, ...derive(get().events, list) })
    })
    // a published canvas asks before the tab closes on words not stored (spec 36 §3) - dev has its own guard
    window.addEventListener('beforeunload', (e) => {
      if (leaving || get().local) return
      if (get().pending.length || hasDraftWords()) { e.preventDefault(); e.returnValue = '' }
    })
  }

  return {
    pending: readOutbox() ?? [], signedOut: false, signInMode: null,
    events: [], threads: [], board: null, me: null, myBoards: null, local: false, connected: false,
    mentionSeen: loadMentionSeen(),
    commentMode: false, show: true, showAnchor: true, active: null, draft: null, needsIdentity: false, inviteToken: null,
    ownership: null, caps: { delete: false },

    poke(board) {
      const b = board ?? get().board
      if (!b || apiOff || b === UNPLACED) return
      void api(`comments/${b}`).then((r) => {
        if (!r.ok) return
        union(stamped(r.data.events, b))   // brand-new events still notify via the bootTs rule
        baselinedBoards.add(b)
      })
    },

    async refresh(board) {
      if (!board || apiOff || board === UNPLACED) return false
      try {
        const r = await api(`comments/${board}`)
        if (!r.ok) return false
        union(stamped(r.data.events, board))
        baselinedBoards.add(board)
        return true
      } catch { return false }
    },

    async load(board) {
      // threads are frame-scoped and global - a board switch keeps them all (the same
      // frame on another board keeps its pins); only the open card and a draft reset
      if (get().board !== board) set({ board, active: null, draft: null, ...(board === UNPLACED ? { commentMode: false } : {}) })
      else set({ board })
      // /me is asked again while it has no answer (a redeploy's 502, no network): one bad moment at load must not
      // leave the tab signed out for the whole visit (spec 36 §4)
      let me: Awaited<ReturnType<typeof api>> | null = null
      for (const wait of [0, 2_000, 5_000, 10_000, 20_000]) {
        if (wait) await new Promise((r) => setTimeout(r, wait))
        me = await api('me').catch(() => null)
        if (me && (me.ok || (me.status >= 400 && me.status < 500))) break
      }
      if (!me) return
      if (me.status === 404) { apiOff = true; return }   // static serve: no comments API at all
      if (me.ok) adoptMe(me.data)
      else if (me.status === 401) {
        if (me.data?.signIn === 'marver-id' || me.data?.signIn === 'password') set({ signInMode: me.data.signIn })
        // a guest on a password canvas is signed out by nature; it is NEWS only for someone who was in, or who left
        // words waiting
        if (get().me || get().pending.length) heard(me)
      }
      await readCaps()
      await fetchAll()
      void flush()
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
        // EventSource retries itself - until an answer that is not a stream (a 401 once the session is gone) closes it
        // for good. Then it is opened again in 30 s, so a viewer back in gets live comments again (spec 36 §4).
        es.onerror = () => {
          if (es?.readyState !== EventSource.CLOSED) return
          es = null
          const t = setTimeout(wantSSE, 30_000)
          stops.push(() => clearTimeout(t))
        }
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

    async send(events, board, h) {
      const target = board ?? get().board
      if (!target) { h?.fail('send-failed'); return false }
      // stamp the origin board BEFORE the POST: the dev server fills it at origin, but
      // the published server stores events as sent - an unstamped event would come back
      // board-less on the next load and its replies could then route to the wrong log.
      // Stamping client-side keeps the stored bytes and the optimistic copy identical.
      const stamped = events.map((e) => ({ ...e, board: e.board ?? target }))
      // published (spec 36 §3): into the outbox FIRST, then posted. It is "sent" when the server says it stored it;
      // until then it waits, shown as not sent yet, and goes again by itself. Only a refusal that will not change
      // gives the words back to the composer.
      if (!get().local && !apiOff) {
        const p: Pending = { key: uuid(), board: target, events: stamped, account: get().me?.email ?? '' }
        mutate((list) => [...list, p])
        const r = await post(p)
        if (r === 'stored') { h?.done(); return true }
        if (r === 'wait') { h?.fail('queued'); return true }
        // refused at once: the person is still here, words in hand - back to the composer, said out loud
        const why = (readOutbox() ?? get().pending).find((x) => x.key === p.key)?.refused
        mutate((list) => list.filter((x) => x.key !== p.key))
        h?.fail('send-failed')
        const { useStore } = await import('./store.ts')
        useStore.getState().toast(why ?? 'comment rejected')
        return false
      }
      const res = await api(`comments/${target}`, { events: stamped }).catch((e: unknown) => { h?.fail('send-failed'); throw e })
      if (res.status === 401) { h?.fail('signed-out'); set({ needsIdentity: true }); return false }
      // any other refusal gets said out loud - a silent dead Enter key reads as a bug
      // (the canonical case: a signed-in viewer on a read-only board)
      if (!res.ok) {
        h?.fail('send-failed')
        const { useStore } = await import('./store.ts')
        useStore.getState().toast(String((res.data as any)?.error ?? 'comment rejected'))
      }
      // union only what the server took - a rejected send must not leave phantoms; the
      // store is global now, so an accepted write lands regardless of the viewed board
      // (client ids keep the eventual SSE/poll echo idempotent)
      if (res.ok) {
        // published: the copy kept here wears my opaque id, as the server's projection of it will (spec 31 C.2, Codex
        // r2) - the echo is a duplicate by id and dropped, so without it this message would not be mine until a reload
        union(get().local ? stamped : asSentBy(stamped, get().me?.id))
        // a message this page just wrote is mine (spec 31 C.2) - the server recorded it with the write
        if (get().local) {
          const mine = stamped.filter((e) => (e.type === 'create' || e.type === 'reply') && e.commentId)
          if (mine.length) {
            const own: Record<string, Set<string>> = Object.assign(Object.create(null), get().ownership ?? {})
            own[target] = new Set([...(Object.hasOwn(own, target) ? own[target] : []), ...mine.map((e) => e.commentId!)])
            set({ ownership: own })
          }
        }
        h?.done()
      }
      return res.ok
    },

    async create(body, h) {
      const { draft, me } = get()
      if (!draft || !body.trim()) { h?.fail('send-failed'); return }
      const id = uuid()
      const mentions = mentionsIn(body.trim(), mentionPeople(get().events, me ?? undefined))
      const ok = await get().send([{
        id: uuid(), ts: now(), type: 'create', commentId: id,
        nodeKey: draft.nodeKey, frame: draft.frame, anchor: draft.anchor,
        author: postAuthor(me), body: body.trim(), ...(mentions ? { mentions } : {}),
      }], draft.board, h)
      if (ok) set({ draft: null, active: id, commentMode: false })
    },

    async reply(threadId, body) { await get().replyOk(threadId, body) },
    async replyOk(threadId, body, h) {
      if (!body.trim()) { h?.fail('send-failed'); return false }
      // route to the thread's ORIGIN log - the viewer may be reading it from another
      // board (frame-scoped display); a reply landing in the wrong log would fork it
      const origin = get().threads.find((t) => t.id === threadId)?.board
      const mentions = mentionsIn(body.trim(), mentionPeople(get().events, get().me ?? undefined))
      return get().send([{
        id: uuid(), ts: now(), type: 'reply', commentId: uuid(), parentId: threadId,
        author: postAuthor(get().me), body: body.trim(), ...(mentions ? { mentions } : {}),
      }], origin, h)
    },

    async resolve(threadId, reopen = false, h) {
      const origin = get().threads.find((t) => t.id === threadId)?.board
      // `comment-resolve`'s one code: a resolve refused for any reason did not send
      const sent = await get().send([{ id: uuid(), ts: now(), type: reopen ? 'reopen' : 'resolve', commentId: threadId }], origin)
        .catch((e: unknown) => { h?.fail('send-failed'); throw e })
      if (sent) h?.done(); else h?.fail('send-failed')
    },

    isMine(board, msg) {
      if (msg.agent) return false
      const { local, ownership, me } = get()
      if (local) return !!board && !!ownership && Object.hasOwn(ownership, board) && ownership[board].has(msg.id)
      return !!me?.id && !!msg.author?.id && msg.author.id === me.id
    },

    async edit(threadId, msgId, body, h) {
      const words = body.trim()
      if (!words) { h?.fail('send-failed'); return false }
      const origin = get().threads.find((t) => t.id === threadId)?.board
      return get().send([{ id: uuid(), ts: now(), type: 'edit', commentId: msgId, author: postAuthor(get().me), body: words }], origin, h)
    },

    async remove(threadId, msgId, h) {
      const origin = get().threads.find((t) => t.id === threadId)?.board
      const ok = await get().send([{ id: uuid(), ts: now(), type: 'delete', commentId: msgId, author: postAuthor(get().me) }], origin, h)
      // a deleted first comment with nothing under it is gone: its card closes
      if (ok && get().active === threadId && !get().threads.some((t) => t.id === threadId)) set({ active: null })
      return ok
    },

    async sweep() { await fetchAll() },

    async findThread(id) {
      if (!get().threads.some((t) => t.id === id)) await fetchAll()
      return get().threads.find((t) => t.id === id) ?? null
    },

    // the Not on a board view shows threads but takes no new ones (spec 26): a note needs a board
    // never on while the canvas is stopped (spec 28 A1.11): a comment picked could not be sent
    setMode(on) { if (on && (get().board === UNPLACED || canvasStopped())) return; set({ commentMode: on, ...(on ? { show: true } : { draft: null }) }) },
    setShow(show) { set({ show }) },
    setShowAnchor(showAnchor) { set({ showAnchor }) },
    setActive(active) {
      // opening a thread is SEEING it - the mention pulse for it stops here
      if (active) {
        const mentionSeen = { ...get().mentionSeen, [active]: Date.now() }
        try { localStorage.setItem(scoped('mv-mention-seen'), JSON.stringify(mentionSeen)) } catch { /* private mode */ }
        set({ active, mentionSeen })
      } else set({ active })
    },
    setDraft(draft) {
      const board = draft ? draft.board ?? get().board ?? undefined : undefined
      if (board === UNPLACED) return
      set({ draft: draft ? { ...draft, board } : null })
    },
    dismissIdentity() { set({ needsIdentity: false }) },   // inviteToken survives dismissal - commenting later reopens the claim

    async signIn(email, password, h) {
      const res = await identityWrite('auth/signin', { email, password }, h)
      if (!res.ok || !res.data?.user) return res.data?.error ?? 'sign-in failed'
      set({ me: { ...res.data.user, ...(res.data.id ? { id: res.data.id } : {}) }, needsIdentity: false, signedOut: false })
      void get().flush()
      return null
    },
    async claim(token, password, name, avatar, h) {
      const res = await identityWrite('auth/claim', { token, password, name, avatar }, h)
      if (!res.ok || !res.data?.user) return res.data?.error ?? 'claim failed'
      set({ me: { ...res.data.user, ...(res.data.id ? { id: res.data.id } : {}) }, needsIdentity: false, inviteToken: null, signedOut: false })
      void get().flush()
      return null
    },
    async saveProfile(patch, h) {
      const res = await identityWrite('profile', patch, h)
      if (!res.ok) return res.data?.error ?? 'could not save - try again'
      set({ me: res.data.user })
      return null
    },
    signInAgain() {
      const { signInMode, me, pending } = get()
      if (signInMode === 'marver-id') {
        // Marver ID signs in through its own pages: the tab leaves and comes back to this board. Nothing is lost on the
        // way - the outbox and the drafts are on disk, and the canvas sends them when it is back.
        leaving = true
        location.assign(`${ROUTE}/id/start${location.hash ? `?next=${encodeURIComponent(location.hash)}` : ''}`)
        return
      }
      // a password canvas: a member signs in in the dialog, here; a guest's door is the gate page
      if (me || pending.length) { set({ needsIdentity: true }); return }
      leaving = true
      location.reload()
    },
    flush,
    retry(key) {
      mutate((list) => list.map((x) => (x.key === key ? { ...x, refused: undefined } : x)))
      void flush()
    },
    discard(key) { mutate((list) => list.filter((x) => x.key !== key)) },

    async askToComment() {
      const res = await api('request-access', { requestedRole: 'comment' })
      return res.ok
    },
  }
})

// the canvas stopped (spec 28 A1.11): comment mode goes off - a pick could open only a comment that cannot be
// sent. A comment being written stays, words and all.
useLink.subscribe((l, p) => {
  if (stoppedLink(l.link) && !stoppedLink(p.link) && useComments.getState().commentMode && !useComments.getState().draft) useComments.getState().setMode(false)
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
