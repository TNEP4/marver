// Shared frame-inspect controller.
//
// Laser outlines, comment-pick, anchor capture/resolve, and a persistent element
// lock ("highlight") - the review machinery shared by the canvas frame bridge
// (bridge.js, one iframe per frame) AND the prototype stage (stage/main.tsx, one
// persistent tree that swaps frames in place). Keeping ONE source means the two
// surfaces never drift.
//
// The HOST owns wheel + navigation ownership, theme, and error wiring; inspect only
// touches laser/pick/anchor/highlight. It self-installs the pointer + message
// listeners and returns { modeActive } so the host can guard its own nav clicks.
//
//   createInspect({ post, getId, onModeChange?, onLaserPick? })
//     post(msg)        send a message up to the shell (parent)
//     getId()          the frame id to stamp on posts (static on canvas, the
//                      current stage frame in play - it swaps without reload)
//     onModeChange?()  called after any laser/pick flip (the canvas bridge uses it
//                      to report its interaction lease; the stage ignores it)
//     onLaserPick?(el, e)  a laser click; returning true means a capture took it as its pick
//                      (trail.js) - no sh:laser-copy then
//
//   shell -> frame : sh:laser · sh:pick · sh:copy-ok · sh:resolve-anchors · sh:highlight-anchor
//   frame -> shell : sh:frame-down · sh:picked · sh:laser-copy · sh:anchor-rects
//
// Anchors (spec 26): only VISIBLE elements ever match, a pin attaches at the end of its element's
// first rendered line (a person's pin: where they clicked), and `window.__mvAnchorCheck` is the
// dev server's door - it loads the frame headless and asks which element a CLI target names.

// comment-mode cursor: the pin's teardrop in the comment green, duotone (dark rim,
// lighter inner) with a white halo ring so it pops on any content; hotspot at the tail
const PICK_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 256 256'%3E%3Cpath d='M132,24A100.11,100.11,0,0,0,32,124v84a16,16,0,0,0,16,16h84a100,100,0,0,0,0-200Z' fill='none' stroke='%23fff' stroke-width='40'/%3E%3Cpath d='M132,24A100.11,100.11,0,0,0,32,124v84a16,16,0,0,0,16,16h84a100,100,0,0,0,0-200Z' fill='%230088ff' stroke='%230069c9' stroke-width='12'/%3E%3Ccircle cx='138' cy='118' r='46' fill='%23fff' opacity='.32'/%3E%3C/svg%3E") 4 21, crosshair`
// laser-mode cursor: the crosshair reticle in accent blue with a white halo ring,
// hotspot dead center
const LASER_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 256 256'%3E%3Cg stroke='%23fff' stroke-width='46' fill='none'%3E%3Ccircle cx='128' cy='128' r='56'/%3E%3Cpath d='M128 24 V56 M128 200 V232 M24 128 H56 M200 128 H232' stroke-linecap='round'/%3E%3C/g%3E%3Cg stroke='%230088ff' stroke-width='20' fill='none'%3E%3Ccircle cx='128' cy='128' r='56'/%3E%3Cpath d='M128 24 V56 M128 200 V232 M24 128 H56 M200 128 H232' stroke-linecap='round'/%3E%3C/g%3E%3Ccircle cx='128' cy='128' r='16' fill='%230088ff' stroke='%23fff' stroke-width='8'/%3E%3C/svg%3E") 12 12, crosshair`

// filled clipboard with a check inside (Phosphor clipboard-fill + check): the label
// wears this while confirming a copy
const COPIED_HTML = `<svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M200,32H163.74a47.92,47.92,0,0,0-71.48,0H56A16,16,0,0,0,40,48V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V48A16,16,0,0,0,200,32Zm-72,0a32,32,0,0,1,32,32H96A32,32,0,0,1,128,32Z"/><path d="M92 150l26 26 48-54" fill="none" stroke="rgba(20,20,24,.92)" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Element path copied</span>`

const LASER_ID = 'mv-laser-style'
const BASE_ID = 'mv-inspect-base'

