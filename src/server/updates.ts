/**
 * Calm updates, the dev server's half (spec 26 Part 2). Frame documents take no updates from Vite:
 * Fast Refresh is off under design/ (dev.ts) and the frame host's registry accepts every update and
 * ignores it. Marver decides which frames an edit touched, before Vite's update collapses into that
 * shared registry, and the shell reloads exactly those - a few at a time, on screen first.
 *
 * Which frames, two answers united:
 *  - by path: the edited file mapped directly - a frame, or a wrapper the frame host puts around
 *    frames (providers -> every TSX frame, a _layout or _fixtures file -> every TSX frame below it),
 *    which also covers a wrapper just created, before Vite has a module for it;
 *  - by graph: the edit's modules walked up their importers to frame modules, exact for every loaded
 *    document, the wrapper mapping applied wherever the walk reaches a wrapper.
 * A walk that passes a module accepting its own updates (an app component under src/**, a stylesheet)
 * has been applied in place: the frames past it are touched (marked) but not reloaded.
 *
 * Every other `full-reload` Vite or Tailwind sends is dropped and becomes reloads of the frames it
 * names (or every frame, when it names none) - the shell never reloads for a design edit. The one
 * that passes is the dependency optimiser's: module URLs changed, every document must reload.
 */
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { EnvironmentModuleNode, HotPayload, Plugin, ViteDevServer } from 'vite'
import { affectedFrameIds, type FrameEntry, type Manifest } from './manifest.ts'

const safeReal = (p: string) => { try { return realpathSync(p) } catch { return p } }

/** `unattributed`: a page-wide reload that named no file - its frames reload, but nothing is marked
 *  changed on its word (the marks' own look at the disk decides what is new). */
export interface Touched { file: string; doc: string[]; touched: string[]; unattributed?: boolean }

/** The frames an edit reaches: `doc` must reload to show it; `touched` saw it applied in place. */
export function framesFor(root: string, manifest: Manifest, file: string, modules: Iterable<EnvironmentModuleNode>, skipFirst = false): Touched {
  const real = safeReal(root)   // module files are real paths; a root reached through a symlink is not
  const byFile = new Map(manifest.frames.flatMap((f) => [[join(root, f.file), f], [join(real, f.file), f]] as const))
  const doc = new Set<string>(), touched = new Set<string>()
  const wrapper = (f: string) => /(^|[/\\])(providers\.(tsx|jsx)|_layout\.(tsx|jsx)|_fixtures\.(ts|tsx|js|jsx|json))$/.test(f)
  const add = (ids: string[], inPlace: boolean) => { for (const id of ids) (inPlace ? touched : doc).add(id) }
  // by path
  add(affectedFrameIds(file, root, manifest) ?? [], false)
  // by graph - breadth first, each module once per mode (a doc path beats an in-place one)
  const seen = new Map<EnvironmentModuleNode, boolean>()
  const queue: [EnvironmentModuleNode, boolean][] = []
  for (const m of modules) {
    if (skipFirst) { for (const up of m.importers) queue.push([up, false]); continue }   // m refused: on from its importers
    queue.push([m, false])
  }
  while (queue.length) {
    const [m, inPlace] = queue.shift()!
    const had = seen.get(m)
    if (had === false || had === inPlace) continue
    seen.set(m, inPlace)
    const f = m.file ? byFile.get(m.file) : undefined
    if (f) (inPlace ? touched : doc).add(f.id)   // and on: a frame other frames import reaches them too
    if (m.file && wrapper(m.file)) add(affectedFrameIds(m.file, root, manifest) ?? [], inPlace)
    const accepts = m.isSelfAccepting === true
    for (const up of m.importers) queue.push([up, inPlace || accepts])
  }
  for (const id of doc) touched.delete(id)
  return { file, doc: [...doc], touched: [...touched] }
}

export interface UpdateHooks {
  /** an edit reached these frames (from a hot update, a refused refresh, or a dropped reload) */
  onFrames(t: Touched, cause: 'update' | 'invalidate' | 'reload'): void
  /** every full-reload Vite tried to send, and whether it went out */
  onReload(payload: { triggeredBy?: string; path?: string }, passed: boolean): void
}

/** The hook that runs last on every hot update of the client environment. */
export function updatesPlugin(root: string, manifest: () => Manifest, hooks: () => UpdateHooks | null, landed: (file: string) => void): Plugin {
  return {
    name: 'marver:updates',
    hotUpdate: {
      order: 'post',
      handler(opts) {
        landed(opts.file)   // this environment is done with the file; the last one releases it
        if (this.environment.name !== 'client') return
        const h = hooks()
        if (!h) return
        const t = framesFor(root, manifest(), opts.file, opts.modules)
        if (t.doc.length || t.touched.length) h.onFrames(t, 'update')
      },
    },
  }
}

/** Wraps the client's hot channel: the reload guard and refused refreshes. */
export function guardUpdates(server: ViteDevServer, root: string, manifest: () => Manifest, hooks: UpdateHooks): void {
  const env = server.environments.client
  const optimised = () => (env as { depsOptimizer?: { metadata?: { browserHash?: string } } }).depsOptimizer?.metadata?.browserHash
  let hash = optimised()
  const wrap = (ch: { send: (...a: any[]) => void }) => {
    const send = ch.send.bind(ch)
    ch.send = (...a: any[]) => {
      const p = a[0] as HotPayload | string
      if (typeof p === 'object' && p?.type === 'full-reload') {
        const now = optimised()
        const passed = now !== undefined && now !== hash   // the optimiser committed new module URLs
        hash = now
        hooks.onReload({ triggeredBy: p.triggeredBy, path: p.path }, passed)
        if (!passed) {
          // the file behind it: the one it names, else the page it reloads (an HTML frame no page has
          // loaded yet has no module - Vite then names only its path)
          const by = p.triggeredBy ?? (p.path && p.path !== '*' ? join(root, p.path.replace(/^\//, '')) : undefined)
          const mods = by ? env.moduleGraph.getModulesByFile(by) : undefined
          const all = manifest().frames.map((f: FrameEntry) => f.id)
          const t: Touched = by ? framesFor(root, manifest(), by, mods ?? []) : { file: '', doc: all, touched: [], unattributed: true }
          if (t.doc.length || t.touched.length) hooks.onFrames(t, 'reload')   // a file no frame reads reloads nothing
          return
        }
      }
      send(...a)
    }
  }
  wrap(env.hot)
  if ((server.ws as unknown) !== (env.hot as unknown)) wrap(server.ws)
  // a component that refuses Fast Refresh while its update is applied (it also exports a value that
  // changed): Vite propagates further from the page without running the hook again - resume the walk
  const refused = new Map<string, number>()   // module -> the update it refused: every document that imports it says so once
  env.hot.on('vite:invalidate', (payload: { path?: string }) => {
    const mod = payload?.path ? env.moduleGraph.urlToModuleMap.get(payload.path) : undefined
    if (!mod?.file) return
    if (refused.get(mod.url) === mod.lastHMRTimestamp) return
    refused.set(mod.url, mod.lastHMRTimestamp)
    const t = framesFor(root, manifest(), mod.file, [mod], true)
    if (t.doc.length || t.touched.length) hooks.onFrames(t, 'invalidate')
  })
}
