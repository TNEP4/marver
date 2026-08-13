/**
 * Comment surfaces on the canvas (SPEC-M3 §6). Canvas-first: pins live ON the frame
 * at their anchored elements; an inactive frame collapses its open threads into a
 * top-right stack; the thread card opens beside its pin. Pins keep a screen-space
 * size via --sh-inv (the vbadge pattern) so zoom never shrinks them away.
 */
import { useEffect, useRef, useState } from 'react'
import { avatarFallback, useComments } from './comments-store.ts'
import { useStore, type Node } from './store.ts'
import { canvasCtl } from './canvas/Canvas.tsx'
import { bootHash, buildHash, parseHash } from './hash.ts'
import { CheckIcon, LinkIcon, XIcon } from './icons.tsx'
import { Tip } from './Tip.tsx'
import type { Thread } from '../../shared/events.ts'

const rel = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 24 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

export function Avatar({ author, size = 22 }: { author?: { email?: string; name?: string; avatar?: string }; size?: number }) {
  if (author?.avatar) return <img className="cm-avatar" src={author.avatar} width={size} height={size} alt="" />
  const { initials, hue } = avatarFallback(author)
  return (
    <span className="cm-avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 55% 45%)` }}>
      {initials}
    </span>
  )
}

/** Lives inside FrameNode's body, over the iframe. Owns anchor resolution for its frame. */
export function CommentLayer({ node, frameId, iframe }: { node: Node; frameId: string; iframe: React.RefObject<HTMLIFrameElement | null> }) {
  const show = useComments((s) => s.show)
  const active = useComments((s) => s.active)
  const draft = useComments((s) => s.draft)
  // select the stable array, filter in render - a selector returning a fresh
  // .filter() array re-renders forever (Object.is never matches)
  const allThreads = useComments((s) => s.threads)
  const threads = allThreads.filter((t) => t.frame === frameId && (!t.nodeKey || t.nodeKey === node.key))
  const selected = useStore((s) => s.selection.includes(node.key))
  const { setActive } = useComments.getState()
  const [rects, setRects] = useState<Record<string, { x: number; y: number; w: number; h: number } | null>>({})

  const open = threads.filter((t) => !t.resolved)
  const anchored = open.filter((t) => (t.anchor as any)?.el)

  // resolve anchors against the live frame whenever threads or the document change
  useEffect(() => {
    const win = iframe.current?.contentWindow
    if (!win || node.status !== 'ready' || !anchored.length) return
    const ask = () => win.postMessage({ type: 'sh:resolve-anchors', anchors: anchored.map((t) => ({ key: t.id, anchor: t.anchor })) }, location.origin)
    const onMsg = (e: MessageEvent) => {
      if (e.source !== win || e.data?.type !== 'sh:anchor-rects') return
      const next: typeof rects = {}
      for (const r of e.data.rects ?? []) next[r.key] = r.orphan ? null : r.rect
      setRects(next)
    }
    window.addEventListener('message', onMsg)
    ask()
    const iv = setInterval(ask, 4000)          // re-renders, scroll, hot reloads - cheap to re-ask
    return () => { clearInterval(iv); window.removeEventListener('message', onMsg) }
  }, [node.status, anchored.map((t) => t.id).join(','), iframe])

  const drafting = draft?.nodeKey === node.key
  if (!show || (!open.length && !drafting)) return null

  // inactive frame: the stack - count + avatars, top-right (SPEC-M3 §6)
  const engaged = selected || open.some((t) => t.id === active) || drafting
  if (!engaged && open.length) {
    const authors = [...new Map(open.map((t) => [t.author?.email ?? t.id, t.author])).values()].slice(0, 2)
    return (
      <button className="cm-stack sh-no-pan" onClick={(e) => { e.stopPropagation(); useStore.getState().select(node.key); if (open[0]) setActive(open[0].id) }}>
        {authors.map((a, i) => <Avatar key={i} author={a} size={24} />)}
        {open.length > 1 && <b>{open.length}</b>}
      </button>
    )
  }

  const pinPos = (t: Thread) => {
    const a = t.anchor as any
    const r = rects[t.id]
    if (a?.el && r) return { x: r.x + (a.pos?.fx ?? 0.5) * r.w, y: r.y + (a.pos?.fy ?? 0.5) * r.h, orphan: false }
    if (a?.el && r === null) return { x: node.w - 16, y: 16, orphan: true }         // orphan parks top-right
    const p = a?.pos                                                                // frame-level: stored fraction of the frame
    return { x: (p?.fx ?? 0.94) * node.w, y: (p?.fy ?? 0.06) * node.h, orphan: false }
  }

  return (
    <>
      {open.map((t) => {
        const { x, y, orphan } = pinPos(t)
        return (
          <div key={t.id} className={`cm-pin sh-no-pan${t.id === active ? ' on' : ''}${orphan ? ' orphan' : ''}`}
            style={{ left: x, top: y }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setActive(t.id === active ? null : t.id) }}
            title={orphan ? 'the anchored element is gone - comment parked' : undefined}>
            <Avatar author={t.author} size={24} />
          </div>
        )
      })}
      {active && open.some((t) => t.id === active) && (
        <ThreadCard thread={open.find((t) => t.id === active)!} at={pinPos(open.find((t) => t.id === active)!)} node={node} />
      )}
      {draft?.nodeKey === node.key && <DraftComposer at={{ x: ((draft.anchor as any)?.rect?.x ?? 0) + ((draft.anchor as any)?.pos?.fx ?? 0.5) * ((draft.anchor as any)?.rect?.w ?? 0), y: ((draft.anchor as any)?.rect?.y ?? 0) + ((draft.anchor as any)?.pos?.fy ?? 0.5) * ((draft.anchor as any)?.rect?.h ?? 0) }} node={node} />}
    </>
  )
}

