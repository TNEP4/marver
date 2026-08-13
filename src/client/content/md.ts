/**
 * Markdown rendering for the Md block (SPEC-026 security section).
 * Raw HTML is inert (escaped, never parsed). Links and images have SEPARATE
 * policies: links may be goto:/http(s)/mailto (external ones open a new tab,
 * never navigate the iframe); images are local-only - design/assets/ paths.
 */
import { Marked } from 'marked'

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Relative design/assets/ path -> served URL; null for anything else (fail closed). */
export function assetUrl(src: string): string | null {
  const p = String(src ?? '').trim()
  if (!p || p.includes('://') || p.includes(':') || p.startsWith('/') || p.startsWith('\\')) return null
  if (p.split('/').some((seg) => seg === '..' || seg === '')) return null
  return `/design/assets/${p}`
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

export function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string
}
