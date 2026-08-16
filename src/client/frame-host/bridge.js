// Shared frame bridge. TSX frames import it plainly; the plugin injects it into HTML frames
// with ?html=1, which turns on theme-from-query and auto-ready (TSX posts its own ready after boot).
const isHtmlFrame = new URL(import.meta.url).searchParams.get('html') === '1'
const post = (msg) => { if (window.parent !== window) window.parent.postMessage(msg, '*') }
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

document.addEventListener('click', (e) => {
  // laser/comment mode owns every click - a goto link must not ALSO navigate
  // (both handlers capture on document, so stopPropagation can't referee)
  if (modeActive()) return
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
  if (e?.data?.type === 'sh:set-theme') setTheme(e.data.theme)
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
let interactiveOn = false
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

// ---- laser mode + element picking (SPEC-M3 §5, §7) ----------------------------------
// Laser: one injected stylesheet, outline only (zero layout shift), depth-based hue -
// each nesting level steps 60° around the wheel, cycling at 6. Picking: laser plus a
// click interception that captures the anchor bundle and posts it to the shell.

const LASER_ID = 'mv-laser-style'
// comment-mode cursor: the pin's teardrop in the comment green, duotone (dark rim,
// lighter inner) with a white halo ring so it pops on any content; hotspot at the tail
const PICK_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 256 256'%3E%3Cpath d='M132,24A100.11,100.11,0,0,0,32,124v84a16,16,0,0,0,16,16h84a100,100,0,0,0,0-200Z' fill='none' stroke='%23fff' stroke-width='40'/%3E%3Cpath d='M132,24A100.11,100.11,0,0,0,32,124v84a16,16,0,0,0,16,16h84a100,100,0,0,0,0-200Z' fill='%2334c759' stroke='%231f8a3d' stroke-width='12'/%3E%3Ccircle cx='138' cy='118' r='46' fill='%23fff' opacity='.32'/%3E%3C/svg%3E") 4 21, crosshair`
// laser-mode cursor: the crosshair reticle in accent blue with a white halo ring,
// hotspot dead center
const LASER_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 256 256'%3E%3Cg stroke='%23fff' stroke-width='46' fill='none'%3E%3Ccircle cx='128' cy='128' r='56'/%3E%3Cpath d='M128 24 V56 M128 200 V232 M24 128 H56 M200 128 H232' stroke-linecap='round'/%3E%3C/g%3E%3Cg stroke='%230088ff' stroke-width='20' fill='none'%3E%3Ccircle cx='128' cy='128' r='56'/%3E%3Cpath d='M128 24 V56 M128 200 V232 M24 128 H56 M200 128 H232' stroke-linecap='round'/%3E%3C/g%3E%3Ccircle cx='128' cy='128' r='16' fill='%230088ff' stroke='%23fff' stroke-width='8'/%3E%3C/svg%3E") 12 12, crosshair`
const laserCss = () => {
  // depth via unrolled descendant combinators - CSS custom properties cannot cycle
  let rules = 'body { --mv-hue: 0 }\n'
  for (let d = 1; d <= 12; d++)
    rules += `body ${'> * '.repeat(d)}{ --mv-hue: ${(d % 6) * 60} }\n`
  // full rainbow only in laser mode; comment mode keeps just the hover highlight
  // (understand what you'd click without the whole board shouting). The label and
  // its children are chrome, never subjects - no outlines on them.
  if (laserOn)
    rules += 'body *:not(script):not(style):not(#mv-laser-label):not(#mv-laser-label *) { outline: 1px solid hsl(var(--mv-hue) 85% 55% / .75); outline-offset: -1px }\n'
  // comment cursor wins when both modes are on (comment owns the click)
  if (pickOn || laserOn)
    rules += `body, body * { cursor: ${pickOn ? PICK_CURSOR : LASER_CURSOR} !important }\n`
  return rules + `
body [data-mv-hover] { outline: 2px solid hsl(var(--mv-hue) 95% 45%); outline-offset: -2px;
  background-image: linear-gradient(hsl(var(--mv-hue) 95% 50% / .08), hsl(var(--mv-hue) 95% 50% / .08)) }
#mv-laser-label { position: fixed; z-index: 2147483647; pointer-events: none; outline: none !important;
  display: flex; align-items: center; gap: 5px; width: max-content;
  font: 600 10px -apple-system, system-ui, sans-serif; color: #fff; background: rgba(20, 20, 24, .92);
  padding: 3px 7px; border-radius: 5px; max-width: 340px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; letter-spacing: .01em }
#mv-laser-label svg { flex: none; display: block; outline: none !important }
#mv-laser-label.mv-copied { animation: mv-pop .22s cubic-bezier(.32, .72, .35, 1) }
@keyframes mv-pop { from { transform: scale(.85); opacity: .5 } }
`
}

// filled clipboard with a check inside (Phosphor clipboard-fill + check): the label
// wears this while confirming a copy
const COPIED_HTML = `<svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M200,32H163.74a47.92,47.92,0,0,0-71.48,0H56A16,16,0,0,0,40,48V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32Zm-72,0a32,32,0,0,1,32,32H96A32,32,0,0,1,128,32Z"/><path d="M92 150l26 26 48-54" fill="none" stroke="rgba(20,20,24,.92)" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Element path copied</span>`

let laserOn = false, pickOn = false, hoverEl = null, labelEl = null
const modeActive = () => laserOn || pickOn

// A6: report transient laser/comment engagement (pointer inside this frame AND a mode on) so the
// shell leases the frame - a hot update to it then defers until the pointer leaves or the mode
// ends, instead of yanking the user mid-inspect/mid-comment.
let pointerInside = false
const reportInteraction = () => post({ type: 'sh:interaction', id, laser: pointerInside && laserOn, comment: pointerInside && pickOn })
document.addEventListener('mouseover', () => { if (!pointerInside) { pointerInside = true; reportInteraction() } })
document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) { pointerInside = false; reportInteraction() } })
window.addEventListener('blur', () => { if (pointerInside) { pointerInside = false; reportInteraction() } })

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