function ThreadCard({ thread, at, node }: { thread: Thread; at: { x: number; y: number }; node: Node }) {
  const { resolve, setActive } = useComments.getState()
  const [text, setText] = useState('')
  const flip = at.x > node.w * 0.55
  // clear only after the server took it - a failed send must not eat the words
  const submit = async () => { if (text.trim() && await useComments.getState().replyOk(thread.id, text)) setText('') }
  return (
    <div className={`cm-card sh-no-pan${flip ? ' flip' : ''}`} style={{ left: at.x, top: Math.min(at.y + 14, node.h - 40) }}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <header>
        <Avatar author={thread.author} size={24} />
        <b>{thread.author?.name ?? 'Someone'}</b>
        <span className="dim">{rel(thread.ts)}</span>
        <span className="grow" />
        <Tip side="bottom" label={<b>Copy link</b>}>
          <button className="cm-icon" onClick={() => {
            const url = `${location.origin}${location.pathname}${buildHash({ board: useStore.getState().board, c: thread.id })}`
            void navigator.clipboard.writeText(url)
            useStore.getState().toast('comment link copied')
          }}><LinkIcon size={15} /></button>
        </Tip>
        <Tip side="bottom" label={<b>Resolve</b>}>
          <button className="cm-icon" onClick={() => { void resolve(thread.id); setActive(null) }}><CheckIcon size={16} /></button>
        </Tip>
        <Tip side="bottom" label={<b>Close</b>}>
          <button className="cm-icon" onClick={() => setActive(null)}><XIcon size={15} /></button>
        </Tip>
      </header>
      <p className="cm-body">{thread.body}</p>
      {thread.replies.map((r) => (
        <div key={r.id} className="cm-reply">
          <Avatar author={r.author} size={20} />
          <div>
            <span className="cm-who"><b>{r.author?.name ?? 'Someone'}</b> <span className="dim">{rel(r.ts)}</span></span>
            <p className="cm-body">{r.body}</p>
          </div>
        </div>
      ))}
      <div className="cm-compose">
        <input value={text} placeholder="Reply…" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void submit(); if (e.key === 'Escape') setActive(null) }} />
      </div>
    </div>
  )
}

