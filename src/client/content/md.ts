/**
 * Markdown rendering for the Md block.
 * Raw HTML is inert (escaped, never parsed). Links and images have SEPARATE
 * policies: links may be goto:/http(s)/mailto (external ones open a new tab,
 * never navigate the iframe); images are local-only - design/assets/ paths.
 */
import { Marked } from 'marked'

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

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
    // raw HTML (block or inline) renders as its literal text - inert by construction
    html(token: any) { return escapeHtml(String(token.text ?? '')) },
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
