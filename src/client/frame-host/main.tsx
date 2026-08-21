/**
 * The frame host - runs inside every iframe. Spec §6.
 * Boot failures (theme, providers, layouts, the frame itself) render a plain-DOM error card
 * and post sh:error; an ErrorBoundary catches render-time throws the same way.
 */
import { Component, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import './bridge.js'
import { frameFile, frames, layoutChain, layouts, providers } from './registry.ts'

const params = new URLSearchParams(location.search)
const id = params.get('id') ?? ''
const theme = params.get('theme') ?? 'light'
// Both signals, always: [data-theme] for token systems keyed on the attribute, and the
// `dark` class for Tailwind/shadcn (`@custom-variant dark (&:is(.dark *))` never sees a
// data attribute). The bridge applies the same pair on sh:set-theme.
document.documentElement.dataset.theme = theme
document.documentElement.classList.toggle('dark', theme === 'dark')

const post = (msg: Record<string, unknown>) => { if (window.parent !== window) window.parent.postMessage(msg, '*') }

// A render failure posts sh:error to the shell, but a HEADLESS screenshot has no shell to
// hear it - so also stamp the error on the document, where the shot capture can read it.
// This is what lets `marver shot` / the file-drop result report "the frame crashed" to an
// agent that cannot see the PNG (only the JSON), instead of a clean-looking ok:true.
const markError = (message: string) => { (window as any).__mvFrameError = message }

function fail(message: string) {
  markError(message)
  post({ type: 'sh:error', id, message })
  document.getElementById('root')!.innerHTML =
    `<div style="font-family:ui-monospace,monospace;font-size:12px;padding:16px;color:#b42318">
       <div style="font-weight:700;margin-bottom:8px">frame failed</div>
       <div style="white-space:pre-wrap">${escapeHtml(message)}</div>
       <div style="margin-top:8px;color:#7c859a">${escapeHtml(frameFile(id) ?? id)}</div>
     </div>`
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  componentDidCatch(err: Error) { markError(err.message); post({ type: 'sh:error', id, message: err.message }) }
  render() {
    if (!this.state.err) return this.props.children
    return createElement('div', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 12, padding: 16, color: '#b42318' } },
      createElement('div', { style: { fontWeight: 700, marginBottom: 8 } }, 'frame crashed'),
      createElement('div', { style: { whiteSpace: 'pre-wrap' } }, this.state.err.message),
      createElement('div', { style: { marginTop: 8, color: '#7c859a' } }, frameFile(id) ?? id),
    )
  }
}

async function boot() {
  try {
    await import('virtual:sh-theme' as string)

    const fileKey = frameFile(id)
    // Honest copy: the id usually IS valid on disk - this document's frame registry is
    // what's stale (file just added/renamed, or the dev server restarted). See #20.
    if (!fileKey) return fail(`frame "${id}" is not in this canvas's registry yet - the file was likely just added or renamed. The canvas should recover on its own; if this card persists, reload it.`)

    const frameMod: any = await frames[fileKey]()
    const Frame = frameMod.default
    // No typeof gate: memo()/forwardRef() components are objects, not functions.
    // React + the ErrorBoundary validate the element type better than we can.
    if (Frame == null) return fail(`${fileKey} has no default export`)

    const wrappers: any[] = []
    const providerKey = Object.keys(providers)[0]
    if (providerKey) wrappers.push((await providers[providerKey]() as any).default)
    for (const lk of layoutChain(fileKey)) wrappers.push((await layouts[lk]() as any).default)

    let tree: ReactNode = createElement(Frame)
    for (const W of wrappers.reverse()) if (W != null) tree = createElement(W, null, tree)

    createRoot(document.getElementById('root')!).render(createElement(Boundary, null, tree))
    post({ type: 'sh:ready', id, meta: frameMod.meta && typeof frameMod.meta === 'object' ? frameMod.meta : undefined })
  } catch (err) {
    fail((err as Error).message)
  }
}

boot()