function DraftComposer({ at, node }: { at: { x: number; y: number }; node: Node }) {
  const { create, setDraft } = useComments.getState()
  const [text, setText] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const flip = at.x > node.w * 0.55
  return (
    <div className={`cm-card cm-draft sh-no-pan${flip ? ' flip' : ''}`} style={{ left: at.x, top: Math.min(at.y + 14, node.h - 40) }}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="cm-compose">
        <input ref={ref} value={text} placeholder="Comment on this element…" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void create(text)
            if (e.key === 'Escape') setDraft(null)
          }} />
      </div>
    </div>
  )
}

/** Signed-out published viewer tried to comment: sign in, or claim an invite. */
export function IdentityDialog() {
  const needs = useComments((s) => s.needsIdentity)
  const { signIn, claim, dismissIdentity } = useComments.getState()
  const [mode, setMode] = useState<'signin' | 'claim'>('signin')
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [token, setToken] = useState(''); const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  if (!needs) return null
  const go = async () => {
    setErr(null)
    const e = mode === 'signin' ? await signIn(email, password) : await claim(token, password, name)
    if (e) setErr(e)
  }
  return (
    <div className="cm-modal-wrap" onClick={dismissIdentity}>
      <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Comment as yourself</h2>
        <p className="dim">Reading needs only the canvas password - commenting carries your name.</p>
        <div className="cm-tabs">
          <button className={mode === 'signin' ? 'on' : ''} onClick={() => setMode('signin')}>Sign in</button>
          <button className={mode === 'claim' ? 'on' : ''} onClick={() => setMode('claim')}>I have an invite</button>
        </div>
        {mode === 'signin' ? (
          <>
            <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void go()} />
          </>
        ) : (
          <>
            <input placeholder="Invite token" value={token} onChange={(e) => setToken(e.target.value)} />
            <input placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="Choose a password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void go()} />
          </>
        )}
        {err && <span className="cm-err">{err}</span>}
        <div className="cm-row">
          <button className="cm-primary" onClick={() => void go()}>{mode === 'signin' ? 'Sign in' : 'Create account'}</button>
          <button onClick={dismissIdentity}>Not now</button>
        </div>
      </div>
    </div>
  )
}

/** Open a thread by id: activate, select its node, fit the camera. True on success. */
function revealThread(c: string): boolean {
  const t = useComments.getState().threads.find((t) => t.id === c)
  if (!t) return false
  useComments.getState().setActive(c)
  const node = t.nodeKey && useStore.getState().nodes.find((n) => n.key === t.nodeKey)
  if (node) {
    useStore.getState().select(node.key)
    setTimeout(() => canvasCtl.fitNode(node.key), 80)
  }
  return true
}

/** Board-level comment wiring: load + liveness + mode broadcast, one instance in App. */
let bootThreadConsumed = false
export function CommentsController() {
  const board = useStore((s) => s.board)
  const commentMode = useComments((s) => s.commentMode)

  useEffect(() => {
    const { load, live } = useComments.getState()
    void load(board).then(() => {
      // deep link ?c=<thread> (SPEC-M3 §6): open the thread, select its node, fit it.
      // Consumed only on a successful find: the controller's first effect fires with
      // the pre-boot board (child effects run before the parent's boot effect), and
      // burning the flag on that empty pass would eat the link.
      if (bootThreadConsumed || !bootHash.c) return
      if (revealThread(bootHash.c)) bootThreadConsumed = true
    })
    return live(board)
  }, [board])

  // a comment link pasted into an ALREADY-OPEN canvas is a hash-only navigation -
  // no reload, no boot path. Watch for c on hashchange and reveal it live.
  useEffect(() => {
    const onHash = () => {
      const c = parseHash().c
      if (c) setTimeout(() => revealThread(c), 60)   // give a board switch a beat to load
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // broadcast pick mode to every frame (laser rides along inside the bridge)
  useEffect(() => {
    for (const f of document.querySelectorAll('iframe'))
      (f as HTMLIFrameElement).contentWindow?.postMessage({ type: 'sh:pick', on: commentMode }, location.origin)
  }, [commentMode])

  return <IdentityDialog />
}
