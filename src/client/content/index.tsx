/**
 * Content-frame block primitives (SPEC-026): Doc, Row, Col, Space, Md, Diagram, Img.
 * One vocabulary at two scales: boards arrange frames in rows/columns with space
 * units; these primitives do the same for blocks INSIDE a frame - as CSS flex,
 * deliberately NOT the SPEC-024 lane grammar (shared vocabulary, not semantics).
 *
 * Doc owns the measurement protocol: it reports its content height so the shell
 * can give the frame a natural size (the shell alone owns node dimensions).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CONTENT_WIDTH } from '../const.ts'
import { assetUrl, renderMarkdown, FAMILIES } from './md.ts'
import { lodSupported, registerLodImage } from './img-lod.ts'

// D3: family color classes for inline Md (`:blue[...]`), theme-aware (frames carry .dark + [data-theme])
const FAMILY_CSS = Object.entries(FAMILIES).map(([f, c]) =>
  `.mv-md .mv-c-${f}{color:${c.light}}.dark .mv-md .mv-c-${f},[data-theme="dark"] .mv-md .mv-c-${f}{color:${c.dark}}`).join('\n')

export { Diagram } from './diagram.tsx'

const UNIT = 16   // one gap unit, px - plain adjacency on boards is one gutter; same feel here

/* ---------------------------------- Doc ---------------------------------- */

export function Doc({ layout = 'document', children }: { layout?: 'document' | 'wide'; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ensureStyles()
    const el = ref.current
    if (!el || window.parent === window) return
    let t: ReturnType<typeof setTimeout> | undefined
    const params = new URLSearchParams(location.search)
    const post = () => {
      window.parent.postMessage({
        type: 'sh:measure',
        // identity guards: board files may reuse node keys (frame id must match), and
        // a WindowProxy survives navigation (gen = THIS document's URL rev - the shell
        // drops echoes that don't match the iframe's current src)
        frame: params.get('id') ?? '',
        gen: params.get('r') ?? '',
        ownWidth: CONTENT_WIDTH[layout] ?? CONTENT_WIDTH.document,
        measuredWidth: window.innerWidth,          // the width this height is TRUE at (r3 #1)
        height: Math.ceil(el.getBoundingClientRect().height),
      }, '*')
    }
    // debounced ~300ms after the last content change; the shell guards staleness
    // on its side (event.source must map to a mounted iframe; reflow is board-scoped)
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(post, 300) })
    ro.observe(el)
    post()
    return () => { ro.disconnect(); clearTimeout(t) }
  }, [layout])
  return <div ref={ref} className={`mv-doc mv-doc-${layout}`}>{children}</div>
}

/* ----------------------------- layout blocks ------------------------------ */

export function Row({ space = 1, children }: { space?: number; children?: ReactNode }) {
  return <div className="mv-row" style={{ gap: space * UNIT }}>{children}</div>
}

export function Col({ space = 1, children }: { space?: number; children?: ReactNode }) {
  return <div className="mv-col" style={{ gap: space * UNIT }}>{children}</div>
}

export function Space({ n = 1 }: { n?: number }) {
  return <div aria-hidden className="mv-space" style={{ flex: `0 0 ${n * UNIT}px`, minWidth: n * UNIT, minHeight: n * UNIT }} />
}

/* ---------------------------------- Md ------------------------------------ */

export function Md({ children }: { children?: ReactNode }) {
  const src = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : String(children ?? '')
  const html = useMemo(() => renderMarkdown(src), [src])
  return <div className="mv-md" dangerouslySetInnerHTML={{ __html: html }} />
}

/* ---------------------------------- Img ----------------------------------- */

