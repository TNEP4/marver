/**
 * Textures at publish time (spec 16, published canvases).
 *
 * A published canvas is a static site with no compiler, so its glass stayed live and a shared hi-fi
 * board flashed on pan and zoom as before 0.18.0. Everything the compiler needs is known when the
 * site is built: the published boards, every node's frame and size on them, and the themes a
 * visitor can flip to. So the build serves design/.dist to itself on a loopback port, compiles every
 * (frame, theme, size) against the PUBLISHED document - the one visitors get, not the dev one - with
 * the same certification as the dev server (bake.ts), ships the certified textures under
 * design/.dist/__mv/bakes/<build>/ and writes one static index the shell reads instead of asking a
 * server. Anything the compiler refuses is simply absent from the index: that frame sleeps with the
 * pause alone, glass live, as today. No Chrome on the build machine: the note is printed and the
 * site ships without textures.
 */
import { copyFileSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { ASK_MAX, bakeBatch, type BakeAnswer, type BakeAsk } from './bake.ts'
import { findChrome } from './cdp.ts'
import { MIME } from './serve.ts'
import { planShot } from './shot.ts'
import { slideSize } from '../client/const.ts'

export interface PublishedIndex { gen: number; answers: Record<string, { ok: true; targets: NonNullable<Extract<BakeAnswer, { ok: true }>['targets']> }> }

/** The shell's plain key for an ask (sleep.ts keyOf): frame|theme|w|h. */
export const indexKey = (a: BakeAsk) => `${a.frame}|${a.theme}|${Math.round(a.w)}|${Math.round(a.h)}`

export interface PublishedFrame { id: string; kind: 'tsx' | 'html'; file: string; viewport?: string; contentWidth?: number; slide?: boolean }
type Node = { frame?: string; w?: number; h?: number }

/** Every (frame, theme, size) a visitor can rest on: each published board's nodes, sized the way
 *  the shell sizes them (the node's own size, else the frame's default), each theme; the published
 *  `all-scenes` board shows every frame at its default size. Sizes are rounded first, then held to
 *  the compiler's limits: an oversize node is skipped, never clamped to a document of another size. */
export function publishedAsks(boards: Record<string, { nodes?: Node[] }>, themes: string[], frames: PublishedFrame[], viewports: Record<string, { width: number; height: number }>, allScenes = false): BakeAsk[] {
  const byId = new Map(frames.map((f) => [f.id, f]))
  const seen = new Map<string, BakeAsk>()
  const add = (frame: string, w: number, h: number) => {
    w = Math.round(w); h = Math.round(h)
    if (!(w >= 120) || !(h >= 80) || w > ASK_MAX.side || h > ASK_MAX.side || w * h > ASK_MAX.area) return
    for (const theme of themes.length ? themes : ['light']) { const ask = { frame, theme, w, h }; seen.set(indexKey(ask), ask) }
  }
  // each dimension the node stores, else the frame's default (the shell's rule); a content-sized
  // frame takes its height from a measurement the canvas makes, so without a stored height it
  // rests live (never a texture for a height that is a guess)
  const size = (f: PublishedFrame, n?: Node): { w: number; h: number } | null => {
    // a slide's document is its stage whatever its node's size - the node only scales it
    const sl = slideSize(f, viewports)
    if (sl) return { w: sl.width, h: sl.height }
    const nw = n && typeof n.w === 'number' && n.w > 0 ? n.w : undefined, nh = n && typeof n.h === 'number' && n.h > 0 ? n.h : undefined
    const p = planShot(f, viewports, {})
    if (p.fullHeight && !nh) return null   // the canvas measures this frame's height
    return { w: nw ?? p.width, h: nh ?? p.initialHeight }
  }
  for (const b of Object.values(boards)) for (const n of b?.nodes ?? []) {
    const f = typeof n?.frame === 'string' ? byId.get(n.frame) : undefined
    const s = f && size(f, n)
    if (s) add(f!.id, s.w, s.h)
  }
  if (allScenes) for (const f of frames) { const s = size(f); if (s) add(f.id, s.w, s.h) }
  return [...seen.values()]
}

/** The index: only answers that certified at least one texture, and only their certified targets
 *  (a refused target's selector ships nothing); everything else is absent. */
export function publishedIndex(gen: number, answers: BakeAnswer[]): PublishedIndex {
  const out: PublishedIndex = { gen, answers: {} }
  for (const a of answers) {
    if (!a.ok) continue
    const targets = a.targets.filter((t) => t.verified && t.texture)
    if (targets.length) out.answers[indexKey(a)] = { ok: true, targets }
  }
  return out
}

/** Serve `dir` on a loopback port the way `marver serve` does (extensionless = index.html). */
function serveDir(dir: string): Promise<{ origin: string; close: () => void }> {
  const real = realpathSync(dir)
  const server = createServer((req, res) => {
    let path = ''
    try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname) } catch { res.statusCode = 400; return res.end() }
    if (path.endsWith('/')) path += 'index.html'
    let file = resolve(dir, path.slice(1))
    try { const r = realpathSync(file); if (relative(real, r).startsWith('..') || isAbsolute(relative(real, r))) throw 0; file = r } catch { file = join(dir, 'index.html') }
    if (!extname(file)) file = join(dir, 'index.html')
    try { const c = readFileSync(file); res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream'); res.end(c) } catch { res.statusCode = 404; res.end() }
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => { const a = server.address() as { port: number }; ok({ origin: `http://127.0.0.1:${a.port}`, close: () => server.close() }) }))
}

