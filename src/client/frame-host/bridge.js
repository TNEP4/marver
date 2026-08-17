// Shared frame bridge. TSX frames import it plainly; the plugin injects it into HTML frames
// with ?html=1, which turns on theme-from-query and auto-ready (TSX posts its own ready after boot).
//
// The laser / comment-pick / anchor / highlight machinery lives in ./inspect.js and is
// shared with the prototype stage; this bridge owns the canvas-frame concerns around it:
// theme, wheel ownership, the interaction lease, data-goto, and error reporting.
import { createInspect } from './inspect.js'

const isHtmlFrame = new URL(import.meta.url).searchParams.get('html') === '1'
// same-origin parent (the shell): a fixed target origin keeps posts (incl. picked anchor
// bundles) from leaking if this frame is ever navigated cross-origin
const post = (msg) => { if (window.parent !== window) window.parent.postMessage(msg, location.origin) }
const id = new URLSearchParams(location.search).get('id') ?? location.pathname

// SPEC-M5: the shell serialises this frame's DOM (same origin) for the lean facade. Open shadow roots
// are walkable, but a CLOSED root is invisible after the fact - flag it at creation so the serialiser
// degrades the frame (keeps it live) instead of shipping a lean copy missing its shadow content.
const _attachShadow = Element.prototype.attachShadow
if (_attachShadow) Element.prototype.attachShadow = function (init) {
  if (init && init.mode === 'closed') window.__mvClosedShadow = true
  return _attachShadow.call(this, init)
}

// theme lands as BOTH signals: [data-theme] plus the `dark` class Tailwind/shadcn key on
const setTheme = (theme) => {
  document.documentElement.dataset.theme = theme
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

if (isHtmlFrame) {
  const theme = new URLSearchParams(location.search).get('theme')
  if (theme) setTheme(theme)
}

// A6: report transient laser/comment engagement (pointer inside this frame AND a mode on) so the
// shell leases the frame - a hot update to it then defers until the pointer leaves or the mode
// ends, instead of yanking the user mid-inspect/mid-comment.
let pointerInside = false
let interactiveOn = false            // B0.2: set by sh:interactive - the play/interact target owns its own wheel
const reportInteraction = () => post({ type: 'sh:interaction', id, laser: pointerInside && inspect.isLaser(), comment: pointerInside && inspect.isPick() })

// laser / pick / anchor / highlight - one shared controller (see inspect.js). The id is
// static here (one iframe per frame); onModeChange re-reports the lease when a mode flips.
const inspect = createInspect({ post, getId: () => id, onModeChange: () => reportInteraction() })

document.addEventListener('mouseover', () => { if (!pointerInside) { pointerInside = true; reportInteraction() } })
document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) { pointerInside = false; reportInteraction() } })
window.addEventListener('blur', () => { if (pointerInside) { pointerInside = false; reportInteraction() } })

document.addEventListener('click', (e) => {
  // laser/comment mode owns every click - a goto link must not ALSO navigate
  // (both handlers capture on document, so stopPropagation can't referee)
  if (inspect.modeActive()) return
  const el = e.target instanceof Element ? e.target.closest('[data-goto]') : null
  if (!el) return
  e.preventDefault()
  const target = el.getAttribute('data-goto')
  if (target) post({ type: 'sh:go', target })
}, true)

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') post({ type: 'sh:exit-interact' }) })

window.addEventListener('error', (e) => post({ type: 'sh:error', id, message: String(e.message || e.error) }))
window.addEventListener('unhandledrejection', (e) => post({ type: 'sh:error', id, message: `unhandled rejection: ${e.reason}` }))

window.addEventListener('message', (e) => {
  // commands come from the SHELL (parent) only - embedded app content must not flip the theme
  if (e.source !== window.parent || window.parent === window) return
  if (e.origin && e.origin !== location.origin) return   // a navigated frame must not spoof commands
  if (e?.data?.type === 'sh:set-theme') setTheme(e.data.theme)
  // B0.2: interact/play target owns its own wheel; passive frames forward it to the canvas
  if (e?.data?.type === 'sh:interactive') { interactiveOn = !!e.data.on }
})

if (isHtmlFrame) {
  const ready = () => post({ type: 'sh:ready', id })
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', ready) : ready()
}

// B0.2 wheel ownership. A frame is either the interact/play target (the APP owns wheel -
// its own scroll) or passive (laser/comment/plain view - the CANVAS owns wheel). Wheel
// events land in the iframe's document, so the shell can't see them: when passive we
// forward them to the shell, when interactive we leave them for the app (only blocking
// the browser's own ctrl/meta page pinch-zoom). preventing here is mandatory - the parent
// gets the forwarded message too late to cancel the iframe's own scroll.
window.addEventListener('wheel', (e) => {
  if (interactiveOn) { if (e.ctrlKey || e.metaKey) e.preventDefault(); return }
  e.preventDefault()
  e.stopImmediatePropagation()
  post({ type: 'sh:wheel', id, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
    ctrlKey: e.ctrlKey, metaKey: e.metaKey, clientX: e.clientX, clientY: e.clientY })
}, { capture: true, passive: false })
document.addEventListener('gesturestart', (e) => e.preventDefault())
// a nested scroll container hitting its boundary must not chain into the shell page
document.documentElement.style.overscrollBehavior = 'contain'
