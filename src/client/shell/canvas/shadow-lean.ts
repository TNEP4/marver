// SPEC-M8 - render a prebuilt lean ARTIFACT into a Shadow DOM host instead of an <iframe>.
//
// WHY: the whole-viewport white-flash on heavy boards is a GPU compositor eviction - `.sh-content`
// (the rzpp scale surface) is kept UN-promoted because promoting it (will-change:transform) blanks
// nested <iframe>s. Each lean frame being an iframe is what forces `.sh-content` un-promoted, so every
// zoom re-rasterises the whole canvas -> tile budget blown -> white. Rendering the lean in a Shadow DOM
// host (same document, style-isolated) removes the nested iframe: the canvas becomes ONE compositing
// layer, `.sh-content` can be promoted, and a zoom scales a cached texture with no re-raster. Still the
// crisp post-render DOM (no bitmap), still theme-flippable. Confirmed: served same-origin, the artifact's
// root-relative asset URLs (/logos/x.svg) resolve fine in Shadow DOM - no <base>, no compiler change.
//
// The artifact HTML has JS stripped at compile time, so injecting its body via innerHTML runs nothing.

type Parts = { css: string; body: string }
const cache = new Map<string, Parts>()          // href -> parsed parts (artifacts are immutable)
const inflight = new Map<string, Promise<Parts>>()

/** Shadow DOM has no html/body/:root - remap those page-level selectors to :host so the artifact's
 *  resets, custom properties and body background apply to the host box. Matches the compile spike. */
function remap(css: string): string {
  return css
    .replace(/(^|[{},;])\s*:root\b/g, '$1:host')
    .replace(/(^|[{},;>~+])\s*html\b/g, '$1:host')
    .replace(/(^|[{},;>~+])\s*body\b/g, '$1:host')
}

async function fetchParts(href: string): Promise<Parts> {
  const hit = cache.get(href); if (hit) return hit
  const pending = inflight.get(href); if (pending) return pending
  const p = (async () => {
    const html = await (await fetch(href)).text()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const css = remap(Array.from(doc.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n'))
    const parts: Parts = { css, body: doc.body?.innerHTML ?? '' }
    cache.set(href, parts)
    inflight.delete(href)
    return parts
  })()
  inflight.set(href, p)
  return p
}

/** Populate `host`'s shadow root with the artifact at `href` (crisp static DOM + inlined CSS). Sets
 *  data-theme on the host for the artifact's [data-theme] rules. Resolves true on success. A concurrent
 *  theme flip may call this again with a new href - guarded by a per-host token so a slow older fetch
 *  can't overwrite a newer one. */
export async function applyShadowLean(host: HTMLElement, href: string, theme: string): Promise<boolean> {
  const el = host as HTMLElement & { __mvToken?: number }
  const token = (el.__mvToken = (el.__mvToken ?? 0) + 1)
  try {
    const { css, body } = await fetchParts(href)
    if (el.__mvToken !== token || !el.isConnected) return false     // superseded / unmounted
    const sr = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    host.setAttribute('data-theme', theme)
    sr.innerHTML = `<style>${css}</style>${body}`
    return true
  } catch { return false }
}