export interface PublishedBakes { asked: number; asleep: number; live: number; plain: number; bytes: number; ms: number }

/** Compile the published boards' frames against the built site and ship the textures with it.
 *  Returns null when there is no Chrome to compile with. */
export async function bakePublished(opts: {
  root: string; outDir: string; gen: number
  boards: Record<string, { nodes?: Node[] }>; themes: string[]; frames: PublishedFrame[]; viewports: Record<string, { width: number; height: number }>; allScenes?: boolean
  urlFor: (frame: string, theme: string) => string | null; log?: (line: string) => void
}): Promise<PublishedBakes | null> {
  const { root, outDir, gen, boards, themes, frames, viewports, allScenes, urlFor, log } = opts
  if (!findChrome()) return null
  const t0 = Date.now()
  const asks = publishedAsks(boards, themes, frames, viewports, allScenes).filter((a) => urlFor(a.frame, a.theme))
  const stats: PublishedBakes = { asked: asks.length, asleep: 0, live: 0, plain: 0, bytes: 0, ms: 0 }
  if (!asks.length) return stats
  const cache = join(root, 'design', '.local', 'bakes', String(gen))
  const site = await serveDir(outDir)
  let answers: BakeAnswer[]
  try {
    answers = await bakeBatch({ root, gen, asks, urlBase: '/__mv/bakes', urlFor: (a) => site.origin + urlFor(a.frame, a.theme)! })
    // ship the certified PNGs and one index, nothing else (no bake.json, no owner, no refused target);
    // a texture that is not a regular file of THIS generation's cache drops its whole answer; the
    // index is written last, so a reader never sees it before its textures
    const index = publishedIndex(gen, answers)
    const to = join(outDir, '__mv', 'bakes')
    rmSync(to, { recursive: true, force: true })
    const grammar = new RegExp(`^/__mv/bakes/${gen}/[0-9a-f]{16}/\\d+\\.png$`)
    const realCache = (() => { try { return realpathSync(cache) } catch { return null } })()
    for (const [key, a] of Object.entries(index.answers)) {
      const files: [string, string][] = []
      const ok = realCache !== null && a.targets.every((t) => {
        if (!grammar.test(t.texture)) return false
        const from = join(root, 'design', '.local', 'bakes', t.texture.replace(/^\/__mv\/bakes\//, ''))
        try { if (!lstatSync(from).isFile()) return false; if (!realpathSync(from).startsWith(realCache + '/')) return false } catch { return false }
        files.push([from, join(outDir, t.texture.slice(1))])
        return true
      })
      if (!ok) { delete index.answers[key]; continue }
      for (const [from, dest] of files) { mkdirSync(join(dest, '..'), { recursive: true }); copyFileSync(from, dest); stats.bytes += statSync(dest).size }
    }
    mkdirSync(join(to, String(gen)), { recursive: true })
    writeFileSync(join(to, String(gen), 'index.json'), JSON.stringify(index))
    // the totals come from the answers and the index, not from what happened to be logged
    for (const a of answers) {
      if (!a.ok) { stats.live++; log?.(`  bake: ${a.frame} ${a.theme} ${a.w}x${a.h} - stays live: ${a.error}`); continue }
      if (!(a.effects ?? a.targets.length)) { stats.plain++; continue }   // no backdrop-filter at all
      if (!a.targets.length) { stats.live++; log?.(`  bake: ${a.frame} ${a.theme} ${a.w}x${a.h} - ${a.effects} effects, all nested, stay live`); continue }
      const shipped = index.answers[indexKey(a)]?.targets.length ?? 0
      if (shipped) stats.asleep++; else stats.live++
      log?.(`  bake: ${a.frame} ${a.theme} ${a.w}x${a.h} - ${a.targets.length} effects, ${a.targets.length - shipped} stay live, ${a.ms} ms`)
    }
  } finally {
    site.close()
    rmSync(cache, { recursive: true, force: true })   // this build's generation only; another server's cache is its own
  }
  stats.ms = Date.now() - t0
  return stats
}
