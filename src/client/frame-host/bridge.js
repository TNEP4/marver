// Shared frame bridge. TSX frames import it plainly; the plugin injects it into HTML frames
// with ?html=1, which turns on theme-from-query and auto-ready (TSX posts its own ready after boot).
const isHtmlFrame = new URL(import.meta.url).searchParams.get('html') === '1'
const post = (msg) => { if (window.parent !== window) window.parent.postMessage(msg, '*') }
const id = new URLSearchParams(location.search).get('id') ?? location.pathname

if (isHtmlFrame) {
  const theme = new URLSearchParams(location.search).get('theme')
  if (theme) document.documentElement.dataset.theme = theme
}

document.addEventListener('click', (e) => {
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
  if (e?.data?.type === 'sh:set-theme') document.documentElement.dataset.theme = e.data.theme
})

if (isHtmlFrame) {
  const ready = () => post({ type: 'sh:ready', id })
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', ready) : ready()
}

// pinch inside a frame must not zoom the parent PAGE (wheel events here belong to the
// iframe's document, so the shell's blocker cannot see them). Keyboard cmd +/- untouched.
window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }, { passive: false })
document.addEventListener('gesturestart', (e) => e.preventDefault())
