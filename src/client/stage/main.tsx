/**
 * The stage - play mode's single mount (SPEC-M2 §1). Unlike the frame host (one iframe
 * per frame), the stage keeps ONE tree mounted - providers + layout chain - and swaps
 * only the innermost frame on data-goto, so app shells in _layout persist across
 * navigation like a real app. Swaps ride document.startViewTransition when available;
 * agents opt into shared-element morphs with plain view-transition-name CSS.
 *
 * The shell owns chrome, device sizing, walk order, and the URL; the stage owns data-goto:
 *   stage -> shell:  sh:stage-ready · sh:stage-at {at} · sh:stage-exit · sh:stage-error
 *                    sh:stage-key {key, code} (forwarded shortcuts) · sh:stage-edge {hot} (fill-mode corner hover)
 *   shell -> stage:  sh:stage-set {at} (history / walk / restart) · sh:set-theme
 */
import { Component, createElement, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { frameFile, frames, layoutChain, layouts, providers } from '../frame-host/registry.ts'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') ?? 'light'
const startId = params.get('at') ?? ''

const post = (msg: Record<string, unknown>) => { if (window.parent !== window) window.parent.postMessage(msg, '*') }

window.addEventListener('error', (e) => post({ type: 'sh:stage-error', message: String(e.message || e.error) }))
window.addEventListener('unhandledrejection', (e) => post({ type: 'sh:stage-error', message: `unhandled rejection: ${e.reason}` }))
// pinch inside the stage must not zoom the parent page (same rule as the frame bridge)
window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }, { passive: false })
document.addEventListener('gesturestart', (e) => e.preventDefault())

interface Mounted { id: string; Frame: ComponentType; wrappers: ComponentType[] }

/** Resolve a frame id to its component + wrapper chain. Modules are import()-cached by
 *  Vite, so re-resolving a chain yields the SAME component references - React keeps
 *  unchanged layout instances mounted across swaps, which is the whole point. */
async function resolve(id: string): Promise<Mounted> {
  const fileKey = frameFile(id)
  if (!fileKey) throw new Error(`unknown frame id "${id}"`)
  const mod: any = await frames[fileKey]()
  if (mod.default == null) throw new Error(`${fileKey} has no default export`)
  const wrappers: ComponentType[] = []
  const providerKey = Object.keys(providers)[0]
  if (providerKey) wrappers.push((await providers[providerKey]() as any).default)
  for (const lk of layoutChain(fileKey)) wrappers.push((await layouts[lk]() as any).default)
  return { id, Frame: mod.default, wrappers: wrappers.filter((w) => w != null) }
}

class Boundary extends Component<{ resetKey: string; children?: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null })
  }
  componentDidCatch(err: Error) { post({ type: 'sh:stage-error', message: err.message }) }
  render() {
    if (!this.state.err) return this.props.children
    return createElement(ErrorCard, { title: 'frame crashed', message: this.state.err.message, detail: this.props.resetKey })
  }
}

function ErrorCard({ title, message, detail }: { title: string; message: string; detail: string }) {
  return createElement('div', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 12, padding: 16, color: '#ff8a80' } },
    createElement('div', { style: { fontWeight: 700, marginBottom: 8 } }, title),
    createElement('div', { style: { whiteSpace: 'pre-wrap' } }, message),
    createElement('div', { style: { marginTop: 8, color: '#7c859a' } }, detail),
  )
}

