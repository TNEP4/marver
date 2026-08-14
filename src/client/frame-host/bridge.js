// Shared frame bridge. TSX frames import it plainly; the plugin injects it into HTML frames
// with ?html=1, which turns on theme-from-query and auto-ready (TSX posts its own ready after boot).
const isHtmlFrame = new URL(import.meta.url).searchParams.get('html') === '1'
const post = (msg) => { if (window.parent !== window) window.parent.postMessage(msg, '*') }
const id = new URLSearchParams(location.search).get('id') ?? location.pathname

// theme lands as BOTH signals: [data-theme] plus the `dark` class Tailwind/shadcn key on
const setTheme = (theme) => {
  document.documentElement.dataset.theme = theme
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

if (isHtmlFrame) {
  const theme = new URLSearchParams(location.search).get('theme')
  if (theme) setTheme(theme)
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
  if (e?.data?.type === 'sh:set-theme') setTheme(e.data.theme)
})

if (isHtmlFrame) {
  const ready = () => post({ type: 'sh:ready', id })
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', ready) : ready()
}

// pinch inside a frame must not zoom the parent PAGE (wheel events here belong to the
// iframe's document, so the shell's blocker cannot see them). Keyboard cmd +/- untouched.
window.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault() }, { passive: false })
document.addEventListener('gesturestart', (e) => e.preventDefault())

// ---- laser mode + element picking (SPEC-M3 §5, §7) ----------------------------------
// Laser: one injected stylesheet, outline only (zero layout shift), depth-based hue -
// each nesting level steps 60° around the wheel, cycling at 6. Picking: laser plus a
// click interception that captures the anchor bundle and posts it to the shell.

const LASER_ID = 'mv-laser-style'
// comment-mode cursor: the pin's chat-teardrop, hotspot at the tail
const PICK_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 256 256'%3E%3Cpath d='M132,24A100.11,100.11,0,0,0,32,124v84a16,16,0,0,0,16,16h84a100,100,0,0,0,0-200Z' fill='%2318181b' stroke='%23fff' stroke-width='16'/%3E%3C/svg%3E") 4 21, crosshair`
const laserCss = () => {
  // depth via unrolled descendant combinators - CSS custom properties cannot cycle
  let rules = 'body { --mv-hue: 0 }\n'
  for (let d = 1; d <= 12; d++)
    rules += `body ${'> * '.repeat(d)}{ --mv-hue: ${(d % 6) * 60} }\n`
  // full rainbow only in laser mode; comment mode keeps just the hover highlight
  // (understand what you'd click without the whole board shouting)
  if (laserOn)
    rules += 'body *:not(script):not(style) { outline: 1px solid hsl(var(--mv-hue) 85% 55% / .75); outline-offset: -1px }\n'
  if (pickOn)
    rules += `body, body * { cursor: ${PICK_CURSOR} !important }\n`
  return rules + `
body [data-mv-hover] { outline: 2px solid hsl(var(--mv-hue) 95% 45%); outline-offset: -2px;
  background-image: linear-gradient(hsl(var(--mv-hue) 95% 50% / .08), hsl(var(--mv-hue) 95% 50% / .08)) }
#mv-laser-label { position: fixed; z-index: 2147483647; pointer-events: none; outline: none !important;
  font: 600 10px -apple-system, system-ui, sans-serif; color: #fff; background: rgba(20, 20, 24, .92);
  padding: 3px 7px; border-radius: 5px; max-width: 340px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; letter-spacing: .01em }
`
}

let laserOn = false, pickOn = false, hoverEl = null, labelEl = null
const modeActive = () => laserOn || pickOn

// laser and pick are independent looks over shared hover machinery: the stylesheet
// is regenerated on every flip so each mode contributes exactly its own rules
const applyModes = () => {
  const cur = document.getElementById(LASER_ID)
  if (!modeActive()) {
    if (cur) cur.remove()
    clearHover()
    return
  }
  const s = cur ?? document.createElement('style')
  s.id = LASER_ID
  s.textContent = laserCss()
  if (!cur) document.head.appendChild(s)
}

const clearHover = () => {
  if (hoverEl) { delete hoverEl.dataset.mvHover; hoverEl = null }
  if (labelEl) { labelEl.remove(); labelEl = null }
}

const describe = (el) => {
  const tag = el.tagName.toLowerCase()
  const loc = el.dataset.mvLoc
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
  return loc ? `${tag} · ${loc}` : text ? `${tag} · “${text}”` : tag
}