// hue-tinted highlight (an element's OWN depth hue - the same rainbow laser uses):
// 2px outline + soft fill + ring, driven by whatever hue CSS var the caller names. The
// comment-mode hover reads the LIVE depth hue (--mv-hue, mode-only); the persistent lock
// reads a STORED hue (--mv-lock-hue, set inline per element) so the frame outline never
// diverges from the pin/card colour if the DOM reparents.
const HUE_HL = (sel, hueVar, imp = '') => `
body ${sel} { outline: 2px solid hsl(var(${hueVar}) 95% 45%)${imp}; outline-offset: -2px;
  background-image: linear-gradient(hsl(var(${hueVar}) 95% 50% / .10), hsl(var(${hueVar}) 95% 50% / .10));
  box-shadow: 0 0 0 3px hsl(var(${hueVar}) 95% 50% / .32) }`
// depth hue for every element (role/nesting colour) - only injected while a mode is active
const DEPTH_HUE = (() => {
  let r = 'body { --mv-hue: 0 }\n'
  for (let d = 1; d <= 12; d++) r += `body ${'> * '.repeat(d)}{ --mv-hue: ${(d % 6) * 60} }\n`
  return r
})()

const norm = (t) => (t ?? '').replace(/\s+/g, ' ').trim()

/** Rendered and not hidden: a display:none subtree has no boxes, a visibility:hidden or
 *  transparent one fails checkVisibility. A hidden duplicate is never an anchor's element. */
const shown = (el) => el.getClientRects().length > 0 &&
  (el.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true)
/** Rendered but perhaps transparent - a control that shows on hover, a frame mid-fade-in. Second choice:
 *  matched only when nothing visible does, so such a pin is never orphaned nor such a target refused. */
const rendered = (el) => el.getClientRects().length > 0 && (el.checkVisibility?.({ visibilityProperty: true }) ?? true)
let visible = shown
let transparentOnly = false   // the last `matching` found only rendered-but-transparent elements
const matching = (find) => {
  transparentOnly = false
  const first = find()
  if (first.length) return first
  visible = rendered
  try { const second = find(); transparentOnly = second.length > 0; return second } finally { visible = shown }
}
/** A box too small to read - a screen-reader-only label - is not text a person sees. */
const tiny = (el) => { const r = el.getBoundingClientRect(); return r.width < 2 || r.height < 2 }

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
// the element's live depth hue (0..300) - so the shell can tint the pin / composer /
// thread card in the same colour the element wears in laser, and keep it after a reload
const hueOf = (el) => {
  const raw = getComputedStyle(el).getPropertyValue('--mv-hue').trim()   // set by the mode sheet
  const n = raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 210              // fallback: a calm blue
}
/** The element half of every anchor - a click's and a checked CLI target's alike (one format). */
const elBundle = (el) => {
  const text = norm(el.textContent)
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
      hue: hueOf(el),
    },
  }
}

// ---- safeBundle: what a capture may carry out of a frame (spec 27, "Nothing secret leaves the frame")

const FIELD = 'input, textarea, select'
const EDITABLE = '[contenteditable]:not([contenteditable="false"])'
const SECRET = /pass|secret|token|card|cc-|cvv|cvc|one-?time|otp/i
const MASK = '•••'

/** The words a field is known by: its type, name, id, autocomplete, aria-label, labels. */
const fieldWords = (f) => {
  const out = [f.getAttribute('type'), f.getAttribute('name'), f.id, f.getAttribute('autocomplete'), f.getAttribute('aria-label'), f.getAttribute('placeholder')]
  for (const l of f.labels ?? []) out.push(l.textContent)
  for (const ref of (f.getAttribute('aria-labelledby') ?? '').split(/\s+/)) if (ref) out.push(document.getElementById(ref)?.textContent)
  return out.filter(Boolean).join(' ')
}
/** A field that holds a secret: a password, or one whose words say secret, token, card, cvv, one-time code. */
export const sensitiveField = (f) => f instanceof Element && f.matches(FIELD) && (f.getAttribute('type') === 'password' || SECRET.test(fieldWords(f)))

/** A sensitive context: the element is, contains, or sits inside a field or an editable region, or
 *  relates to a secret field (a label for it, an element naming it). Such a bundle keeps only its
 *  tag, its source and a css path without attribute values. */
