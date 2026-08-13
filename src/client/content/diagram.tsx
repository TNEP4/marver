/**
 * The Diagram block - first-class Mermaid (SPEC-026).
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

const isDark = () =>
  document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark'

/** Strip yaml frontmatter and %%{...}%% directives - diagram source cannot re-theme itself. */
export function cleanSource(src: string): string {
  return src
    .replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/%%\{[\s\S]*?\}%%/g, '')
    .trim()
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
  const src = cleanSource(
    typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : String(children ?? ''),
  )
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const uid = useRef(`mv-mmd-${++uidSeq}`)

  useEffect(() => {
    let live = true
    let seq = 0
    let renderSeq = 0
    const render = async () => {
      const mySeq = ++seq
      try {
        // the zero-external-request boundary must hold BEFORE render: mermaid's image
        // shapes fetch their URL during render(), so post-render SVG sanitizing alone
        // would be too late. Reject ANY URL shape - absolute (scheme://) and
        // protocol-relative (//host) alike; neither has a place in diagram source.
        if (/(?:\w+:)?\/\//.test(src)) throw new Error('URLs are not allowed in diagram source - use local design/assets/ images in an Img block instead')
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
      }
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