document.addEventListener('mousemove', (e) => {
  if (!modeActive()) return
  const el = e.target instanceof Element && e.target.closest('body *:not(#mv-laser-label)')
  if (!el || el === hoverEl) { if (labelEl && hoverEl) place(labelEl, e); return }
  clearHover()
  hoverEl = el
  el.dataset.mvHover = '1'
  labelEl = document.createElement('div')
  labelEl.id = 'mv-laser-label'
  labelEl.textContent = describe(el)
  document.body.appendChild(labelEl)
  place(labelEl, e)
}, true)
const place = (label, e) => {
  const pad = 14
  label.style.left = Math.min(e.clientX + pad, innerWidth - label.offsetWidth - 4) + 'px'
  label.style.top = Math.min(e.clientY + pad, innerHeight - label.offsetHeight - 4) + 'px'
}

// the anchor bundle (SPEC-M3 §5): every rung captured at pick time
const cssPath = (el) => {
  const seg = []
  for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
    if (cur.id) { seg.unshift(`#${CSS.escape(cur.id)}`); break }
    const tag = cur.tagName.toLowerCase()
    let n = 1
    for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling)
      if (sib.tagName === cur.tagName) n++
    seg.unshift(n > 1 ? `${tag}:nth-of-type(${n})` : tag)
  }
  return seg.join(' > ')
}
const anchorBundle = (el, e) => {
  const r = el.getBoundingClientRect()
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
  return {
    el: {
      semantics: {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? undefined,
        ariaLabel: el.getAttribute('aria-label') ?? undefined,
        testId: el.getAttribute('data-testid') ?? undefined,
        quote: text.slice(0, 200) || undefined,
      },
      cssPath: cssPath(el),
      source: el.dataset.mvLoc ?? undefined,
    },
    pos: {
      fx: r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : .5,
      fy: r.height ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : .5,
    },
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },   // frame-viewport coords for the shell's pin math
  }
}

document.addEventListener('click', (e) => {
  if (!modeActive()) return
  e.preventDefault()
  e.stopPropagation()
  const el = e.target instanceof Element && e.target.closest('body *:not(#mv-laser-label)')
  if (!el) return
  // comment mode wins when both are on; plain laser click hands the agent an
  // exact address - frame file + css path (+ source loc when the build stamps one)
  if (pickOn) post({ type: 'sh:picked', id, anchor: anchorBundle(el, e) })
  else post({ type: 'sh:laser-copy', id, path: cssPath(el), source: el.dataset.mvLoc ?? null })
}, true)

/** Resolve a stored anchor back to a rect (the ladder, §5): semantics-verified CSS
 *  path first, then testId, then a quote scan; null = orphan. Every check compares
 *  the FULL captured semantics - two textless buttons must not swap silently. */
const resolveAnchor = (anchor) => {
  const want = anchor?.el?.semantics ?? {}
  const match = (el) => {
    if (want.tag && el.tagName.toLowerCase() !== want.tag) return false
    if (want.role && el.getAttribute('role') !== want.role) return false
    if (want.ariaLabel && el.getAttribute('aria-label') !== want.ariaLabel) return false
    if (want.testId && el.getAttribute('data-testid') !== want.testId) return false
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
    if (want.quote && !(text.startsWith(want.quote.slice(0, 60)) || text.includes(want.quote.slice(0, 40)))) return false
    return true
  }
  try {
    const byPath = anchor?.el?.cssPath && document.querySelector(anchor.el.cssPath)
    if (byPath && match(byPath)) return byPath
  } catch { /* stale selector */ }
  try {
    if (want.testId) {
      const el = document.querySelector(`[data-testid="${CSS.escape(want.testId)}"]`)
      if (el && match(el)) return el
    }
    if (want.quote && typeof want.tag === 'string' && /^[a-z][a-z0-9-]*$/.test(want.tag)) {
      for (const el of document.querySelectorAll(want.tag))
        if (match(el)) return el
    }
  } catch { /* malformed semantics must not sink the whole batch */ }
  return null
}

window.addEventListener('message', (e) => {
  // commands come from the SHELL only - the parent window. Anything else (nested
  // third-party iframes, a hijacked opener) is ignored.
  if (e.source !== window.parent || window.parent === window) return
  const m = e?.data
  if (!m || typeof m !== 'object') return
  // independent toggles - each mode contributes its own rules, applyModes composes
  if (m.type === 'sh:laser') { laserOn = !!m.on; applyModes() }
  if (m.type === 'sh:pick') { pickOn = !!m.on; applyModes() }
  if (m.type === 'sh:resolve-anchors' && Array.isArray(m.anchors)) {
    const rects = m.anchors.slice(0, 200).map((a) => {
      let el = null
      try { el = resolveAnchor(a.anchor) } catch { /* one bad anchor, not the batch */ }
      if (!el) return { key: a.key, orphan: true }
      const r = el.getBoundingClientRect()
      return { key: a.key, rect: { x: r.left, y: r.top, w: r.width, h: r.height } }
    })
    post({ type: 'sh:anchor-rects', id, rects })
  }
})
