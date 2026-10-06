/**
 * The Diagram block - first-class Mermaid.
 * Mermaid is marver's dependency behind a dynamic import: a workspace with no
 * Diagram loads no mermaid bytes. Source-level theme overrides (%%{init}%%,
 * yaml frontmatter) are stripped so the marver palette always holds; the
 * rendered SVG is sanitized of external references (strict securityLevel is
 * not a no-network policy). A parse error renders an in-frame card - never a
 * blank frame, never a tripped readiness timeout.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FONT_STACK, THEME_CSS, themeVars } from './palette.ts'

let uidSeq = 0
/** Renders in flight - mermaid loads and lays out asynchronously, so a Doc is not done growing
 *  until this is 0 (the Doc's settled measurement reads it; the frame's own innerHTML is set
 *  before the count drops). */
let diagramsBusy = 0
export const diagramsPending = (): number => diagramsBusy

const isDark = () =>
  document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark'

/** Strip yaml frontmatter and %%{...}%% directives - diagram source cannot re-theme itself. */
export function cleanSource(src: string): string {
  return src
    .replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/%%\{[\s\S]*?\}%%/g, '')
    .trim()
}

/** flowchart/graph is where classDef + markdown-string labels both apply; other diagram
 *  types (sequence, pie, ...) don't take the family/hierarchy sugar. */
function isFlowchart(src: string): boolean {
  const first = src.split('\n').find((l) => l.trim())?.trim() ?? ''
  return /^(flowchart|graph)\b/.test(first)
}

