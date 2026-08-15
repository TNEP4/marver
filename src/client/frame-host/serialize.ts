// SPEC-M5 slice 1: the DOM-snapshot serializer. Turns a live, same-origin frame Document into a
// self-contained STATIC html string: post-render DOM + full inlined CSS (styleSheets +
// adoptedStyleSheets), JS stripped. Rendered in a `sandbox="allow-same-origin"` (NO allow-scripts)
// iframe srcdoc, it reflows / theme-flips / device-sweeps with the browser's own layout engine and
// the app's own stylesheet - so color is identical (same tokens, no raster) and layout is real CSS.
//
// Runs in the SHELL (same origin as every frame), reading the live iframe's contentDocument directly
// - no bridge round-trip. Fail soft: any throw returns a `degraded` result the coordinator refuses to
// show. Correctness beats the flash-guard: a frame we cannot serialise faithfully stays live.

export interface ScrollEntry { sel: string; top: number; left: number }
export interface SerializeResult {
  html: string
  scrollMap: ScrollEntry[]          // native scrollers to restore shell-side after load
  degraded: string[]                // 'canvas' | 'video' | 'shadow-dom' | 'cross-origin-css' | 'js-layout'
  notes: string[]
  cssBytes: number
}

const STRIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT'])

/** Absolutize relative url() in a sheet's cssText against that sheet's href (codex P1: consolidating
 *  rules into one <style> moves the url() base from each sheet to the srcdoc base). */
function absolutizeUrls(css: string, sheetHref: string | null): string {
  if (!sheetHref) return css
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref: string) => {
    if (/^(data:|https?:|blob:|#|\/)/i.test(ref) || !ref.trim()) return m
    try { return `url(${q}${new URL(ref, sheetHref).href}${q})` } catch { return m }
  })
}

/** Serialise one sheet's rules, recursing into same-origin @import (so imported CSS is inlined, not
 *  left as an invalid mid-list @import pointing at an un-inlined sheet). Bumps `xo` on any unreadable
 *  (cross-origin) sheet or import so the caller can degrade. */
function rulesText(rules: CSSRuleList, href: string | null, xo: { n: number }): string {
  let text = ''
  for (const r of Array.from(rules)) {
    if (r.type === 3 /* CSSRule.IMPORT_RULE */) {
      const imported = (r as CSSImportRule).styleSheet
      if (!imported) { xo.n++; continue }
      try { text += rulesText(imported.cssRules, imported.href ?? href, xo) } catch { xo.n++ }
      continue
    }
    text += r.cssText + '\n'
  }
  return absolutizeUrls(text, href)
}

/** Collect every CSS rule the document renders with: <style>/<link> sheets (recursing @import) AND
 *  constructable adoptedStyleSheets. Cross-origin sheets throw on .cssRules - record + degrade (never
 *  claim fidelity). Honours per-sheet media (`<link media=print>`) and skips disabled sheets. */
function collectCss(doc: Document, degraded: string[], notes: string[]): string {
  const chunks: string[] = []
  const xo = { n: 0 }
  const dump = (sheet: CSSStyleSheet, href: string | null, label: string) => {
    if (sheet.disabled) return
    let rules: CSSRuleList | null = null
    try { rules = sheet.cssRules } catch { xo.n++; return }
    if (!rules) return
    const text = rulesText(rules, href, xo)
    if (!text) return
    const media = sheet.media?.mediaText
    chunks.push(`/* ${label} */\n${media && media !== 'all' ? `@media ${media}{\n${text}\n}` : text}`)
  }
  for (const s of Array.from(doc.styleSheets)) dump(s as CSSStyleSheet, s.href, s.href ?? 'inline')
  const adopted = (doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []
  adopted.forEach((s, i) => dump(s, null, `adopted[${i}]`))
  if (xo.n) { degraded.push('cross-origin-css'); notes.push(`${xo.n} cross-origin stylesheet(s)/import(s) unreadable`) }
  if (adopted.length) notes.push(`${adopted.length} adoptedStyleSheet(s) inlined`)
  return chunks.join('\n')
}

/** A stable-ish selector for restoring scroll in the identical-structure lean doc. */
function selectorFor(el: Element): string {
  const seg: string[] = []
  for (let cur: Element | null = el; cur && cur !== el.ownerDocument.documentElement; cur = cur.parentElement) {
    if (cur.id) { seg.unshift(`#${CSS.escape(cur.id)}`); break }
    const tag = cur.tagName.toLowerCase()
    let n = 1
    for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === cur.tagName) n++
    seg.unshift(`${tag}:nth-of-type(${n})`)
  }
  return seg.join('>')
}