function Stage() {
  const [mounted, setMounted] = useState<Mounted | null>(null)
  const [err, setErr] = useState<{ id: string; message: string } | null>(null)
  const current = useRef(startId)
  const swapSeq = useRef(0)

  /** Swap to a frame. `announce` posts sh:stage-at (user-driven); history restores stay silent. */
  const goto = async (id: string, announce: boolean) => {
    if (id === current.current && mounted && !err) return
    const seq = ++swapSeq.current
    try {
      const next = await resolve(id)
      if (seq !== swapSeq.current) return       // a newer swap superseded this one
      current.current = id
      // startViewTransition runs its callback async - recheck the seq there too, or an
      // older pending transition could commit stale state over a newer navigation
      const apply = () => { if (seq === swapSeq.current) flushSync(() => { setErr(null); setMounted(next) }) }
      if (document.startViewTransition) document.startViewTransition(apply)
      else { apply(); document.getElementById('root')?.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' }) }
      if (announce) post({ type: 'sh:stage-at', at: id })
    } catch (e) {
      if (seq !== swapSeq.current) return
      current.current = id
      setErr({ id, message: (e as Error).message })
      post({ type: 'sh:stage-error', message: (e as Error).message })
      if (announce) post({ type: 'sh:stage-at', at: id })
    }
  }

  useEffect(() => {
    goto(startId, false)
    post({ type: 'sh:stage-ready', at: startId })

    // data-goto is handled HERE, in place - never posted up as sh:go (capture phase
    // beats any frame handler; preventDefault stops real <a href> navigations)
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest('[data-goto]') : null
      if (!el) return
      e.preventDefault()
      e.stopPropagation()
      const target = el.getAttribute('data-goto')
      if (target) goto(target, true)
    }
    document.addEventListener('click', onClick, true)

    const onKey = (e: KeyboardEvent) => {
      // Escape always exits, even mid-typing (matches the canvas bridge)
      if (e.key === 'Escape') { post({ type: 'sh:stage-exit' }); return }
      if (e.metaKey || e.ctrlKey) return       // ⌘D is the browser's bookmark, not our theme
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      // every play shortcut belongs to the shell (it owns walk order + chrome) - forward
      if (/^Digit[0-9]$/.test(e.code) || ['d', 'h', 'r', 'ArrowRight', 'ArrowLeft'].includes(e.key))
        post({ type: 'sh:stage-key', key: e.key, code: e.code })
    }
    window.addEventListener('keydown', onKey)

    // fill mode covers the window with this iframe, so the shell cannot see corner
    // hovers - report enter/leave of the reveal corners (top-right, bottom-left)
    let edgeHot = false
    const onMove = (e: PointerEvent) => {
      const hot = (e.clientX > innerWidth - 220 && e.clientY < 90) || (e.clientX < 220 && e.clientY > innerHeight - 90)
      if (hot !== edgeHot) { edgeHot = hot; post({ type: 'sh:stage-edge', hot }) }
    }
    window.addEventListener('pointermove', onMove)

    const onMsg = (e: MessageEvent) => {
      if (e.source !== window.parent) return
      const data = e.data
      if (data?.type === 'sh:set-theme') document.documentElement.dataset.theme = data.theme
      else if (data?.type === 'sh:stage-set' && typeof data.at === 'string') goto(data.at, false)
    }
    window.addEventListener('message', onMsg)

    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('message', onMsg)
    }
  }, [])

  if (err) return createElement(ErrorCard, { title: 'frame failed', message: err.message, detail: err.id })
  if (!mounted) return null
  // identical wrapper references across swaps -> React preserves layout state; a chain
  // that differs at depth k legitimately remounts everything below (SPEC-M2 §1)
  let tree: ReactNode = createElement(mounted.Frame)
  for (const W of [...mounted.wrappers].reverse()) tree = createElement(W, null, tree)
  return createElement(Boundary, { resetKey: mounted.id }, tree)
}

async function boot() {
  try {
    await import('virtual:sh-theme' as string)
    createRoot(document.getElementById('root')!).render(createElement(Stage))
  } catch (err) {
    post({ type: 'sh:stage-error', message: (err as Error).message })
    document.getElementById('root')!.innerHTML =
      `<div style="font-family:ui-monospace,monospace;font-size:12px;padding:16px;color:#ff8a80">stage failed: ${String((err as Error).message).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</div>`
  }
}

boot()