// D1: head/gloss auto-hierarchy. An agent writes a natural `Head :: gloss` label and marver
// renders the head BOLD on top with the gloss on a lighter, smaller line below - no backticks,
// no `**`, no `<br>` to hand-author. It expands the label into a mermaid markdown string (bold
// head, blank line -> a second <p> the THEME_CSS styles down). ` :: ` (spaced double colon) is
// the token: rare in prose, and distinct from the `:::family` class tag (no spaces, three colons).
const GLOSS = ' :: '
export function withLabelHierarchy(src: string): string {
  if (!isFlowchart(src)) return src
  return src.replace(/"([^"\n]*?)"/g, (m, body: string) => {
    const at = body.indexOf(GLOSS)
    if (at < 0 || body.startsWith('`')) return m           // no token, or already a markdown string
    const head = body.slice(0, at).trim()
    const gloss = body.slice(at + GLOSS.length).trim()
    if (!head || !gloss) return m
    const bhead = /[*`]/.test(head) ? head : `**${head}**`  // don't double-bold a hand-marked head
    return `"\`${bhead}\n\n${gloss}\`"`                     // "`**Head**⏎⏎gloss`"
  })
}

// D2: named family fills - the SAME colour language as the Md `:blue[...]` families, so an agent
// tags a node `HQ:::blue` with zero classDef boilerplate and prose + diagram read as one palette.
const DIAGRAM_FAMILIES: Record<string, string> = {
  blue: 'fill:#0088FF,stroke:#0066CC,color:#fff',
  orange: 'fill:#F5820A,stroke:#C96A08,color:#fff',
  purple: 'fill:#B32BC8,stroke:#8F22A0,color:#fff',
  green: 'fill:#1FA34A,stroke:#178139,color:#fff',
  red: 'fill:#E5342B,stroke:#B71C13,color:#fff',
  gray: 'fill:#E5E5EA,stroke:#C7C7CC,color:#1C1C1E',
}
/** Append the family classDefs to flowchart/graph diagrams (classDef is a flowchart feature).
 *  Unused defs are harmless; `X:::blue` resolves them regardless of position. */
export function withFamilies(src: string): string {
  if (!isFlowchart(src)) return src
  const defs = Object.entries(DIAGRAM_FAMILIES).map(([n, s]) => `classDef ${n} ${s}`).join('\n')
  return `${src}\n${defs}`
}

/** The zero-external-request boundary, BEFORE render: mermaid's image shapes fetch their URL
 *  during render(), so post-render SVG sanitizing alone is too late. Rejected: any URL shape
 *  (scheme + // or scheme + \\, protocol-relative //), and the `img:` shape data of the
 *  flowchart node syntax `A@{ img: ... }` - the one construct that loads a resource at all. */
export function guardDiagramSource(src: string): void {
  // judge the DECODED text: mermaid resolves \uXXXX, \xXX and HTML entities in shape data and
  // labels before it acts on them, so an escaped `//` or a quoted, escaped `"img"` key is the
  // same request in the end. Directives and front matter are gone by now (cleanSource) - a
  // themeCSS with url() never reaches the renderer either way, url( is refused here too.
  const text = decodeEscapes(src)
  if (/(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(text) || /[a-z][a-z0-9+.-]*:\\/i.test(text)) throw new Error('URLs are not allowed in diagram source - use local design/assets/ images in an Img block instead')
  if (/url\s*\(/i.test(text) || /@import\b/i.test(text)) throw new Error('external resources are not allowed in diagram source')
  if (/@\s*\{/.test(text) && /["'`]?\s*img\s*["'`]?\s*:/i.test(text)) throw new Error('image shapes are not allowed in diagram source')
  if (/%%\s*\{/.test(text) || /^\s*---/.test(text)) throw new Error('directives are not allowed in diagram source')
}
/** \uXXXX, \u{...}, \xXX and numeric/named HTML entities -> the characters they stand for. */
export function decodeEscapes(src: string): string {
  return src
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&sol;/gi, '/').replace(/&bsol;/gi, '\\').replace(/&colon;/gi, ':').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
}

/** Remove external URL references from rendered SVG (images, links, href attrs). */
export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const external = (v: string | null) => !!v && !v.trim().startsWith('#') && !v.trim().startsWith('data:')
  for (const el of [...doc.querySelectorAll('image')]) el.remove()
  for (const el of [...doc.querySelectorAll('script, foreignObject iframe')]) el.remove()
  for (const el of [...doc.querySelectorAll('*')]) {
    for (const attr of ['href', 'xlink:href']) {
      if (external(el.getAttribute(attr))) el.removeAttribute(attr)
    }
  }
  return new XMLSerializer().serializeToString(doc.documentElement)
}

export function Diagram({ title, children }: { title?: string; children?: ReactNode }) {
  const src = withFamilies(withLabelHierarchy(cleanSource(
    typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : String(children ?? ''),
  )))
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const uid = useRef(`mv-mmd-${++uidSeq}`)

  useEffect(() => {
    let live = true
    let seq = 0
    let renderSeq = 0
    const render = async () => {
      const mySeq = ++seq
      diagramsBusy++
      try {
        // the zero-external-request boundary must hold BEFORE render: mermaid's image
        // shapes fetch their URL during render(), so post-render SVG sanitizing alone
        // would be too late. Reject ANY URL shape - absolute (scheme://) and
        // protocol-relative (//host) alike; neither has a place in diagram source.
        guardDiagramSource(src)
        const mermaid = (await import('mermaid')).default
        if (!live || mySeq !== seq) return
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: themeVars(isDark()),
          themeCSS: THEME_CSS,
          fontFamily: FONT_STACK,
        })
        // unique id per render: mermaid mounts a temp element under it, and a
        // superseded render must never collide with the one that lands
        const { svg } = await mermaid.render(`${uid.current}-${++renderSeq}`, src)
        if (!live || mySeq !== seq || !ref.current) return   // superseded by a newer theme - discard
        ref.current.innerHTML = sanitizeSvg(svg)
        setError(null)
      } catch (e) {
        if (live && mySeq === seq) setError(String((e as Error)?.message ?? e))
      } finally { diagramsBusy-- }
    }
    render()
    // the bridge mutates <html data-theme>/.dark with no React event - observe and re-render
    const mo = new MutationObserver(render)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    return () => { live = false; mo.disconnect() }
  }, [src])

  return (
    <figure className="mv-block mv-diagram">
      {/* the render target stays MOUNTED through errors - a healed source or theme
          re-render must find its ref alive to clear the card */}
      {error && <div className="mv-diagram-err"><b>diagram error</b><span>{error}</span><span className="dim">fix the mermaid source - the frame heals live</span></div>}
      <div className="mv-diagram-svg" ref={ref} style={error ? { display: 'none' } : undefined} />
      {title && <figcaption>{title}</figcaption>}
    </figure>
  )
}
