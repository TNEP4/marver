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
import { assetUrl, renderMarkdown } from './md.ts'

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

export function Img({ src, caption, alt }: { src: string; caption?: string; alt?: string }) {
  const url = assetUrl(src)
  const [err, setErr] = useState(false)
  if (!url || err) {
    return (
      <div className="mv-block mv-imgerr">
        <b>image unavailable</b>
        <span>{src}</span>
        {!url && <span className="dim">must be a relative path inside design/assets/</span>}
      </div>
    )
  }
  return (
    <figure className="mv-block mv-img">
      <img src={url} alt={alt ?? caption ?? ''} loading="lazy" onError={() => setErr(true)} />
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
  el.textContent = CSS
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
.mv-img img { display: block; max-width: 100%; border-radius: 6px; }
.mv-imgerr { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--mv-muted); }
.mv-imgerr b { color: #E0402F; }

/* markdown typography: measure + rhythm */
.mv-md { max-width: 72ch; min-width: 0; }
.mv-md > :first-child { margin-top: 0; }
.mv-md > :last-child { margin-bottom: 0; }
.mv-md h1 { font-size: 28px; line-height: 1.2; letter-spacing: -0.015em; margin: 28px 0 12px; }
.mv-md h2 { font-size: 21px; line-height: 1.25; letter-spacing: -0.01em; margin: 24px 0 10px; }
.mv-md h3 { font-size: 17px; margin: 20px 0 8px; }
.mv-md h4, .mv-md h5, .mv-md h6 { font-size: 15px; margin: 16px 0 6px; }
.mv-md p, .mv-md ul, .mv-md ol { margin: 0 0 12px; }
.mv-md ul, .mv-md ol { padding-left: 24px; }
.mv-md li { margin-bottom: 4px; }
.mv-md a { color: var(--mv-accent); text-decoration: none; }
.mv-md a[data-goto] { border-bottom: 1px dashed var(--mv-accent); cursor: pointer; }
.mv-md blockquote { margin: 0 0 12px; padding: 4px 16px; border-left: 3px solid var(--mv-line);
  color: var(--mv-muted); }
.mv-md code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.88em;
  background: var(--mv-surface); border: 1px solid var(--mv-line-soft); border-radius: 4px; padding: 1px 5px; }
.mv-md pre { background: var(--mv-surface); border: 1px solid var(--mv-line-soft); border-radius: 8px;
  padding: 14px 16px; overflow-x: auto; margin: 0 0 12px; }
.mv-md pre code { background: none; border: 0; padding: 0; font-size: 12.5px; line-height: 1.6; }
.mv-md table { border-collapse: collapse; width: 100%; margin: 0 0 12px; font-size: 14px; }
.mv-md th, .mv-md td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--mv-line-soft); }
.mv-md th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--mv-faint); }
.mv-md img { max-width: 100%; border-radius: 6px; }
.mv-md hr { border: 0; border-top: 1px solid var(--mv-line-soft); margin: 20px 0; }
.mv-md input[type="checkbox"] { margin-right: 6px; }
.mv-md-noimg { font-size: 13px; color: var(--mv-faint); font-style: italic; }
`
