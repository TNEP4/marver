/**
 * Markdown rendering for the Md block.
 * Raw HTML is inert (escaped, never parsed). Links and images have SEPARATE
 * policies: links may be goto:/http(s)/mailto (external ones open a new tab,
 * never navigate the iframe); images are local-only - design/assets/ paths.
 */
import { Marked } from 'marked'

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
/** Prose text: markup escaped, but an entity the author wrote (`&copy;`, `&#x41;`) keeps its
 *  meaning - marked's own rule; a raw `<` is still never a tag. */
const escapeText = (s: string) => s.replace(/&(?!#?\w+;)|[<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** D3: named color families for inline Md - the SAME families the diagrams use, so prose and
 *  the diagram beside it speak one color language. Theme pairs (light/dark). Bound to classes,
 *  never raw HTML (raw HTML stays inert). Used by the `:family[text]` extension + the frame CSS. */
export const FAMILIES: Record<string, { light: string; dark: string }> = {
  blue:   { light: '#0088FF', dark: '#3B9DFF' },
  orange: { light: '#F5820A', dark: '#FF9F33' },
  purple: { light: '#B32BC8', dark: '#D34FE8' },
  green:  { light: '#1FA34A', dark: '#34C759' },
  red:    { light: '#E5342B', dark: '#FF453A' },
  gray:   { light: '#8B95A3', dark: '#7D8794' },
}
const FAMILY_RE = new RegExp(`^:(${Object.keys(FAMILIES).join('|')})\\[([^\\]\\n]+)\\]`)

/** Relative design/assets/ path -> served URL; null for anything else (fail closed).
 *  Decodes BEFORE validating (a %2e%2e must not sneak past the ".." check) and
 *  re-encodes per segment, so the validated path is the path the browser requests. */
export function assetUrl(src: string): string | null {
  let p = String(src ?? '').trim()
  try { p = decodeURIComponent(p) } catch { return null }
  if (p.includes('%')) return null   // still encoded after one decode - refuse double-encoding games
  if (!p || p.includes('://') || p.includes(':') || p.startsWith('/') || p.startsWith('\\') || p.includes('\\')) return null
  if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null
  return `/design/assets/${p.split('/').map(encodeURIComponent).join('/')}`
}

const marked = new Marked({
  gfm: true,
  renderer: {
    // raw HTML (block or inline) renders as its literal text - inert by construction. Comments
    // are the exception: markdown readers never show them, an unclosed one runs to the end (#15)
    html(token: any) { return escapeHtml(String(token.text ?? '').replace(/<!--(?:-?>|[\s\S]*?(?:-->|$))/g, '')) },
    // marked leaves the text INSIDE a raw block (<script>, <style>, <pre>, <textarea>) unescaped
    // (`token.escaped`); here every text token is escaped - there is no raw block to serve
    text(token: any) {
      if (token.tokens) return this.parser.parseInline(token.tokens)
      return escapeText(String(token.text ?? ''))
    },
    link(token: any) {
      const href = String(token.href ?? '')
      const inner = this.parser.parseInline(token.tokens ?? [])
      if (href.startsWith('goto:')) {
        const target = href.slice('goto:'.length)
        return `<a href="#" data-goto="${escapeHtml(target)}">${inner}</a>`
      }
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href))
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
      return inner                       // disallowed protocol: the text, no link
    },
    image(token: any) {
      const url = assetUrl(String(token.href ?? ''))
      const alt = escapeHtml(String(token.text ?? ''))
      if (!url) return `<span class="mv-md-noimg">[image unavailable: ${alt || 'external images are not allowed'}]</span>`
      return `<img src="${escapeHtml(url)}" alt="${alt}" loading="lazy" />`
    },
  },
})

// D3: `:blue[shipper's world]` -> a family-colored span (inline markdown inside still parses).
marked.use({
  extensions: [{
    name: 'mvcolor',
    level: 'inline',
    start(src: string) { return src.match(/:(?:blue|orange|purple|green|red|gray)\[/)?.index },
    tokenizer(this: any, src: string) {
      const m = FAMILY_RE.exec(src)
      if (m) return { type: 'mvcolor', raw: m[0], family: m[1], tokens: this.lexer.inlineTokens(m[2]) }
    },
    renderer(this: any, token: any) {
      return `<span class="mv-c-${token.family}">${this.parser.parseInline(token.tokens)}</span>`
    },
  }],
})

export function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string
}

// ---- the second gate: an allowlist over the rendered DOM ----------------------------------
// renderMarkdown is built to emit only these; this pass makes that a property of the OUTPUT,
// not of every renderer branch - the shell realm (sticky notes) is more privileged than a
// frame, so the HTML it inserts is checked element by element, attribute by attribute.
const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'em', 'del', 's', 'a', 'img', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'input', 'div', 'sup', 'sub'])
export const ATTR_POLICY: Record<string, (v: string) => boolean> = {
  href: (v) => v === '#' || /^https?:\/\//i.test(v) || /^mailto:/i.test(v),
  // a frame id: any path text without markup, quotes, spaces or a scheme (ids are unicode-free
  // by convention but not by law - `checkout/café` is a real id)
  'data-goto': (v) => v.length > 0 && v.length <= 300 && !/[\s<>"'`:\\]/.test(v) && !v.split('/').some((seg) => seg === '..' || seg === ''),
  target: (v) => v === '_blank',
  rel: (v) => v === 'noopener noreferrer',
  // exactly what assetUrl emits: inside design/assets, no traversal SEGMENT (`flow..png` is a name)
  src: (v) => v.startsWith('/design/assets/') && !v.slice('/design/assets/'.length).split('/').some((seg) => seg === '..' || seg === '.' || seg === ''),
  alt: () => true, title: () => true, loading: (v) => v === 'lazy',
  class: (v) => v.split(' ').every((c) => /^(mv-|language-)[^\s"'<>]+$/.test(c)),
  align: (v) => /^(left|center|right)$/.test(v),
  type: (v) => v === 'checkbox', checked: () => true, disabled: () => true,
  start: (v) => /^\d+$/.test(v), colspan: (v) => /^\d+$/.test(v), rowspan: (v) => /^\d+$/.test(v),
}
/** Rendered markdown -> the same HTML with every element and attribute outside the allowlist
 *  removed (an element goes with its subtree; an attribute alone). Browser only (DOMParser). */
export function sanitizeMarkdownHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      if (!TAGS.has(child.tagName.toLowerCase())) { child.remove(); continue }
      for (const a of [...child.attributes]) {
        const ok = ATTR_POLICY[a.name]
        if (!ok || !ok(a.value)) child.removeAttribute(a.name)
      }
      if (child.tagName === 'INPUT') child.setAttribute('disabled', '')
      walk(child)
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}
