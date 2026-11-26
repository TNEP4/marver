/**
 * A drawing's PDF (spec 38): its SVG - Excalidraw's own export, its fonts inlined as subsets - printed by the system's
 * Chrome, so the PDF is vectors and real text (sharp at any zoom, a few dozen KB), never a picture of the drawing.
 *
 * The SVG is the owner's own drawing, yet it is only ever rendered - as an IMAGE (`<img src="data:image/svg+xml…">`):
 * an SVG image runs no script, loads nothing but `data:`, embeds no frame (a sandboxed iframe smuggled after the SVG
 * would otherwise run in a process of its own, out of reach of the tab's switches - Codex, release review). On top: a
 * single SVG document is required (nothing after its `</svg>`, no script, frame, object or embed in it), the page's CSP
 * allows only `data:` images, inline styles and nothing else, scripts are off and every network request is refused.
 * One Chrome per export, closed at once; 20 s at most.
 */
import { PDFDocument } from 'pdf-lib'
import { Browser } from '../cdp.ts'

export class DrawPdfError extends Error {}

/** The SVG's own size in CSS px (its width/height attributes, else its viewBox). */
export function svgSize(svg: string): { w: number; h: number } | null {
  const head = svg.slice(0, 2000)
  const num = (re: RegExp) => { const m = re.exec(head); return m ? Number(m[1]) : NaN }
  let w = num(/\bwidth="([\d.]+)(?:px)?"/), h = num(/\bheight="([\d.]+)(?:px)?"/)
  if (!(w > 0 && h > 0)) {
    const vb = /\bviewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"/.exec(head)
    if (vb) { w = Number(vb[1]); h = Number(vb[2]) }
  }
  return w > 0 && h > 0 && w <= 20000 && h <= 20000 ? { w: Math.ceil(w), h: Math.ceil(h) } : null
}

/** One page, the drawing's size, vectors. */
export async function svgToPdf(svg: string, title: string): Promise<Uint8Array> {
  if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg)) throw new DrawPdfError('not an SVG')
  // one SVG document: it ends with its own </svg>, and holds no browsing context or script
  if (!/<\/svg>\s*$/.test(svg) || (svg.match(/<svg[\s>]/g) ?? []).length !== (svg.match(/<\/svg>/g) ?? []).length) throw new DrawPdfError('not a single SVG document')
  if (/<\s*(script|iframe|frame|object|embed|foreignObject|portal|fencedframe)\b/i.test(svg)) throw new DrawPdfError('the SVG holds active content')
  const size = svgSize(svg)
  if (!size) throw new DrawPdfError('the SVG has no size')
  const src = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>@page{size:${size.w}px ${size.h}px;margin:0}html,body{margin:0;padding:0}img{display:block;width:${size.w}px;height:${size.h}px}</style></head><body><img src="${src}" alt=""></body></html>`
  const b = await Browser.launch('mv-shot-')
  const timer = setTimeout(() => { void b.close() }, 20_000)
  try {
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true })
    await b.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId)
    await b.send('Network.enable', {}, sessionId)
    await b.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'file://*', 'ws://*', 'wss://*'] }, sessionId)
    await b.send('Page.enable', {}, sessionId)
    const { frameTree } = await b.send('Page.getFrameTree', {}, sessionId)
    await b.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sessionId)
    // the inlined fonts decode before the print (scripts are off for the page, not for this evaluation)
    // the image decoded (its inlined fonts with it) before the print
    try { await b.send('Runtime.evaluate', { expression: 'document.images[0].decode().then(() => true, () => false)', awaitPromise: true, returnByValue: true }, sessionId) }
    catch { await new Promise((r) => setTimeout(r, 500)) }
    const pr = await b.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 }, sessionId)
    const doc = await PDFDocument.load(Buffer.from(pr.data, 'base64'))
    // one page: a print that spilled keeps its first
    while (doc.getPageCount() > 1) doc.removePage(doc.getPageCount() - 1)
    doc.setTitle(title || 'Drawing')
    doc.setCreator('Marver')
    doc.setProducer('Marver (Chrome)')
    return await doc.save({ useObjectStreams: false })
  } finally {
    clearTimeout(timer)
    await b.close().catch(() => {})
  }
}