const sensitive = (el) => {
  if (el.isContentEditable || el.closest(`${FIELD}, ${EDITABLE}`) || el.querySelector(`${FIELD}, ${EDITABLE}`)) return true
  const label = el.closest('label')
  const control = label?.control ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.control : null)
  if (control && sensitiveField(control)) return true
  for (const ref of [el.getAttribute('aria-controls'), el.getAttribute('aria-describedby')]) {
    const f = ref && document.getElementById(ref)
    if (f && sensitiveField(f)) return true
  }
  return false
}
/** The text a person reads in it - every field and editable subtree skipped, whatever it is called. */
const safeText = (el) => {
  let t = ''
  for (const n of el.childNodes) {
    if (n.nodeType === 3) t += n.data
    else if (n.nodeType === 1 && !n.matches(`${FIELD}, ${EDITABLE}, script, style, noscript, template`)) t += ' ' + safeText(n)
  }
  return t
}
/** A css path built from tags and positions only - no id, no attribute value. */
const plainPath = (el) => {
  const seg = []
  for (let cur = el; cur && cur !== document.body && cur.nodeType === 1; cur = cur.parentElement) {
    const tag = cur.tagName.toLowerCase()
    let n = 1
    for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === cur.tagName) n++
    seg.unshift(n > 1 ? `${tag}:nth-of-type(${n})` : tag)
  }
  return seg.join(' > ')
}

/** The element as a capture records it - a pick, a click, a hover, a probe answer, a field. Built
 *  on elBundle's shape; a sensitive context is masked. `point` (viewport px) adds where it was hit. */
export function safeBundle(el, point) {
  const r = el.getBoundingClientRect()
  const where = point ? { pos: { fx: r.width ? Math.min(1, Math.max(0, (point.x - r.left) / r.width)) : .5, fy: r.height ? Math.min(1, Math.max(0, (point.y - r.top) / r.height)) : .5 } } : {}
  const rect = { rect: { x: r.left, y: r.top, w: r.width, h: r.height } }
  if (sensitive(el)) {
    return { el: { semantics: { tag: el.tagName.toLowerCase(), role: MASK, ariaLabel: MASK, testId: MASK, quote: MASK }, cssPath: plainPath(el), source: el.dataset?.mvLoc ?? undefined, sensitive: true }, ...where, ...rect }
  }
  const b = elBundle(el)
  b.el.semantics.quote = norm(safeText(el)).slice(0, 200) || undefined
  return { ...b, ...where, ...rect }
}

/** What a field change records: the value only for a text, search, number or select field that is
 *  not a secret one; anything else "changed (12 characters)". */
export function fieldValue(f) {
  const v = typeof f.value === 'string' ? f.value : ''
  const type = (f.getAttribute('type') ?? 'text').toLowerCase()
  const plain = f.matches('select') || (f.matches('input') && ['text', 'search', 'number'].includes(type))
  return plain && !sensitiveField(f) ? v : `changed (${v.length} characters)`
}

const SKIP = 'script,style,noscript,template'
/** The visible elements showing these words (case and spacing aside): the innermost element
 *  whose SEEN text holds them - only text whose own element is shown, with a line break or a block
 *  between words read as a space - so "Pay <b>now</b>" is its paragraph, "Welcome<br>back" reads
 *  "Welcome back", words split by a hidden run still read as one, and a hidden or transparent copy
 *  never stands in for words nobody sees - once per place they appear. */
const byWords = (words) => {
  const q = norm(words).toLowerCase()
  if (!q) return []
  const seen = new Map()   // element -> its seen text, each element measured once
  const seenText = (el) => {
    if (seen.has(el)) return seen.get(el)
    let t = ''
    if (!el.matches(SKIP)) {
      const on = visible(el) && !tiny(el)
      for (const n of el.childNodes) {
        if (n.nodeType === 3) t += on ? n.data : ''
        else if (n.nodeType === 1) t += n.tagName === 'BR' ? ' ' : getComputedStyle(n).display.startsWith('inline') ? seenText(n) : ` ${seenText(n)} `
      }
    }
    seen.set(el, t)
    return t
  }
  const has = (el) => norm(seenText(el)).toLowerCase().includes(q)
  const walk = (el) => {
    const inner = [...el.children].filter(has).flatMap(walk)
    return inner.length || el === document.body ? inner : [el]
  }
  return document.body && has(document.body) ? walk(document.body) : []
}
/** `--at`: its exact data-testid first, else a CSS selector (throws on one that is neither). */
const byAt = (at) => {
  const all = (sel) => [...document.querySelectorAll(sel)].filter((el) => visible(el))
  const ids = all(`[data-testid="${CSS.escape(at)}"]`)
  return ids.length ? ids : all(at)
}