/** Strip execution + inline handlers from the clone; flag content that cannot reflow as DOM. */
function scrub(root: Element, doc: Document, degraded: string[]): void {
  root.querySelectorAll('script, noscript, link[rel~="modulepreload"], link[rel~="preload"], link[rel~="stylesheet"]').forEach((n) => n.remove())
  const walk = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  const flag = { canvas: false, video: false }
  for (let el = walk.currentNode as Element | null; el; el = walk.nextNode() as Element | null) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      else if (/^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
    }
    const tag = el.tagName
    if (tag === 'CANVAS') flag.canvas = true
    if (tag === 'VIDEO') flag.video = true
    if (STRIP_TAGS.has(tag)) el.remove()
  }
  if (flag.canvas) degraded.push('canvas')
  if (flag.video) degraded.push('video')
}

/** Open shadow roots must be detected on the ORIGINAL tree - cloneNode(true) drops them, so the clone
 *  can never reveal them. A frame with any shadow DOM (open here, or closed via the boot-time flag)
 *  degrades to live rather than shipping a lean copy missing its shadow content. */
function hasOpenShadow(doc: Document): boolean {
  const walk = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT)
  for (let el = walk.currentNode as Element | null; el; el = walk.nextNode() as Element | null)
    if ((el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) return true
  return false
}

/** Copy live form PROPERTIES (value/checked/selected) into the clone. They are runtime state, not
 *  attributes, so cloneNode never carries them - without this a re-captured frame shows empty inputs
 *  and unchecked boxes. Original and clone share structure, so we pair them in document order.
 *  tagName/type checks (not instanceof) because the clone nodes are owned by the frame's realm. */
function syncFormState(doc: Document, clone: HTMLElement): void {
  const live = doc.querySelectorAll('input, textarea, option')
  const dst = clone.querySelectorAll('input, textarea, option')
  live.forEach((src, i) => {
    const d = dst[i]
    if (!d || d.tagName !== src.tagName) return
    if (src.tagName === 'INPUT') {
      const s = src as HTMLInputElement
      if (s.type === 'checkbox' || s.type === 'radio') s.checked ? d.setAttribute('checked', '') : d.removeAttribute('checked')
      else d.setAttribute('value', s.value)
    } else if (src.tagName === 'TEXTAREA') { d.textContent = (src as HTMLTextAreaElement).value }
    else if (src.tagName === 'OPTION') { (src as HTMLOptionElement).selected ? d.setAttribute('selected', '') : d.removeAttribute('selected') }
  })
}

/**
 * Serialize a live same-origin Document into a static, self-contained html string.
 * @param doc       the live frame document (same origin - we read its cssRules directly)
 * @param baseHref  the frame's real URL, injected as <base> so relative url()/img/font resolve
 */
export function serializeDoc(doc: Document, baseHref: string): SerializeResult {
  const notes: string[] = []
  const degraded: string[] = []

  // shadow DOM (open detected on the original tree, closed via the boot-time attachShadow flag):
  // either kind degrades the frame to live - cloneNode cannot carry a shadow root.
  const win = doc.defaultView as (Window & { __mvClosedShadow?: boolean }) | null
  if (win?.__mvClosedShadow || hasOpenShadow(doc)) { degraded.push('shadow-dom'); notes.push('shadow root(s) present') }

  const css = collectCss(doc, degraded, notes)
  const cssBytes = new Blob([css]).size

  // scroll offsets to restore shell-side (native scrollers; a virtualised one that fails to resolve
  // OR whose offset does not stick re-degrades the frame in the coordinator). != 0 catches RTL/negative.
  const scrollMap: ScrollEntry[] = []
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('*'))) {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) scrollMap.push({ sel: selectorFor(el), top: el.scrollTop, left: el.scrollLeft })
  }
  const de = doc.documentElement
  if (de.scrollTop !== 0 || de.scrollLeft !== 0) scrollMap.push({ sel: ':root', top: de.scrollTop, left: de.scrollLeft })

  // clone the RENDERED dom (React's committed output = authored markup that reflows under CSS)
  const html = doc.documentElement.cloneNode(true) as HTMLElement
  scrub(html, doc, degraded)
  syncFormState(doc, html)

  // head: <meta charset> + <base> (relative url()/img/font resolve against the real frame URL) +
  // ONE inlined stylesheet (both themes, all media queries). Drop the clone's own style nodes.
  const head = html.querySelector('head') ?? html.insertBefore(doc.createElement('head'), html.firstChild)
  head.querySelectorAll('style').forEach((n) => n.remove())
  const style = doc.createElement('style'); style.textContent = css
  const base = doc.createElement('base'); base.setAttribute('href', baseHref)
  const meta = doc.createElement('meta'); meta.setAttribute('charset', 'utf-8')
  head.insertBefore(style, head.firstChild)
  head.insertBefore(base, head.firstChild)
  head.insertBefore(meta, head.firstChild)

  return { html: '<!doctype html>\n' + html.outerHTML, scrollMap, degraded: Array.from(new Set(degraded)), notes, cssBytes }
}
