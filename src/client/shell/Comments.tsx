/**
 * Comment surfaces on the canvas (SPEC-M3 §6). Canvas-first: pins live ON the frame
 * at their anchored elements; an inactive frame collapses its open threads into a
 * top-right stack; the thread card opens beside its pin. Pins keep a screen-space
 * size via --sh-inv (the vbadge pattern) so zoom never shrinks them away.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { avatarFallback, useComments } from './comments-store.ts'
import { useStore, type Node } from './store.ts'
import { canvasCtl } from './canvas/Canvas.tsx'
import { bootHash, buildHash, parseHash, writeHash } from './hash.ts'
import { ArrowUpIcon, CheckIcon, CheckSquareOffsetIcon, LinkIcon, ParallelogramFillIcon, PencilSimpleIcon, UserIcon, XIcon } from './icons.tsx'
import { Tip } from './Tip.tsx'
import { parseMentions } from './mentions.ts'
import { ROUTE } from '../const.ts'
import type { AgentMeta, Thread } from '../../shared/events.ts'

/** Tint the pin / composer / thread card EDGES (border, outline, focus ring) in the anchored
 *  element's own laser hue (captured at pick as anchor.el.hue) via --cm-line/--cm-line-ring.
 *  Deliberately NOT the button fills (--comment stays green: white text on a saturated hue
 *  fails at yellow/green/cyan) and NOT the avatar (keeps its per-user colour). No hue -> the
 *  CSS falls back to the green token. */
export function hueVars(hue?: number): React.CSSProperties {
  // guard NaN / Infinity from a bad persisted anchor - an invalid custom property would
  // suppress the CSS fallback and leave the edge uncoloured
  if (!Number.isFinite(hue)) return {}
  const h = hue as number
  // --cm-solid is the FILLED-button colour (send / sign-in): a hue-aware lightness so the
  // white glyph keeps contrast - yellow/green/cyan read light, so they go darker.
  const l = (h >= 40 && h < 75) ? 34 : (h >= 75 && h < 165) ? 36 : (h >= 165 && h < 200) ? 38 : 45
  return {
    '--cm-line': `hsl(${h} 95% 45%)`,
    '--cm-line-ring': `hsl(${h} 95% 50% / .30)`,
    '--cm-solid': `hsl(${h} 85% ${l}%)`,
  } as React.CSSProperties
}
const anchorHue = (a: unknown): number | undefined => (a as any)?.el?.hue

const rel = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 24 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

/** The Marver mark avatar: accent-blue disc + the solid white parallelogram. One place, reused
 *  by the thread header, the pin/stack marker, and the notification pill. */
export function MarverAvatar({ size = 24 }: { size?: number }) {
  // 0.5 keeps clear blue padding around the mark even in the marker, where a 2px white border
  // shrinks the visible disc (a bigger mark looked nearly cut there).
  return (
    <span className="cm-avatar cm-marver" style={{ width: size, height: size }} aria-label="Marver">
      <ParallelogramFillIcon size={Math.round(size * 0.5)} />
    </span>
  )
}

export function Avatar({ author, size = 22 }: { author?: { email?: string; name?: string; avatar?: string; agent?: boolean }; size?: number }) {
  if (author?.agent) return <MarverAvatar size={size} />   // Marver shows as its own participant
  if (author?.avatar) return <img className="cm-avatar" src={author.avatar} width={size} height={size} alt="" />
  const { initials, hue } = avatarFallback(author)
  return (
    <span className="cm-avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue} 55% 45%)` }}>
      {initials}
    </span>
  )
}

type Face = { email?: string; name?: string; avatar?: string; agent?: boolean }

/** The signal a marker (pin or stack) carries: WHO took part and HOW MANY comments
 *  in total - root + every reply, across all the given threads. Unique participants
 *  in first-seen order; a single reply-less comment counts as 1. */
function markerDigest(threads: Thread[]): { faces: Face[]; count: number } {
  const seen = new Map<string, Face>()
  let count = 0
  // namespace the identity key so an email can never collide with someone's name, and normalize
  // email case; authorless comments collapse to one 'anon' face. An AGENT message is its own
  // participant ("Marver"), NOT the owner who authored it - so the marker shows N + Marver.
  const add = (a: Face | undefined, agent?: boolean) => {
    const face: Face | undefined = agent ? { agent: true } : a
    const k = agent ? 'marver' : a?.email ? `e:${a.email.toLowerCase()}` : a?.name ? `n:${a.name}` : 'anon'
    if (face && !seen.has(k)) seen.set(k, face)
  }
  for (const t of threads) {
    count += 1 + t.replies.length
    add(t.author, t.agent)
    for (const r of t.replies) add(r.author, r.agent)
  }
  return { faces: [...seen.values()], count }
}