export function Img({ src, caption, alt, h }: { src: string; caption?: string; alt?: string; h?: number }) {
  const url = assetUrl(src)
  const [err, setErr] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // LOD: paint the image on a <canvas> decoded to its on-screen size (never the full 17MB bitmap), and
  // re-pick resolution only when the canvas settles after a zoom. See img-lod.ts. Falls back to a plain
  // <img> where createImageBitmap/bitmaprenderer isn't available (correctness over the optimization).
  useEffect(() => {
    if (!url || err || !lodSupported || !canvasRef.current) return
    return registerLodImage(canvasRef.current, url)
  }, [url, err])
  if (!url || err) {
    return (
      <div className="mv-block mv-imgerr">
        <b>image unavailable</b>
        <span>{src}</span>
        {!url && <span className="dim">must be a relative path inside design/assets/</span>}
      </div>
    )
  }
  // A reference image ALWAYS shows in full: it fills its column at its natural aspect ratio, never
  // cropped and never letterboxed. Equal-aspect images (e.g. a row of screenshots) line up on their own,
  // and the frame auto-heights to fit. `h` is accepted for back-compat but no longer constrains size -
  // capping height below natural would force the image narrower than its column (whitespace) or slice it
  // (the old object-fit:cover). Width:100% + height:auto come from the .mv-img-el rule.
  void h
  const style = undefined
  return (
    <figure className="mv-block mv-img">
      {lodSupported
        ? <canvas ref={canvasRef} className="mv-img-el" role="img" aria-label={alt ?? caption ?? ''} style={style} />
        : <img className="mv-img-el" src={url} alt={alt ?? caption ?? ''} loading="lazy" style={style} onError={() => setErr(true)} />}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  )
}

/* --------------------------------- styles --------------------------------- */

/** Injected once per document. Content frames paint their own surface and read
 *  the frame theme from the bridge's signals (html.dark / [data-theme]). */
let stylesIn = false
function ensureStyles() {
  if (stylesIn || document.getElementById('mv-content-css')) { stylesIn = true; return }
  stylesIn = true
  const el = document.createElement('style')
  el.id = 'mv-content-css'
  el.textContent = CSS + '\n' + FAMILY_CSS
  document.head.appendChild(el)
}