let copiedTimer = null

const clearHover = () => {
  if (hoverEl) { delete hoverEl.dataset.mvHover; hoverEl = null }
  if (labelEl) { labelEl.remove(); labelEl = null }
  clearTimeout(copiedTimer)
}

// the shell confirmed the clipboard write - the hover label ITSELF says so (a
// corner toast is too far from where the eyes are), then reverts after 2s.
// The seq + element check keeps a slow ack from decorating a DIFFERENT label
// (pointer moved on, or laser was retoggled, before writeText resolved).
const showCopied = (seq) => {
  if (seq !== copySeq || hoverEl !== copyEl) return
  if (!labelEl) return
  labelEl.classList.add('mv-copied')
  labelEl.innerHTML = COPIED_HTML
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    if (!labelEl) return
    labelEl.classList.remove('mv-copied')
    if (hoverEl) labelEl.textContent = describe(hoverEl)
    else { labelEl.remove(); labelEl = null }
  }, 2000)
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
// label rides to the RIGHT of the cursor, vertically centered on it - below-right
// hid the pointer's target; flips to the left when the right edge runs out
const place = (label, e) => {
  const pad = 18
  const w = label.offsetWidth, h = label.offsetHeight
  let x = e.clientX + pad
  if (x + w > innerWidth - 4) x = Math.max(4, e.clientX - pad - w)
  label.style.left = x + 'px'
  label.style.top = Math.min(Math.max(4, e.clientY - h / 2), innerHeight - h - 4) + 'px'
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

// every press is reported (tiny message, capture, nothing prevented): the shell
// uses it to close an open thread card when the click lands INSIDE a frame -
// shell-document listeners can never see those
document.addEventListener('pointerdown', () => post({ type: 'sh:frame-down', id }), true)

let copySeq = 0, copyEl = null
document.addEventListener('click', (e) => {
  if (!modeActive()) return
  e.preventDefault()
  e.stopPropagation()
  const el = e.target instanceof Element && e.target.closest('body *:not(#mv-laser-label)')
  if (!el) return
  // comment mode wins when both are on; plain laser click hands the agent an
  // exact address - frame file + css path (+ source loc when the build stamps one)
  if (pickOn) post({ type: 'sh:picked', id, anchor: anchorBundle(el, e) })
  else {
    copyEl = el
    post({ type: 'sh:laser-copy', id, seq: ++copySeq, path: cssPath(el), source: el.dataset.mvLoc ?? null })
  }
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
  if (m.type === 'sh:laser') { laserOn = !!m.on; applyModes(); reportInteraction() }
  if (m.type === 'sh:pick') { pickOn = !!m.on; applyModes(); reportInteraction() }
  // B0.2: interact/play target owns its own wheel; passive frames forward it to the canvas
  if (m.type === 'sh:interactive') { interactiveOn = !!m.on }
  if (m.type === 'sh:copy-ok') showCopied(m.seq)
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