/** The face of a marker: up to `max` overlapping avatars + the total count when >1.
 *  One shape for pins (one thread, anchored) and stacks (all threads on a frame). */
export function MarkerFace({ threads, max = 3 }: { threads: Thread[]; max?: number }) {
  const { faces, count } = markerDigest(threads)
  return (
    <>
      {faces.slice(0, max).map((a, i) => <Avatar key={i} author={a} size={24} />)}
      {count > 1 && <b>{count}</b>}
    </>
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
  // whether the ACTIVE thread is still open on this frame - a dep for the highlight effect so
  // a remote resolve (thread leaves `open` while `active` is unchanged) still clears the lock
  const activeShown = !!active && open.some((t) => t.id === active)

  // resolve anchors against the live frame whenever threads or the document change
  useEffect(() => {
    const win = iframe.current?.contentWindow
    if (!win || node.status !== 'ready' || !anchored.length) return
    const ask = () => win.postMessage({ type: 'sh:resolve-anchors', anchors: anchored.map((t) => ({ key: t.id, anchor: t.anchor })) }, location.origin)
    const onMsg = (e: MessageEvent) => {
      if (e.source !== win || e.origin !== location.origin || e.data?.type !== 'sh:anchor-rects') return
      const next: typeof rects = {}
      for (const r of e.data.rects ?? []) next[r.key] = r.orphan ? null : r.rect
      setRects(next)
    }
    window.addEventListener('message', onMsg)
    ask()
    const iv = setInterval(ask, 4000)          // re-renders, scroll, hot reloads - cheap to re-ask
    return () => { clearInterval(iv); window.removeEventListener('message', onMsg) }
  }, [node.status, anchored.map((t) => t.id).join(','), iframe])

  // #4/#5: drive the persistent element highlight into this frame - the composing draft on
  // this node (lock on pick), or the open thread anchored here (highlight on open). null
  // clears it, so the shell owns the release; on a failed/late resolve the frame re-applies
  // on its next anchor-resolve tick. The self-lock on pick handles the instant case.
  useEffect(() => {
    const win = iframe.current?.contentWindow
    if (!win || node.status !== 'ready') return
    // ONLY light an element while its thread is the active one (or a draft is composing on
    // it) AND pins are shown - closing the thread or hiding comments (⇧C) clears it, so a
    // stray outline never lingers on the frame.
    const draftHere = draft?.nodeKey === node.key ? (draft.anchor as any) : null
    const activeHere = active ? open.find((t) => t.id === active && (t.anchor as any)?.el) : undefined
    const anchor = show ? (draftHere ?? (activeHere ? (activeHere.anchor as any) : null)) : null
    win.postMessage({ type: 'sh:highlight-anchor', frame: frameId, anchor: anchor ?? null }, location.origin)
    // active/draft/show/activeShown are the triggers; `open` is read fresh from the closure
  }, [active, draft, show, activeShown, node.status, node.key, frameId, iframe])

  // the open card's frozen side (D3) - a HOOK, so it must live above the early returns; and the
  // reset must too: a card can close via the inactive-frame early return (clicking another frame),
  // which never reaches the render tail - reopen must still RE-PICK the side (Codex P2)
  const sideRef = useRef<{ id: string; side: 'l' | 'r' } | null>(null)
  if (sideRef.current && sideRef.current.id !== active) sideRef.current = null
  // what occupies this frame's LEFT flank (drives the docked card's left gutter): a variant
  // badge is widest, the working shimmer next. Reactive, so a job starting mid-read adjusts.
  const flankBadge = useStore((s) => !!s.frameFor(node)?.variantGroup)
  const flankShim = useStore((s) => s.working.includes(frameId))
  const drafting = draft?.nodeKey === node.key
  if (!show || (!open.length && !drafting)) return null

  // inactive frame: the stack - count + avatars, top-right (SPEC-M3 §6)
  const engaged = selected || open.some((t) => t.id === active) || drafting
  if (!engaged && open.length) {
    return (
      <button className="cm-stack sh-no-pan" onClick={(e) => { e.stopPropagation(); useStore.getState().select(node.key); if (open[0]) setActive(open[0].id) }}>
        <MarkerFace threads={open} />
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

  // The card's SIDE, chosen ONCE per open and frozen (D3 - never switches mid-read): the pin's
  // side of the frame first, skipping a side another frame's screen rect occupies, then wherever
  // the viewport has room. The active pin's teardrop tail flips toward this side.
  const activeThread2 = active ? open.find((t) => t.id === active) : undefined
  if (activeThread2 && sideRef.current?.id !== activeThread2.id) {
    const compute = (): 'l' | 'r' => {
      const W = 320, GAP = 30
      const rect = document.querySelector(`[data-node="${CSS.escape(node.key)}"]`)?.getBoundingClientRect()
      if (!rect) return 'r'
      const occupied = (s: 'l' | 'r') => {
        const rx = s === 'r' ? rect.right + 10 : rect.left - 10 - W
        return [...document.querySelectorAll('.sh-node')].some((n) => {
          if (n.getAttribute('data-node') === node.key) return false
          const r = n.getBoundingClientRect()
          return r.left < rx + W && r.right > rx && r.top < rect.bottom && r.bottom > rect.top
        })
      }
      const room = (s: 'l' | 'r') => (s === 'r' ? window.innerWidth - rect.right : rect.left) >= W + GAP
      const prefer: ('l' | 'r')[] = pinPos(activeThread2).x < node.w / 2 ? ['l', 'r'] : ['r', 'l']
      return prefer.find((s) => room(s) && !occupied(s)) ?? prefer.find(room) ?? prefer[0]
    }
    sideRef.current = { id: activeThread2.id, side: compute() }
  }
  const cardSide: 'l' | 'r' = sideRef.current?.side ?? 'r'

  return (
    <>
      {open.map((t) => {
        const { x, y, orphan } = pinPos(t)
        const isActive = t.id === active
        return (
          <div key={t.id} className={`cm-pin sh-no-pan${isActive ? ' on' : ''}${isActive && cardSide === 'r' ? ' tail-r' : ''}${orphan ? ' orphan' : ''}`}
            style={{ left: x, top: y, ...hueVars(anchorHue(t.anchor)) }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setActive(t.id === active ? null : t.id) }}
            title={orphan ? 'the anchored element is gone - comment parked' : undefined}>
            <MarkerFace threads={[t]} />
          </div>
        )
      })}
      {activeThread2 && (
        <ThreadCard key={active} thread={activeThread2} at={pinPos(activeThread2)} bounds={{ w: node.w, h: node.h }} nodeKey={node.key} side={cardSide}
          flank={cardSide === 'l' ? (flankBadge ? 'badge' : flankShim ? 'shim' : null) : null} />
      )}
      {draft?.nodeKey === node.key && <DraftComposer at={{ x: ((draft.anchor as any)?.rect?.x ?? 0) + ((draft.anchor as any)?.pos?.fx ?? 0.5) * ((draft.anchor as any)?.rect?.w ?? 0), y: ((draft.anchor as any)?.rect?.y ?? 0) + ((draft.anchor as any)?.pos?.fy ?? 0.5) * ((draft.anchor as any)?.rect?.h ?? 0) }} bounds={{ w: node.w, h: node.h }} hue={anchorHue(draft.anchor)} />}
    </>
  )
}

/** The open thread card - shared by canvas (bounds = node size, `at` in frame coords) and
 *  prototype (bounds = the on-screen stage size, `at` in screen coords). Geometry only. */
// ---- Live Jam: @marver rendering + Marver identity (SPEC-live-jam §1, §7) ----------------------

const AT_TIP = "Read like any other comment. Marver won't act on this unless the owner promotes it."

/** A comment body with @marver mentions styled: owner-authored → bold accent (a live trigger);
 *  anyone else's → plain + a teaching tooltip (context, not a command). */
function CommentBody({ body, owner }: { body?: string; owner: boolean }) {
  if (!body) return null
  return (
    <p className="cm-body">
      {parseMentions(body).map((s, i) => !s.mention
        ? <span key={i}>{s.text}</span>
        : owner
          ? <span key={i} className="cm-at owner">{s.text}</span>
          : <Tip key={i} side="top" label={<span className="cm-at-tip">{AT_TIP}</span>}><span className="cm-at">{s.text}</span></Tip>)}
    </p>
  )
}

const HARNESS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', droid: 'Factory Droid' }
/** claude-opus-5 → Opus 5; gpt-5.1-codex → Gpt 5.1 Codex; unknown → as-is. */
function prettyModel(m: string): string {
  const cleaned = m.replace(/^claude-/, '').replace(/-/g, ' ')
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** The provenance tooltip on the Marver avatar: who orchestrated the change (SPEC §7).
 *  One row per fact, left-aligned, bold label + regular value - the house tooltip treatment. */
function AgentMetaTip({ meta }: { meta?: AgentMeta }) {
  const rows = [
    meta?.devUser && ['Dev user', meta.devUser],
    meta?.harness && ['Harness', HARNESS[meta.harness] ?? meta.harness],
    meta?.model && ['Model', prettyModel(meta.model)],
    meta?.effort && ['Effort', meta.effort],
  ].filter(Boolean) as [string, string][]
  if (!rows.length) return <b>Marver</b>
  // Toolbar-tooltip treatment: the VALUE is bold + bright (what you scan), the label is a muted
  // qualifier after it - like "Hide all UI  press H to reveal".
  return (
    <span className="cm-meta-tip">
      {rows.map(([label, value]) => <span key={label} className="cm-meta-row"><b>{value}</b><span className="k">{label}</span></span>)}
    </span>
  )
}

/** A message header. Agent messages render as "Marver" with the mark + provenance tooltip;
 *  human messages keep their avatar + name. */
function MessageHead({ author, agent, agentMeta, ts }: { author?: Thread['author']; agent?: boolean; agentMeta?: AgentMeta; ts: number }) {
  if (agent) return (
    <header>
      <Tip side="top" label={<AgentMetaTip meta={agentMeta} />}>
        <span className="cm-marver-wrap"><MarverAvatar size={24} /></span>
      </Tip>
      <b className="cm-marver-name">Marver</b>
      <span className="dim">{rel(ts)}</span>
    </header>
  )
  return (
    <header>
      <Avatar author={author} size={24} />
      <b>{author?.name ?? 'Someone'}</b>
      <span className="dim">{rel(ts)}</span>
    </header>
  )
}

/** An auto-growing composer with the full keybindings: Enter send, Shift+Enter newline,
 *  Cmd/Ctrl+Enter send, Escape cancel; IME-guarded, disabled while a send is in flight. */
function CommentInput({ value, onChange, onSubmit, onCancel, placeholder, autoFocus, sendLabel, owner }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void | Promise<unknown>
  onCancel?: () => void; placeholder: string; autoFocus?: boolean; sendLabel: string; owner: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const hlRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const grow = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 132) + 'px' } }
  const syncScroll = () => { if (hlRef.current && ref.current) hlRef.current.scrollTop = ref.current.scrollTop }
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
  useEffect(grow, [value])
  const submit = async () => {
    if (busy || !value.trim()) return
    setBusy(true)
    try { await onSubmit() } finally { setBusy(false) }
  }
  return (
    <div className="cm-inputwrap">
      {/* Live mention highlight: a mirror layer behind the transparent-text textarea, so @marver shows
          its trigger colour AS YOU TYPE (owner = accent-blue "this will run"; else muted). SPEC §1. */}
      <div className="cm-hl" ref={hlRef} aria-hidden>
        {parseMentions(value).map((s, i) => s.mention
          ? <span key={i} className={owner ? 'cm-at owner' : 'cm-at'}>{s.text}</span>
          : <span key={i}>{s.text}</span>)}
        {value.endsWith('\n') ? '​' : ''}
      </div>
      <textarea ref={ref} rows={1} value={value} placeholder={placeholder} disabled={busy} spellCheck={false}
        onChange={(e) => onChange(e.target.value)} onInput={grow} onScroll={syncScroll}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') { onCancel?.(); return }
          if (e.key === 'Enter') {
            if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return   // IME: mid-composition Enter must not send
            if (e.shiftKey) return                                                            // newline
            e.preventDefault(); void submit()                                                 // Enter / Cmd·Ctrl+Enter send
          }
        }} />
      <Tip side="top" label={<b>⏎ send · ⇧⏎ new line</b>}>
        <button className="cm-send" disabled={busy || !value.trim()} aria-label={sendLabel} onClick={() => void submit()}>
          <ArrowUpIcon size={15} />
        </button>
      </Tip>
    </div>
  )
}