/** Does this element still fit what an anchor says about it? */
const fits = (el, want) => {
  if (want.tag && el.tagName.toLowerCase() !== want.tag) return false
  if (want.role && el.getAttribute('role') !== want.role) return false
  if (want.ariaLabel && el.getAttribute('aria-label') !== want.ariaLabel) return false
  if (want.testId && el.getAttribute('data-testid') !== want.testId) return false
  const text = norm(el.textContent)
  if (want.quote && !(text.startsWith(want.quote.slice(0, 60)) || text.includes(want.quote.slice(0, 40)))) return false
  return true
}
/** Every visible element an anchor can mean, in document order: by its test id, tag or selector,
 *  filtered by its semantics - or, for an agent's words-only anchor, the elements showing them. */
const anchorMatches = (anchor) => {
  const a = anchor?.el ?? {}
  const want = a.semantics ?? {}
  if (want.quote && !want.tag && !a.cssPath) return byWords(want.quote)
  if (a.at) { try { return byAt(a.at) } catch { return [] } }
  const tag = typeof want.tag === 'string' && /^[a-z][a-z0-9-]*$/.test(want.tag) ? want.tag : null
  const pool = want.testId ? `[data-testid="${CSS.escape(want.testId)}"]` : tag && (want.quote || !a.cssPath) ? tag : a.cssPath
  if (!pool) return []
  try { return [...document.querySelectorAll(pool)].filter((el) => fits(el, want) && visible(el)) } catch { return [] }
}
/** A captured bundle's exact path wins while it still fits; otherwise the `nth` of its matches. */
const resolveAnchor = (anchor) => {
  const a = anchor?.el ?? {}
  if (a.semantics?.tag && a.cssPath) {
    try {
      const exact = document.querySelector(a.cssPath)
      if (exact && fits(exact, a.semantics) && rendered(exact)) return exact   // a person's click: there, even transparent now
    } catch { /* stale selector */ }
  }
  return matching(() => anchorMatches(anchor))[(a.nth ?? 1) - 1] ?? null
}

/** Where a pin attaches, in this document's viewport px. A person's pin: the point they clicked.
 *  Otherwise the end of the element's first rendered line - a text range over its text, so a
 *  heading, a paragraph and a bold run wrapped over two lines all take their first line's end -
 *  and for an element with no text, its top-right corner. */
const attachPoint = (el, anchor) => {
  const r = el.getBoundingClientRect()
  const pos = anchor?.pos
  if (pos && anchor?.el?.cssPath && Number.isFinite(pos.fx) && Number.isFinite(pos.fy))
    return { x: r.left + pos.fx * r.width, y: r.top + pos.fy * r.height }
  const range = document.createRange()
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let line = null
  for (let n = walk.nextNode(), i = 0; n && i < 400; n = walk.nextNode(), i++) {
    if (!n.data.trim() || !n.parentElement || n.parentElement.closest(SKIP) || !visible(n.parentElement) || tiny(n.parentElement)) continue
    range.selectNodeContents(n)
    for (const q of range.getClientRects()) {
      if (!q.width || !q.height) continue
      if (!line) { line = { top: q.top, bottom: q.bottom, right: q.right }; continue }
      if ((q.top + q.bottom) / 2 > line.bottom) return { x: line.right, y: (line.top + line.bottom) / 2 }   // the second line
      line.right = Math.max(line.right, q.right)
    }
  }
  return line ? { x: line.right, y: (line.top + line.bottom) / 2 } : { x: r.right, y: r.top }
}

/** The headings, labels and buttons a frame shows - what to suggest when words match nothing. */
const landmarks = () => {
  const seen = new Set()
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,label,button,[role=button],a,legend,th')) {
    const t = norm(el.textContent).slice(0, 60)
    if (t && shown(el)) seen.add(t)
    if (seen.size >= 30) break
  }
  return [...seen]
}
const describeEl = (el) => `${el.tagName.toLowerCase()} "${norm(el.textContent).slice(0, 50)}"`