const CSS = `
/* only content frames inject this stylesheet, and their document is the Doc -
   zeroing the body margin makes the measured height the truth (a min-height
   would echo the frame's own height back and the measurement could never shrink) */
body { margin: 0; }
.mv-doc {
  --mv-bg: #FFFFFF; --mv-surface: #F7F7F9; --mv-line: #D1D1D6; --mv-line-soft: #E5E5EA;
  --mv-text: #1C1C1E; --mv-muted: #636366; --mv-faint: #8E8E93; --mv-accent: #0088FF;
  --mv-block-bg: rgba(20, 22, 28, 0.02); --mv-block-line: rgba(20, 22, 28, 0.07);
  box-sizing: border-box; width: 100%;
  background: var(--mv-bg); color: var(--mv-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased;
  padding: 40px; display: flex; flex-direction: column; gap: ${UNIT}px;
}
.dark .mv-doc, [data-theme="dark"] .mv-doc {
  --mv-bg: #1C1C1E; --mv-surface: #26262A; --mv-line: #3A3A3C; --mv-line-soft: #2C2C2E;
  --mv-text: #F2F2F7; --mv-muted: #AEAEB2; --mv-faint: #8E8E93; --mv-accent: #0091FF;
  --mv-block-bg: rgba(255, 255, 255, 0.025); --mv-block-line: rgba(255, 255, 255, 0.07);
}
.mv-doc * { box-sizing: border-box; }
.mv-row { display: flex; flex-wrap: wrap; align-items: flex-start; }
.mv-row > * { flex: 1 1 260px; min-width: 0; }
.mv-row > .mv-space { flex: none; }
.mv-col { display: flex; flex-direction: column; min-width: 0; }

/* the rubber: diagram + image blocks own their breathing room. The surface is
   a whisper, not a card - the content pops, the block only frames it */
.mv-block { margin: 0; padding: ${UNIT}px; border: 1px solid var(--mv-block-line);
  border-radius: 10px; background: var(--mv-block-bg); }
.mv-block figcaption, .mv-img figcaption { font-size: 12.5px; color: var(--mv-faint); padding-top: 8px; }
.mv-diagram-svg { display: flex; justify-content: center; }
.mv-diagram-svg svg { max-width: 100%; height: auto; }
.mv-diagram-err { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--mv-muted);
  font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.mv-diagram-err b { color: #E0402F; font-family: inherit; }
.mv-diagram-err .dim, .mv-imgerr .dim { color: var(--mv-faint); font-size: 12px; }
.mv-img .mv-img-el { display: block; width: 100%; height: auto; max-width: 100%; border-radius: 6px; }
.mv-imgerr { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--mv-muted); }
.mv-imgerr b { color: #E0402F; }

/* markdown typography - the HIG scale, Notion's calm. Body 16 on generous
   leading; headings tighten tracking as they grow (SF behavior); sections
   breathe ABOVE far more than below, so structure reads at a glance. Every
   list-style is re-asserted: host Tailwind preflight strips markers. */
.mv-md { max-width: 72ch; min-width: 0; font-size: 16px; line-height: 1.65; }
.mv-md > :first-child { margin-top: 0; }
.mv-md > :last-child { margin-bottom: 0; }
.mv-md h1 { font-size: 30px; line-height: 1.16; letter-spacing: -0.021em; font-weight: 700; margin: 44px 0 14px; }
.mv-md h2 { font-size: 22px; line-height: 1.22; letter-spacing: -0.017em; font-weight: 700; margin: 40px 0 12px; }
.mv-md h3 { font-size: 18px; line-height: 1.3; letter-spacing: -0.01em; font-weight: 650; margin: 30px 0 8px; }
.mv-md h4, .mv-md h5, .mv-md h6 { font-size: 15px; font-weight: 650; margin: 24px 0 6px; }
.mv-md p { margin: 0 0 14px; }
.mv-md ul, .mv-md ol { margin: 0 0 14px; padding-left: 26px; }
.mv-md ul { list-style: disc; }
.mv-md ul ul { list-style: circle; }
.mv-md ol { list-style: decimal; }
.mv-md li { margin-bottom: 5px; }
.mv-md li::marker { color: var(--mv-faint); }
.mv-md li:has(> input[type="checkbox"]) { list-style: none; margin-left: -26px; }
.mv-md a { color: var(--mv-accent); text-decoration: none; }
.mv-md a[data-goto] { border-bottom: 1px dashed var(--mv-accent); cursor: pointer; }
.mv-md blockquote { margin: 4px 0 16px; padding: 2px 0 2px 18px; border-left: 3px solid var(--mv-text);
  color: var(--mv-text); }
.mv-md blockquote p:last-child { margin-bottom: 0; }
.mv-md code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.85em;
  background: var(--mv-surface); border: 1px solid var(--mv-line-soft); border-radius: 5px; padding: 1.5px 6px; }
.mv-md pre { background: var(--mv-surface); border: 1px solid var(--mv-line-soft); border-radius: 10px;
  padding: 16px 18px; overflow-x: auto; margin: 0 0 16px; }
.mv-md pre code { background: none; border: 0; padding: 0; font-size: 13px; line-height: 1.65; }
/* tables are CONTAINED (Notion): outer border + radius, header surface, row hairlines */
.mv-md table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 4px 0 18px;
  font-size: 14.5px; border: 1px solid var(--mv-line-soft); border-radius: 10px; overflow: hidden; }
.mv-md th, .mv-md td { text-align: left; padding: 9px 14px; }
.mv-md th { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600;
  color: var(--mv-faint); background: var(--mv-surface); border-bottom: 1px solid var(--mv-line-soft); }
.mv-md td { border-bottom: 1px solid var(--mv-line-soft); }
.mv-md tr:last-child td { border-bottom: 0; }
.mv-md img { max-width: 100%; border-radius: 8px; }
.mv-md hr { border: 0; border-top: 1px solid var(--mv-line-soft); margin: 32px 0; }
.mv-md input[type="checkbox"] { appearance: auto; accent-color: var(--mv-accent); width: 15px; height: 15px;
  margin: 0 8px 0 0; vertical-align: -2px; }
.mv-md-noimg { font-size: 13px; color: var(--mv-faint); font-style: italic; }
`