/** The dev identity: a full-screen modal (the IdentityDialog treatment - same classes, same
 *  weight) with display name + photo, saved to design/.local/profile.json (this machine only).
 *  When a connect account provides name/email (the published server validates authors), the name
 *  is read-only here and only the photo is editable. Portaled to body: the thread card is
 *  transformed + overflow-hidden, so anything anchored inside it clips. */
function ProfileDialog({ onClose }: { onClose: () => void }) {
  const me = useComments((s) => s.me)
  const connected = useComments((s) => s.connected)
  const unset = !connected && (!me?.name || me.name === 'You')
  const [name, setName] = useState(unset ? '' : me?.name ?? '')
  const [avatar, setAvatar] = useState(me?.avatar ?? '')
  const [busy, setBusy] = useState(false)
  const ready = connected || !!name.trim()
  const save = async () => {
    if (busy || !ready) return
    setBusy(true)
    try {
      await useComments.getState().saveProfile({ ...(connected ? {} : { name: name.trim() }), avatar })
      onClose()
    } finally { setBusy(false) }
  }
  return createPortal(
    <div className="cm-modal-wrap" onClick={onClose} onPointerDown={(e) => e.stopPropagation()}>
      <div className="cm-modal" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose() }}>
        <h2>How you’ll appear</h2>
        <p className="dim">
          {connected
            ? <>Your name comes from your connect account. The photo stays on this machine.</>
            : <>Comments carry your name and photo. Saved to design/.local on this machine - yours, nowhere else.</>}
        </p>
        <div className="cm-fields">
          <div className="cm-idrow">
            <AvatarPick value={avatar} onPick={setAvatar} />
            {connected
              ? <div className="cm-chip" style={{ flex: 1 }}><b>{me?.name}</b><span>CONNECT</span></div>
              : <input placeholder="Set a display name" style={{ flex: 1 }} value={name} autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void save()} />}
          </div>
        </div>
        <div className="cm-row">
          <button className="cm-primary" disabled={busy || !ready} onClick={() => void save()}>Save</button>
          <button onClick={onClose}>Not now</button>
        </div>
      </div>
    </div>,
    // into .sh-app, NOT body: every theme token (--cm-modal-bg, inks) lives on .sh-app,
    // and a body-portaled modal renders transparent outside that scope
    document.querySelector('.sh-app') ?? document.body)
}

