// SPEC-M5 de-risk prototype: the DOM-snapshot serializer.
// Turns a live, same-origin frame Document into a self-contained STATIC html string:
// post-render DOM + full inlined CSS (styleSheets + adoptedStyleSheets), JS stripped.
// Rendered later in a `sandbox="allow-same-origin"` (NO allow-scripts) iframe srcdoc, it
// reflows / theme-flips / device-sweeps with the browser's own layout engine and the app's
// own stylesheet - so color is identical (same tokens, no raster) and layout is real CSS.
//
// This is a PROTOTYPE to answer two questions before we lock the spec:
//   1. fidelity - does the lean copy look pixel-identical to the live app (Nic's eyes)?
//   2. perf - does reflowing N lean docs during a device sweep stay under the 16ms budget?
// It deliberately handles the codex-flagged holes that decide those answers (allow-same-origin,
// adoptedStyleSheets, <base> for relative url()/img, script strip) and NOTES the ones it does
// not yet (cross-origin CSS, shadow DOM, canvas/video pixels, scroll) so we measure honestly.

export interface SerializeResult {
  html: string
  notes: string[]        // honest degradation log - what was skipped / needs the real spec
  cssBytes: number
  degraded: string[]     // machine tags: 'canvas' | 'video' | 'shadow-dom' | 'cross-origin-css' | 'scroll'
}

const STRIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT'])

/** Collect every CSS rule the document renders with: <style>/<link> sheets AND
 *  constructable adoptedStyleSheets. Cross-origin sheets throw on .cssRules - we skip
 *  and record (codex P1: cannot silently claim fidelity for them). */
function collectCss(doc: Document, degraded: string[], notes: string[]): string {
  const chunks: string[] = []
  let crossOrigin = 0
  const dump = (sheet: CSSStyleSheet, label: string) => {
    let rules: CSSRuleList | null = null
    try { rules = sheet.cssRules } catch { crossOrigin++; return }   // SecurityError on cross-origin
    if (!rules) return
    let text = ''
    for (const r of Array.from(rules)) text += r.cssText + '\n'
    if (text) chunks.push(`/* ${label} */\n${text}`)
  }
  for (const s of Array.from(doc.styleSheets)) dump(s as CSSStyleSheet, s.href ?? 'inline')
  // constructable stylesheets (codex P1: cloneNode never carries these)
  const adopted = (doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []
  adopted.forEach((s, i) => dump(s, `adopted[${i}]`))
  if (crossOrigin) { degraded.push('cross-origin-css'); notes.push(`${crossOrigin} cross-origin stylesheet(s) skipped (cssRules SecurityError) - would need a build-time inline`) }
  if (adopted.length) notes.push(`${adopted.length} adoptedStyleSheet(s) inlined`)
  return chunks.join('\n')
}

/** Strip execution + inline handlers from the clone. The sandbox is the hard guarantee;
 *  this keeps the snapshot small and defends in depth. */
function scrub(root: Element, degraded: string[]): void {
  // scripts + preloads that would fetch/execute
  root.querySelectorAll('script, noscript, link[rel~="modulepreload"], link[rel~="preload"]').forEach((n) => n.remove())
  // link rel=stylesheet is inlined already - drop to avoid double-load + relative-base drift
  root.querySelectorAll('link[rel~="stylesheet"]').forEach((n) => n.remove())
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  const flagged = { canvas: false, video: false, shadow: false }
  for (let el = walk.currentNode as Element | null; el; el = walk.nextNode() as Element | null) {
    // on* handlers + javascript: urls
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      else if (/^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
    }
    const tag = el.tagName
    if (tag === 'CANVAS') flagged.canvas = true
    if (tag === 'VIDEO') flagged.video = true
    if ((el as Element & { shadowRoot?: ShadowRoot }).shadowRoot) flagged.shadow = true
    if (STRIP_TAGS.has(tag)) el.remove()
  }
  if (flagged.canvas) degraded.push('canvas')
  if (flagged.video) degraded.push('video')
  if (flagged.shadow) degraded.push('shadow-dom')
}

/**
 * Serialize a live same-origin Document into a static, self-contained html string.
 * @param doc   the live frame document (same origin - we read its cssRules directly)
 * @param baseHref  the frame's real URL, injected as <base> so relative url()/img/font resolve
 */
export function serializeDoc(doc: Document, baseHref: string): SerializeResult {
  const notes: string[] = []
  const degraded: string[] = []

  const css = collectCss(doc, degraded, notes)
  const cssBytes = new Blob([css]).size

  // clone the RENDERED dom (React's committed output). NB codex P1: this is markup, not
  // rendered state - form values, scroll, canvas pixels, animation time are NOT captured.
  const html = doc.documentElement.cloneNode(true) as HTMLElement
  scrub(html, degraded)

  // note (don't yet fix) scroll: any scrolled container will seam on swap
  const scrolled = doc.querySelectorAll('*')
  for (const el of Array.from(scrolled)) {
    if ((el as HTMLElement).scrollTop > 0 || (el as HTMLElement).scrollLeft > 0) { degraded.push('scroll'); notes.push('scrolled container(s) present - not captured (no-JS lean doc cannot restore scroll)'); break }
  }

  // rebuild <head>: base first (relative url() resolve against the real frame URL), then our
  // single inlined stylesheet. Drop the clone's own <style> nodes - css already collected them.
  const head = html.querySelector('head') ?? html.insertBefore(doc.createElement('head'), html.firstChild)
  head.querySelectorAll('style').forEach((n) => n.remove())
  const base = doc.createElement('base'); base.setAttribute('href', baseHref)
  const style = doc.createElement('style'); style.textContent = css
  head.insertBefore(style, head.firstChild)
  head.insertBefore(base, head.firstChild)
  // charset must be first byte-wise
  const meta = doc.createElement('meta'); meta.setAttribute('charset', 'utf-8')
  head.insertBefore(meta, head.firstChild)

  const out = '<!doctype html>\n' + html.outerHTML
  return { html: out, notes, cssBytes, degraded: Array.from(new Set(degraded)) }
}