/** The dev server's anchor check (server/anchor-check.ts): which visible element does an agent's
 *  target name? Refuses only on evidence - none, or several without `nth` - and for the one it
 *  finds returns the full bundle (exact on the canvas), plus the open threads already on it. */
const checkTarget = ({ on, at, nth } = {}, others = []) => {
  let found = []
  if (on) found = matching(() => byWords(on))
  else if (at) { try { found = matching(() => byAt(at)) } catch { return { bad: `"${at}" is neither a data-testid nor a CSS selector` } } }
  if (!found.length) return { none: landmarks() }
  // only a transparent element shows it right now (a fade-in still running, a control that shows on
  // hover): no evidence either way - the note is written unchecked, never refused
  if (transparentOnly) return { transparent: true }
  const el = found.length === 1 && !nth ? found[0] : nth ? found[nth - 1] : null
  if (!el) return { several: found.slice(0, 20).map(describeEl) }
  const anchor = elBundle(el)
  // the fallback scan (a stale path) must land on this one of several look-alikes too
  const i = matching(() => anchorMatches({ el: { ...anchor.el, cssPath: undefined } })).indexOf(el)
  if (i > 0) anchor.el.nth = i + 1
  const holders = others.filter((o) => { try { return resolveAnchor(o.anchor) === el } catch { return false } }).map((o) => o.key)
  return { anchor, holders }
}
if (typeof window !== 'undefined') window.__mvAnchorCheck = checkTarget