/** Your avatar in the composer is the door to your identity (dev only - published viewers
 *  already have accounts). Unset profile shows a quiet + badge inviting the first setup. */
function ComposeAvatar() {
  const me = useComments((s) => s.me)
  const local = useComments((s) => s.local)
  const connected = useComments((s) => s.connected)
  const [open, setOpen] = useState(false)
  if (!local) return <Avatar author={me ?? undefined} size={24} />
  const unset = !connected && !me?.avatar && (!me?.name || me.name === 'You')
  return (
    <span className="cm-me">
      <Tip side="top" label={<b>{unset ? 'Set your name & photo' : 'Edit your profile'}</b>}>
        <button className="cm-mebtn" aria-label="Edit your profile" onClick={() => setOpen(true)}>
          {unset
            ? <span className="cm-ghost"><UserIcon size={13} /></span>
            : <Avatar author={me ?? undefined} size={24} />}
          {unset && <span className="cm-pen"><PencilSimpleIcon size={8} /></span>}
        </button>
      </Tip>
      {open && <ProfileDialog onClose={() => setOpen(false)} />}
    </span>
  )
}

export function ThreadCard({ thread, at, bounds, nodeKey, side = 'r', flank, stage }: { thread: Thread; at: { x: number; y: number }; bounds: { w: number; h: number }; nodeKey?: string; side?: 'l' | 'r'; flank?: 'badge' | 'shim' | null; stage?: boolean }) {
  const { resolve, setActive } = useComments.getState()
  const me = useComments((s) => s.me)
  const local = useComments((s) => s.local)
  const canComment = local || !!me      // dev is always "me"; published needs a session
  // Owner-authored @marver is a live trigger (bold accent); anyone else's is context (plain + tooltip).
  // Match by email when we know the owner's; in dev without a profile, local writes are the owner.
  const isOwner = (a?: { email?: string }) => (me?.email ? a?.email === me.email : local)
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  // Canvas: the card is a WORLD OBJECT parked beside its frame - it stays put (panning moves
  // frame + card together, never following the viewport). Zoom scales it with a CLAMP
  // (0.9..1.35 of screen-constant), so it reads steady at working zooms yet never dwarfs the
  // frame far out or shrinks away deep in. Height rules: capped at the frame's height; grows
  // DOWNWARD from the pin until it reaches the frame's bottom, then grows UP; past the cap the
  // messages scroll inside. The SIDE is chosen once at open (D3). Play keeps in-stage placement.
  const scrollRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const float = !!nodeKey
  const [cardH, setCardH] = useState(320)   // measured layout px (pre-transform)
  useEffect(() => {
    if (float && cardRef.current) {
      const h = cardRef.current.offsetHeight
      setCardH((c) => (Math.abs(c - h) > 2 ? h : c))
    }
  })
  // scroll shadows: "there is more" above/below - recomputed on scroll + content growth
  const [shadows, setShadows] = useState({ top: false, bot: false, can: false })
  const syncShadows = () => {
    const el = scrollRef.current
    if (!el) return
    // gate on MEANINGFUL overflow - a thread that overflows by a few px must not smear a
    // 30px fade over its last line ("looks scrollable" when it isn't, really)
    const can = el.scrollHeight - el.clientHeight > 12
    const top = can && el.scrollTop > 4
    const bot = can && el.scrollTop + el.clientHeight < el.scrollHeight - 4
    setShadows((s) => (s.top === top && s.bot === bot && s.can === can ? s : { top, bot, can }))
  }
  // open at the LATEST message (what you came to read); follow new replies while open
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    syncShadows()
  }, [thread.replies.length])
  // ...and when the scroller RESIZES without a scroll event (zoom changing the height cap, the
  // composer growing) - a stale fade would otherwise claim "more below" at the bottom of a
  // thread that no longer overflows
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(syncShadows)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // PLAY: one static centered device, no zoom - the card docks FIXED beside it on the pin's side
  // (falling back to the roomier side), fully viewport-clamped so the composer is ALWAYS reachable
  // whatever the device layout or theme (SPEC §14). Computed once at open; play never pans.
  const [stagePos] = useState<React.CSSProperties | null>(() => {
    if (!stage) return null
    const W = 320, M = 12, maxH = Math.min(660, window.innerHeight - 2 * M)
    const rect = document.querySelector('.sh-play-stage')?.getBoundingClientRect()
    if (!rect) return { position: 'fixed', left: M, top: 72, maxHeight: maxH }
    const roomR = window.innerWidth - rect.right >= W + 30
    const roomL = rect.left >= W + 30
    const s: 'l' | 'r' = at.x < bounds.w / 2 ? (roomL ? 'l' : 'r') : (roomR ? 'r' : 'l')
    const x = Math.min(Math.max(s === 'r' ? rect.right + 18 : rect.left - 18 - W, M), window.innerWidth - W - M)
    // worst-case clamp (content = maxH): even a full-height thread keeps its composer on screen
    const y = Math.min(Math.max(rect.top + at.y - 36, M), Math.max(M, window.innerHeight - maxH - M))
    return { position: 'fixed', left: x, top: y, maxHeight: maxH }
  })
  const flip = !float && !stage && at.x > bounds.w * 0.55
  // Nic's revision: the card scales EXACTLY like the pins - screen-constant via --sh-inv, pure
  // CSS, smooth per zoom tick with zero re-renders. Geometry in CSS math over the live vars:
  //   top: grows DOWN from the pin, then UP once its bottom reaches the frame's bottom; floor
  //        at -28 (the layer starts below the header - -28 = the frame's TOP border).
  //   maxHeight: the visual height never exceeds the WHOLE frame (body + 28px header).
  // Gutters live in CSS (dock margins, screen-constant; wider on the left for the shimmer).
  const pos: React.CSSProperties = stage && stagePos
    ? stagePos
    : float
      ? {
          left: side === 'r' ? bounds.w : 0,
          top: `max(-28px, min(${Math.round(at.y)}px - 36px * var(--sh-inv, 1), ${bounds.h}px - ${cardH}px * var(--sh-inv, 1)))`,
          // capped at the whole frame's on-screen height, with a REAL readability floor: zoomed way
          // out the card still shows a meaningful slice of conversation (~3 messages), even if that
          // makes it taller than the tiny frame
          maxHeight: `max(320px, calc(${bounds.h + 28}px * var(--sh-s, 1)))`,
        }
      : { left: at.x, top: Math.min(at.y + 14, bounds.h - 40) }
  // clear only after the server took it - a failed send must not eat the words,
  // and text typed WHILE the request was in flight must survive the clear
  const submit = async () => {
    const sent = text
    if (sent.trim() && await useComments.getState().replyOk(thread.id, sent)) setText((cur) => (cur === sent ? '' : cur))
  }
  const card = (
    <div ref={cardRef} data-sh-wheel-local className={`cm-card sh-no-pan${flip ? ' flip' : ''}${float ? ` parked dock-${side}` : ''}${float && flank ? ` flank-${flank}` : ''}${stage ? ' stage-dock' : ''}`} style={{ ...pos, ...hueVars(anchorHue(thread.anchor)) }}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      {/* thread-level actions pin to the card corner, out of the header's flow -
          the name row never has to share its line with them */}
      <div className="cm-actions">
        <Tip side="bottom" label={<b>{copied ? 'Copied' : 'Copy link'}</b>}>
          <button className={`cm-icon cm-copy${copied ? ' ok' : ''}`} onClick={() => {
            const url = `${location.origin}${location.pathname}${buildHash({ board: useStore.getState().board, c: thread.id })}`
            // the check means "it's on your clipboard" - only show it when that's true
            navigator.clipboard.writeText(url).then(() => {
              setCopied(true)
              clearTimeout(copyTimer.current)
              copyTimer.current = setTimeout(() => setCopied(false), 1600)
            }, () => useStore.getState().toast('copy blocked - try again'))
          }}>
            <span className="a"><LinkIcon size={15} /></span>
            <span className="b"><CheckIcon size={16} /></span>
          </button>
        </Tip>
        <Tip side="bottom" label={<b>Resolve</b>}>
          <button className="cm-icon" onClick={() => { void resolve(thread.id); setActive(null) }}><CheckSquareOffsetIcon size={16} /></button>
        </Tip>
        <Tip side="bottom" label={<b>Close</b>}>
          <button className="cm-icon" onClick={() => setActive(null)}><XIcon size={15} /></button>
        </Tip>
      </div>
      {/* "there is more": the scroller MASKS its own content at the overflowing edge - a soft fade
          of the text itself, not a paint layer over the glass */}
      <div className={`cm-scroll${shadows.top ? ' fade-top' : ''}${shadows.bot ? ' fade-bot' : ''}`} ref={scrollRef} onScroll={syncShadows}>
        <MessageHead author={thread.author} agent={thread.agent} agentMeta={thread.agentMeta} ts={thread.ts} />
        <CommentBody body={thread.body} owner={isOwner(thread.author)} />
        {/* replies repeat the root's exact message shape (Figma's pattern) - only the icons differ */}
        {thread.replies.map((r) => (
          <div key={r.id} className="cm-msg">
            <MessageHead author={r.author} agent={r.agent} agentMeta={r.agentMeta} ts={r.ts} />
            <CommentBody body={r.body} owner={isOwner(r.author)} />
          </div>
        ))}
      </div>
      {canComment ? (
        <div className="cm-compose">
          <ComposeAvatar />
          <CommentInput value={text} onChange={setText} onSubmit={submit} onCancel={() => setActive(null)} placeholder="Reply…" sendLabel="Send" owner={local} />
        </div>
      ) : (
        <button className="cm-signin-cta" onClick={() => useComments.setState({ needsIdentity: true })}>
          Sign in to comment
        </button>
      )}
    </div>
  )
  return card
}

