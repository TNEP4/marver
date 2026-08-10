// Shared frame bridge (plain JS: imported by the TSX host, injected into HTML frames).
// data-goto clicks, error forwarding, theme switching, interact-exit keys. Spec §6.
const post = (msg) => { if (window.parent !== window) window.parent.postMessage(msg, '*') }
const id = new URLSearchParams(location.search).get('id') ?? location.pathname

document.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-goto]') : null
  if (!el) return
  e.preventDefault()
  const target = el.getAttribute('data-goto')
  if (target) post({ type: 'sh:go', target })
}, true)

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') post({ type: 'sh:exit-interact' }) })
document.addEventListener('dblclick', () => post({ type: 'sh:dblclick' }))

window.addEventListener('error', (e) => post({ type: 'sh:error', id, message: String(e.message || e.error) }))
window.addEventListener('unhandledrejection', (e) => post({ type: 'sh:error', id, message: `unhandled rejection: ${e.reason}` }))

window.addEventListener('message', (e) => {
  if (e?.data?.type === 'sh:set-theme') document.documentElement.dataset.theme = e.data.theme
})

// HTML frames have no TSX host to announce them; the host sets __SH_TSX__ before importing this.
if (!window.__SH_TSX__) {
  const ready = () => post({ type: 'sh:ready', id })
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', ready) : ready()
}