export function createInspect({ post, getId, onModeChange, onLaserPick }) {
  let laserOn = false, pickOn = false
  // quiet pick (⇧L laser comment off): clicks still anchor comments, but NO hover outline,
  // label, or lock lighting inside the artwork - the shell decides, the frame obeys
  let pickQuiet = false
  let hoverEl = null, labelEl = null
  let lockedEl = null, highlightAnchor = null   // the persistent outline (#4 lock / #5 open)
  let copiedTimer = null, copySeq = 0, copyEl = null

  // every listener goes through `on` so dispose() can remove them all - a stage remount
  // (Fast Refresh) would otherwise stack duplicate controllers posting duplicate picks
  const removers = []
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); removers.push(() => target.removeEventListener(type, fn, opts)) }

  const modeActive = () => laserOn || pickOn

  // the mode stylesheet: laser's full-board rainbow, or comment's single-element hover.
  // Both colour by the element's depth hue (--mv-hue lives in the always-on base sheet).
  const laserCss = () => {
    let rules = DEPTH_HUE               // depth hues live only while a mode is active
    if (laserOn)
      rules += 'body *:not(script):not(style):not(#mv-laser-label):not(#mv-laser-label *) { outline: 1px solid hsl(var(--mv-hue) 85% 55% / .75); outline-offset: -1px }\n'
    if (pickOn || laserOn)
      rules += `body, body * { cursor: ${pickOn ? PICK_CURSOR : LASER_CURSOR} !important }\n`
    // comment mode: the hovered element pops in its OWN hue (outline + fill + ring), so it
    // reads as "the thing you'll comment on" in the same colour it wears in laser. Laser
    // keeps its lighter single outline so the whole board stays legible.
    const hover = pickOn ? HUE_HL('[data-mv-hover]', '--mv-hue') : `
body [data-mv-hover] { outline: 2px solid hsl(var(--mv-hue) 95% 45%); outline-offset: -2px;
  background-image: linear-gradient(hsl(var(--mv-hue) 95% 50% / .08), hsl(var(--mv-hue) 95% 50% / .08)) }`
    return rules + hover + `
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

  // the lock outline is always available (a thread can be opened while NOT in a mode),
  // so its rule lives in a tiny base sheet injected once - comment green, distinct from
  // the mode hover, and it wins by being 2px with an offset.
  const injectBase = () => {
    if (document.getElementById(BASE_ID)) return
    const s = document.createElement('style')
    s.id = BASE_ID
    // the persistent lock, tinted in the anchored element's stored hue (set inline as
    // --mv-lock-hue by applyLock; fallback to a calm blue for any pre-hue anchor)
    s.textContent = HUE_HL('[data-mv-locked]', '--mv-lock-hue, 210', ' !important')
    document.head.appendChild(s)
  }

  const applyModes = () => {
    // one mode flag for the whole frame: the capture recorder records no click while it is set,
    // so a pick is recorded once (trail.js)
    window.__mvPick = modeActive()
    const cur = document.getElementById(LASER_ID)
    if (!modeActive()) { if (cur) cur.remove(); clearHover(); return }
    const s = cur ?? document.createElement('style')
    s.id = LASER_ID
    s.textContent = laserCss()
    if (!cur) document.head.appendChild(s)
  }

  const describe = (el) => {
    const tag = el.tagName.toLowerCase()
    const loc = el.dataset.mvLoc
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
    return loc ? `${tag} · ${loc}` : text ? `${tag} · “${text}”` : tag
  }

  const clearHover = () => {
    if (hoverEl) { delete hoverEl.dataset.mvHover; hoverEl = null }
    if (labelEl) { labelEl.remove(); labelEl = null }
    clearTimeout(copiedTimer)
  }

  // the persistent lock (#4/#5): one element at a time, its own attribute so a
  // hover clear never touches it and the mode-off teardown leaves it alone.
  const applyLock = (el, hue) => {
    // stamp the stored hue first, so re-confirming the SAME element still refreshes its
    // colour; a missing/invalid hue REMOVES the var so the CSS fallback (210) applies
    if (el) {
      if (Number.isFinite(hue)) el.style.setProperty('--mv-lock-hue', String(hue))
      else el.style.removeProperty('--mv-lock-hue')
    }
    if (lockedEl === el) return
    if (lockedEl) { delete lockedEl.dataset.mvLocked; lockedEl.style.removeProperty('--mv-lock-hue') }
    lockedEl = el
    if (el) el.dataset.mvLocked = '1'
  }
  const clearLock = () => {
    if (lockedEl) { delete lockedEl.dataset.mvLocked; lockedEl.style.removeProperty('--mv-lock-hue') }
    lockedEl = null; highlightAnchor = null
  }

  const showCopied = (seq) => {
    if (seq !== copySeq || hoverEl !== copyEl || !labelEl) return
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

  // the label hangs BELOW the cursor with a gap, left-aligned under it - never over the
  // element you are trying to click. It only shifts left when it would run off the right
  // edge (so the text is never clipped), and flips ABOVE the cursor near the bottom edge.
  const place = (label, e) => {
    const gap = 18
    const w = label.offsetWidth, h = label.offsetHeight
    let x = e.clientX                                    // left edge under the cursor
    if (x + w > innerWidth - 4) x = innerWidth - 4 - w   // keep fully in view instead of clipping
    x = Math.max(4, x)
    let y = e.clientY + gap                              // below, clear of the cursor
    if (y + h > innerHeight - 4) y = e.clientY - gap - h // no room below -> flip above
    y = Math.max(4, y)
    label.style.left = x + 'px'
    label.style.top = y + 'px'
  }

  // the pointer LEAVING this frame takes its hover lighting with it: each frame is its own
  // document, so once the cursor is gone no mousemove ever fires here again - without this,
  // the last hovered outline + label fossilize on every frame the cursor crossed.
  // (relatedTarget null = left the window/iframe, not just moved between elements)
  on(document, 'mouseout', (e) => { if (!e.relatedTarget) clearHover() })
  on(window, 'blur', clearHover)

  // hover-follow: the label chases the cursor while a mode is on - BUT a locked
  // element (#4 composing / #5 thread open) freezes it: the lit element is the one
  // being discussed, not whatever the pointer grazes.
  on(document, 'mousemove', (e) => {
    if (!modeActive() || lockedEl) return
    if (pickOn && pickQuiet) return   // quiet pick: no hover visuals, clicks still land
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

  const anchorBundle = (el, e) => {
    const r = el.getBoundingClientRect()
    return {
      ...elBundle(el),
      pos: {
        fx: r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : .5,
        fy: r.height ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : .5,
      },
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    }
  }

  // every press is reported so the shell can close an open thread card when the click
  // lands INSIDE a frame (shell-document listeners never see those)
  on(document, 'pointerdown', () => post({ type: 'sh:frame-down', id: getId() }), true)

  on(document, 'click', (e) => {
    if (!modeActive()) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.target instanceof Element && e.target.closest('body *:not(#mv-laser-label)')
    if (!el) return
    if (pickOn) {
      // #4: lock the chosen element the instant it is picked - no round-trip flicker.
      // The shell re-confirms via sh:highlight-anchor once the draft is staged.
      // Quiet pick (⇧L off) anchors WITHOUT lighting the element.
      if (!pickQuiet) applyLock(el, hueOf(el))
      clearHover()
      post({ type: 'sh:picked', id: getId(), anchor: anchorBundle(el, e) })
    } else if (!onLaserPick?.(el, e)) {
      // outside a capture a laser click copies the element's path; inside one it is the capture's pick
      copyEl = el
      post({ type: 'sh:laser-copy', id: getId(), seq: ++copySeq, path: cssPath(el), source: el.dataset.mvLoc ?? null })
    }
  }, true)

  // re-resolve + re-apply the shell-driven highlight. Called on set and on every
  // resolve-anchors pass, so a stage frame swapped in AFTER the highlight arrived
  // (the DOM had not committed yet) still lights up on the next cycle - and, just as
  // important, a target that has SINCE detached clears the lock (applyLock(null))
  // instead of stranding a stale outline / a stuck hover-suppression.
  const reapplyHighlight = () => {
    if (!highlightAnchor) return
    applyLock(resolveAnchor(highlightAnchor), highlightAnchor?.el?.hue)
  }

  const onMessage = (e) => {
    if (e.source !== window.parent || window.parent === window) return
    if (e.origin && e.origin !== location.origin) return   // a navigated frame must not spoof shell commands
    const m = e?.data
    if (!m || typeof m !== 'object') return
    if (m.type === 'sh:laser') { laserOn = !!m.on; applyModes(); onModeChange?.(laserOn, pickOn) }
    else if (m.type === 'sh:pick') {
      pickOn = !!m.on; pickQuiet = !!m.quiet; applyModes()
      if (pickQuiet) clearHover()   // a hover lit before the toggle landed must not linger
      // leaving comment mode drops a provisional self-lock the shell never confirmed;
      // a shell-owned highlight (highlightAnchor set, e.g. #5) survives
      if (!pickOn && !highlightAnchor) clearLock()
      onModeChange?.(laserOn, pickOn)
    }
    else if (m.type === 'sh:copy-ok') showCopied(m.seq)
    else if (m.type === 'sh:highlight-anchor') {
      // null clears; an anchor locks its element (the pick draft #4, or the opened thread
      // #5). No frame-id guard: a canvas frame only ever receives its OWN highlights (the
      // shell posts to that one iframe), and an HTML frame reports id=pathname != frame.id
      // so a guard would wrongly drop every one. Stage-swap staleness is handled instead by
      // resolveAnchor failing on the wrong DOM (-> clear) and reapplyHighlight relighting on
      // the next resolve tick once the new frame has committed.
      if (!m.anchor) { clearLock(); return }
      highlightAnchor = m.anchor
      applyLock(resolveAnchor(m.anchor), m.anchor?.el?.hue)
    }
    else if (m.type === 'sh:resolve-anchors' && Array.isArray(m.anchors)) {
      const rects = m.anchors.slice(0, 200).map((a) => {
        let el = null
        try { el = resolveAnchor(a.anchor) } catch { /* one bad anchor, not the batch */ }
        if (!el) return { key: a.key, orphan: true }
        const r = el.getBoundingClientRect()
        return { key: a.key, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, point: attachPoint(el, a.anchor) }
      })
      reapplyHighlight()
      post({ type: 'sh:anchor-rects', id: getId(), rects })
    }
  }
  on(window, 'message', onMessage)

  injectBase()
  return {
    modeActive, isLaser: () => laserOn, isPick: () => pickOn,
    // remove every listener + injected style + clear timers/locks (stage remount safety)
    dispose() {
      removers.forEach((f) => f())
      clearTimeout(copiedTimer)
      clearHover(); clearLock()
      document.getElementById(LASER_ID)?.remove()
      document.getElementById(BASE_ID)?.remove()
      window.__mvPick = false
    },
  }
}