/** The draft composer - shared by canvas and prototype, geometry via `bounds`, tinted with
 *  the picked element's hue. */
export function DraftComposer({ at, bounds, hue }: { at: { x: number; y: number }; bounds: { w: number; h: number }; hue?: number }) {
  const { create, setDraft } = useComments.getState()
  const local = useComments((s) => s.local)
  const [text, setText] = useState('')
  const flip = at.x > bounds.w * 0.55
  return (
    <div data-sh-wheel-local className={`cm-card cm-draft sh-no-pan${flip ? ' flip' : ''}`} style={{ left: at.x, top: Math.min(at.y + 14, bounds.h - 40), ...hueVars(hue) }}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="cm-compose">
        <ComposeAvatar />
        <CommentInput value={text} onChange={setText} onSubmit={() => create(text)} onCancel={() => setDraft(null)} placeholder="Comment on this element…" autoFocus sendLabel="Comment" owner={local} />
      </div>
    </div>
  )
}

/** Avatar picker: dashed circle → file input → client-side 128px downscale →
 *  data-URI preview. Optional everywhere it appears; never gates a CTA. */
function AvatarPick({ value, onPick }: { value: string; onPick: (dataUri: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const pick = (file: File | undefined) => {
    if (!file) return
    const img = new Image()
    img.onload = () => {
      const s = Math.min(img.width, img.height)
      const c = document.createElement('canvas')
      c.width = c.height = 128
      c.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128)
      onPick(c.toDataURL('image/jpeg', 0.85))
      URL.revokeObjectURL(img.src)
    }
    img.src = URL.createObjectURL(file)
  }
  return (
    <>
      <Tip side="top" label={<b>{value ? 'Change your photo' : 'Select your profile picture'}</b>}>
        <button className={`cm-pfp${value ? ' set' : ''}`} aria-label="Select your profile picture"
          style={value ? { backgroundImage: `url(${value})` } : undefined}
          onClick={() => fileRef.current?.click()}>{value ? '' : '+'}</button>
      </Tip>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
    </>
  )
}

/** Signed-out published viewer tried to comment (or arrived on an invite link).
 *  Invite link: a focused claim - the token in hand, email shown as a chip.
 *  Fallback: sign in (returning device), with a quiet switch to pasting a token.
 *  Primary CTAs stay disabled until their mandatory fields are filled; hovering
 *  the disabled button says what's missing (avatar never gates). */
export function IdentityDialog() {
  const needs = useComments((s) => s.needsIdentity)
  const invite = useComments((s) => s.inviteToken)
  const { signIn, claim, dismissIdentity } = useComments.getState()
  const [mode, setMode] = useState<'signin' | 'claim'>('signin')
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [token, setToken] = useState(''); const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('')
  const [invitedAs, setInvitedAs] = useState('')
  const [err, setErr] = useState<string | null>(null)
  // an invite link knows WHO it's for - show it (the token is the proof of holding)
  useEffect(() => {
    if (!needs || !invite) return setInvitedAs('')
    fetch(`${ROUTE}/api/invite-info?token=${encodeURIComponent(invite)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.email && setInvitedAs(d.email))
      .catch(() => { /* chip just stays hidden */ })
  }, [needs, invite])
  if (!needs) return null
  const claiming = !!invite || mode === 'claim'
  const ready = claiming
    ? !!(password.trim() && name.trim() && (invite || token.trim()))
    : !!(email.trim() && password.trim())
  const missing = claiming
    ? (invite ? 'Password and display name still needed' : 'Token, password, and display name still needed')
    : 'Fill in email and password'
  const go = async () => {
    if (!ready) return
    setErr(null)
    const e = claiming ? await claim(invite ?? token, password, name, avatar || undefined) : await signIn(email, password)
    if (e) return setErr(e)
    // a consumed invite link leaves the URL - the hash becomes the plain board view
    if (invite) writeHash({ board: useStore.getState().board })
  }
  const onEnter = (e: React.KeyboardEvent) => e.key === 'Enter' && void go()
  return (
    <div className="cm-modal-wrap" onClick={dismissIdentity}>
      <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{invite ? 'You’re invited to comment' : claiming ? 'Sign up to comment' : 'Sign in to comment'}</h2>
        <p className="dim">
          {invite
            ? <>Pick how you’ll appear - comments carry your name.</>
            : claiming
              ? <>Create your account with the invite token your admin sent you.</>
              : <>You’re in read-only. Sign in to your account to comment on this canvas.</>}
        </p>
        <div className="cm-fields">
          {claiming ? (
            <>
              {invite
                ? invitedAs && <div className="cm-chip"><b>{invitedAs}</b><span>INVITED</span></div>
                : <input placeholder="Invite token" value={token} onChange={(e) => setToken(e.target.value)} />}
              <input placeholder="Choose a password" type="password" autoComplete="new-password"
                value={password} onChange={(e) => setPassword(e.target.value)} />
              <hr className="cm-div" />
              <div className="cm-idrow">
                <AvatarPick value={avatar} onPick={setAvatar} />
                <input placeholder="Set a display name" style={{ flex: 1 }}
                  value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} />
              </div>
            </>
          ) : (
            <>
              <input placeholder="Email" type="email" autoComplete="email"
                value={email} onChange={(e) => setEmail(e.target.value)} />
              <input placeholder="Password" type="password" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={onEnter} />
            </>
          )}
        </div>
        {err && <span className="cm-err">{err}</span>}
        <div className="cm-row">
          {ready ? (
            <button className="cm-primary" onClick={() => void go()}>
              {claiming ? (invite ? 'Join the canvas' : 'Create account') : 'Sign in'}
            </button>
          ) : (
            <Tip side="top" label={<b>{missing}</b>}>
              <button className="cm-primary" disabled>
                {claiming ? (invite ? 'Join the canvas' : 'Create account') : 'Sign in'}
              </button>
            </Tip>
          )}
          <button onClick={dismissIdentity}>Not now</button>
        </div>
        {!invite && (
          <button className="cm-switch" onClick={() => { setErr(null); setMode(mode === 'signin' ? 'claim' : 'signin') }}>
            {mode === 'signin' ? 'Have an invite token instead?' : 'Already have an account? Sign in'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Open a thread by id: activate, select its node, fit the camera. True on success. */
export function revealThread(c: string): boolean {
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
let pendingThread: string | null = null   // cross-board deep link awaiting its board's comments
export function CommentsController() {
  const board = useStore((s) => s.board)
  const commentMode = useComments((s) => s.commentMode)
  const active = useComments((s) => s.active)

  // modal-style dismiss: any press outside the card (and outside the surfaces that
  // legitimately manage it - pins, stacks, the identity dialog) closes the thread
  useEffect(() => {
    if (!active) return
    const onDown = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest('.cm-card, .cm-pin, .cm-stack, .cm-modal')) return
      useComments.getState().setActive(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [active])

  useEffect(() => {
    const { load, live } = useComments.getState()
    void load(board).then(() => {
      // invite link (#/i/<token>): open the claim dialog with the token in hand -
      // unless this browser is already someone (their invite is not for this session)
      const s = useComments.getState()
      if (bootHash.invite && !s.local && !s.me && !s.inviteToken)
        useComments.setState({ inviteToken: bootHash.invite, needsIdentity: true })
      // a cross-board deep link parks its thread id here until the target board's
      // comments have actually loaded - a timer can't know how long that takes
      if (pendingThread && revealThread(pendingThread)) { pendingThread = null; return }
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
  // no reload, no boot path. Same board: the threads are in memory, reveal now.
  // Different board: park the id; the load effect above consumes it once the
  // board switch has fetched that board's comments.
  useEffect(() => {
    const onHash = (e: HashChangeEvent) => {
      // read the URL the EVENT carries, not location.hash: the shell's own
      // hashchange handler resets selection, whose projection synchronously
      // rewrites the hash - listener order decides which URL survives, and
      // e.newURL is immune to that race
      const h = parseHash(e.newURL ? new URL(e.newURL).hash : location.hash)
      if (h.invite) {
        const s = useComments.getState()
        if (!s.local && !s.me) useComments.setState({ inviteToken: h.invite, needsIdentity: true })
        return
      }
      if (!h.c) return
      if (!revealThread(h.c)) pendingThread = h.c
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // broadcast pick mode to every LIVE frame (laser rides along inside the bridge). Scoped to
  // .sh-live so the SPEC-M5 lean cover (.sh-lean, a scriptless snapshot) is never messaged.
  useEffect(() => {
    for (const f of document.querySelectorAll('iframe.sh-live'))
      (f as HTMLIFrameElement).contentWindow?.postMessage({ type: 'sh:pick', on: commentMode }, location.origin)
  }, [commentMode])

  return <IdentityDialog />
}
