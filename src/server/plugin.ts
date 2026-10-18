import { createHash } from 'node:crypto'
import type { Plugin, ViteDevServer } from 'vite'
import { boardsChanged } from './work.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { hash } from './manifest.ts'
import { NAME, PKG, ROUTE } from '../cli/name.ts'
import { loadConfig, type ShConfig } from './config.ts'
import { scanFrames, writeManifest, affectedFrameIds, isNoteFile, noteFileFor, type Manifest } from './manifest.ts'
import { checkBoardsDir, isRegularFile, listBoardFiles, nodeExists, parseBoard, readMembership } from './boards.ts'
import { ALL_SCENES } from '../shared/board-tree.ts'
import { contentOnly } from '../shared/frames.ts'
import { docRev, docRevs, initMarks, observe, recordChanged } from './marks.ts'
import { guardUpdates, updatesPlugin, type Touched, type UpdateHooks } from './updates.ts'
import { logReload } from './perf.ts'
import { apiMiddleware } from './api.ts'
import { SIZES_FILE } from './sizes.ts'
import { routesMiddleware } from './routes.ts'
import { checkUpdate, installedVersion } from './update.ts'

const VIRTUAL_THEME = 'virtual:sh-theme'
const VIRTUAL_CONFIG = 'virtual:sh-config'
const VIRTUAL_DATA = 'virtual:sh-data'

export interface PluginCtx {
  root: string
  clientDir: string
  config: ShConfig
  detectedThemeCss: string | null
}

export function marverPlugin(ctx: PluginCtx): Plugin[] {
  const { root, clientDir, config } = ctx

  // the project's line in the manifest; re-read from design/config.ts when that file changes
  // (the rest of the config still needs a restart - only the two orientation fields are live)
  let project = { name: config.share.name || basename(root), description: config.description }
  const projectInfo = () => project
  let manifest: Manifest = scanFrames(root, projectInfo())
  let devServer: ViteDevServer | null = null
  const bootId = String(process.hrtime.bigint())   // opaque, boot-scoped: a restart never mints a "lower" rev
  let invRev = 0
  const pendingInv = new Set<string>()
  const flushInv = debounce(() => {
    if (!devServer || !pendingInv.size) return
    const frameIds = [...pendingInv]; pendingInv.clear()
    // with each frame's doc revision: a node waits until a document of it shows that one
    const docs = docRevs(root, manifest.frames)
    devServer.ws.send('sh:frame-invalidated', { frameIds, revision: `${bootId}:${++invRev}`, epoch: docs?.epoch, docs: docs ? Object.fromEntries(frameIds.map((id) => [id, docs.doc[id] ?? 0])) : undefined })
  }, 120)

  // Calm updates (spec 26): an edit reached these frames. The marks look first (the static index
  // and fingerprints record every frame that reads the file, loaded or not), then the frames Vite's
  // graph found that the index missed; the frames that must reload get a queued, lease-aware reload.
  // The publication barrier (spec 26: stamps may lag the code, never lead it). A change is in flight from
  // the moment Vite's watcher hands it to the plugins (watchChange) until Vite has run our last
  // hot-update hook in every environment - then one more tick, past the invalidation Vite does after
  // its hooks (a create or delete is invalidated only there). Nothing records a revision while a change
  // is in flight: a document served then could be stamped with code it does not run yet. Each event
  // counts on its own; one Vite never brings to the hooks is invalidated by us before it lands.
  const inFlight = new Map<string, { events: number; hits: number; timer: ReturnType<typeof setTimeout> }>()
  const late = new Map<string, number>()   // hooks still owed by events that timed out: never credited to a newer one
  const envs = () => Object.keys(devServer?.environments ?? { client: 1 }).length
  const waiting: (() => void)[] = []
  const settled = () => inFlight.size === 0
  const whenSettled = (fn: () => void) => { if (settled()) fn(); else waiting.push(fn) }
  // one callback failing (a marks write the disk refused) never strands the others, nor stops dev
  const drain = () => { if (settled()) for (const fn of waiting.splice(0)) try { fn() } catch (e) { console.warn(`[marver] ${(e as Error).message}`) } }
  const done = (file: string) => {
    const f = inFlight.get(file)
    if (!f) return
    if (--f.events > 0) return
    clearTimeout(f.timer)
    inFlight.delete(file)
    drain()
  }
  const flying = (file: string) => {
    const f = inFlight.get(file) ?? { events: 0, hits: 0, timer: undefined as unknown as ReturnType<typeof setTimeout> }
    f.events++
    clearTimeout(f.timer)
    f.timer = setTimeout(() => {
      // Vite never finished it (a hook stalled): no module may serve old code - its own, a glob that
      // lists it, anything - so every module is invalidated before it lets go. Rare, and only slower.
      for (const env of Object.values(devServer?.environments ?? {})) env.moduleGraph.invalidateAll()
      late.set(file, (late.get(file) ?? 0) + f.events * envs() - f.hits)
      inFlight.delete(file); drain()
    }, 10_000)
    inFlight.set(file, f)
  }
  const landed = (file: string) => {
    const owed = late.get(file)
    if (owed) { if (owed > 1) late.set(file, owed - 1); else late.delete(file); return }   // a timed-out event's hook
    const f = inFlight.get(file)
    if (!f) return
    if (++f.hits < envs()) return   // other environments still to run
    f.hits = 0
    setTimeout(() => done(file), 0)
  }
  const observeMarks = () => observed(observe(root, manifest.frames))
  const observeLater = () => whenSettled(() => { if (observeMarks()) devServer?.ws.send('sh:marks', {}) })
  const hooks: UpdateHooks = {
    // a tick later: Vite finishes this update after the hooks (it invalidates the modules it walks), so
    // a revision is published - and a document stamped with it - only once its code is there to serve
    onFrames: (t: Touched, cause) => { setTimeout(() => whenSettled(() => record(t, cause)), 0) },
    onReload(p, passed) {
      logReload(root, { kind: 'full-reload', passed, triggeredBy: p.triggeredBy ?? null, path: p.path ?? null })
    },
  }
  function record(t: Touched, cause: string) {
    const seen = observe(root, manifest.frames, t.file ? { file: t.file } : {})   // this edit's frames only
    // an unattributed reload reloads what is loaded, and leaves the marks to the look at the disk above
    const doc = t.unattributed ? [] : t.doc.filter((id) => !seen.doc.includes(id))
    const touched = t.touched.filter((id) => !seen.doc.includes(id) && !seen.note.includes(id) && !doc.includes(id))
    if (doc.length) recordChanged(root, manifest.frames, doc, { doc: true })
    if (touched.length) recordChanged(root, manifest.frames, touched, { doc: false })
    const reload = [...new Set([...seen.doc, ...t.doc])]
    for (const id of reload) pendingInv.add(id)
    flushInv()
    if (reload.length || touched.length || seen.note.length) devServer?.ws.send('sh:marks', {})
    logReload(root, { kind: 'update', cause, file: t.file ? relative(root, t.file).split(sep).join('/') : null, reload, inPlace: t.touched })
  }

  /** No theme is only a problem for app frames: a canvas made of content frames alone (Doc, Md,
   *  Diagram ship their own styling) needs none (#4). The shell decides its banner from the live
   *  manifest; the config carries only whether a theme exists. */
  const themeMissing = () => themeFile() == null && !contentOnly(manifest.frames)

  /** Theme resolution: design/theme.css wrapper > configured > detected > empty (spec §5.4). */
  const themeFile = (): string | null => {
    const wrapper = join(root, 'design', 'theme.css')
    if (existsSync(wrapper)) return wrapper
    if (config.theme && existsSync(join(root, config.theme))) return join(root, config.theme)
    if (ctx.detectedThemeCss && existsSync(join(root, ctx.detectedThemeCss))) return join(root, ctx.detectedThemeCss)
    return null
  }

  const main: Plugin = {
    name: 'marver',
    watchChange(id) { if (devServer) flying(id) },
    // A7: run our handleHotUpdate BEFORE @vitejs/plugin-react's. A marver frame exports `meta`
    // (a non-component) alongside its component, so React Fast Refresh refuses to hot-update it
    // and broadcasts a GLOBAL full-reload (the shell "white zap") as a side effect. By emptying
    // ctx.modules first for a controlled frame, react's hook then sees nothing to refresh and
    // never fires that reload - the shell drives a lease-aware rev-stamped iframe reload instead.
    enforce: 'pre',

    resolveId(id) {
      if (id === VIRTUAL_THEME) {
        const f = themeFile()
        return f ?? '\0' + VIRTUAL_THEME + '.css'
      }
      if (id === VIRTUAL_CONFIG) return '\0' + VIRTUAL_CONFIG
      if (id === VIRTUAL_DATA) return '\0' + VIRTUAL_DATA
    },

    load(id) {
      if (id === '\0' + VIRTUAL_THEME + '.css') {
        if (themeMissing()) console.warn('[marver] no theme detected - frames render unstyled. Create design/theme.css importing your app\'s stylesheet (or set `theme` in design/config.ts).')
        return '/* marver: no theme configured */'
      }
      if (id === '\0' + VIRTUAL_CONFIG) {
        // setup: design/instructions/setup.md is the "no app yet" presence file (init
        // owns it) - the shell shows a banner while it exists, so the state is visible
        // in the thing the human is actually looking at
        // ownership check, not bare existence: a foreign setup.md must not lock the
        // canvas into the no-app banner
        const setupPending = (() => {
          try {
            const s = readFileSync(join(root, 'design', 'instructions', 'setup.md'), 'utf8')
            return s.startsWith('# Setup required') && s.includes('marver init')
          } catch { return false }
        })()
        // wordmark: a declared share.name wins over the repo dir - deploy hosts build
        // from anonymous paths (/app), and the gate already wears the declared name
        return `export default ${JSON.stringify({ viewports: config.viewports, themes: config.themes, zoomSpeed: config.zoomSpeed, noTheme: themeFile() == null, setup: setupPending, projectName: config.share.name || basename(root), branding: config.share.branding, jam: config.jam ? { chime: config.jam.chime, capture: config.jam.capture } : null, workspace: createHash('sha256').update(root).digest('hex').slice(0, 16) })}`
      }
      // null in dev - the shell fetches live. Builds provide the real module (build.ts).
      if (id === '\0' + VIRTUAL_DATA) return 'export default null'
    },

    /** HTML frames: inject theme + bridge into any design/**.html Vite serves.
     *  Inline scripts go through vite's html-proxy import-analysis: bare specifiers resolve
     *  through plugins (so `virtual:sh-theme` works); `/@id/` URLs are rejected there. */
    transformIndexHtml: {
      order: 'pre',
      handler(html, hctx) {
        const path = (hctx.originalUrl ?? hctx.path ?? '').split('?')[0]
        if (!path.startsWith('/design/')) return
        const bridge = '/@fs/' + join(clientDir, 'frame-host', 'bridge.js').split('\\').join('/') + '?html=1'
        // the revision this document is served with (spec 26), echoed in its sh:ready
        const frame = manifest.frames.find((f) => '/' + f.file === path)
        const stamp = frame ? docRev(root, manifest.frames, frame.id) : ''
        // head-prepend: module scripts run in DOM order, so the bridge's error listener
        // and theme init beat any authored script in the frame.
        return {
          html,
          tags: [
            { tag: 'script', attrs: { type: 'module' }, children: `import '${VIRTUAL_THEME}'`, injectTo: 'head-prepend' },
            { tag: 'script', attrs: { type: 'module', src: bridge }, injectTo: 'head-prepend' },
            ...(stamp ? [{ tag: 'meta', attrs: { name: 'mv-doc', content: stamp }, injectTo: 'head-prepend' as const }] : []),
          ],
        }
      },
    },

    configureServer(server: ViteDevServer) {
      let bakeGen = Date.now()   // the source generation (see bumpGen): unique per server start
      // THE #20 FIX. registry.ts lives in node_modules, so Vite stamps its import URL
      // with ?v=<hash> and serves it `max-age=31536000,immutable` - correct for static
      // package code, poison for this one module: its TRANSFORM is dynamic (the glob
      // map tracks the host's design/ tree). A restart re-globs server-side while every
      // open tab trusts its year-long cache, and each canvas bricks with "unknown frame
      // id" - unfixable by hard reload (iframe subresources never revalidate immutable
      // entries). Forcing no-cache keeps the ETag dance honest: 304 while unchanged,
      // fresh 200 the moment the map differs.
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.includes('/frame-host/registry.ts')) {
          const orig = res.setHeader.bind(res)
          res.setHeader = ((name: string, value: unknown) =>
            orig(name, String(name).toLowerCase() === 'cache-control' ? 'no-cache' : value as any)) as any
        }
        next()
      })

      // Update discovery (dev only): one cached registry check per day (update.ts has
      // the privacy story). Two surfaces from the same result - a stdout line for the
      // terminal, and /__mv/api/update for the shell's pill. Must be registered BEFORE
      // apiMiddleware, whose unknown-endpoint 404 would eat the path.
      const update = checkUpdate(root).catch(() => null)
      update.then((latest) => {
        if (latest) console.log(`\n  update: ${PKG} ${latest} is out (installed ${installedVersion() ?? '?'}) → npm i -D ${PKG}@latest && npx ${NAME} init\n`)
      })
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        if (url.pathname !== `${ROUTE}/api/update`) return next()
        update.then((latest) => {
          res.setHeader('content-type', 'application/json')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({ latest, current: installedVersion() }))
        })
      })

      // The dev server may bind IPv6 (localhost -> ::1); a hardcoded 127.0.0.1 would be refused.
      // Build the origin from the ACTUAL bound address, bracketing IPv6 and mapping wildcards to
      // loopback. Shared by /api/shot (so a spoofed Host can't redirect the render) and the
      // file-drop shot inbox below.
      const listeningOrigin = (): string | null => {
        const a = server.httpServer?.address()
        if (!a || typeof a === 'string') return null
        const host = a.family === 'IPv6'
          ? (a.address === '::' ? '[::1]' : `[${a.address}]`)
          : (a.address === '0.0.0.0' ? '127.0.0.1' : a.address)
        return `http://${host}:${a.port}`
      }

      // Pre-middlewares: our routes + api run before Vite's html fallback.
      // the marks start with the dev server, before any page asks (spec 26)
      initMarks(root, manifest.frames)
      server.middlewares.use(apiMiddleware(root, { viewports: config.viewports, origin: listeningOrigin, bakeGen: () => bakeGen, notify: (event) => server.ws.send(event, {} as any), manifest: () => manifest, settled }))
      server.middlewares.use(routesMiddleware(server, clientDir, {
        doc: (id) => docRev(root, manifest.frames, id),
        docs: () => docRevs(root, manifest.frames),
      }))

      devServer = server   // the update hooks send sh:frame-invalidated through it
      guardUpdates(server, root, () => manifest, hooks)
      // Boot manifest + watcher (scenes/components only; boards, .local, manifest.json excluded by scope).
      // Broadcast only when the FRAMES changed - plain content edits ride HMR alone (spec
      // §5.6), and a board/folder/description edit (the manifest carries those now) must
      // never re-key the live iframes. The file itself is rewritten on any change.
      let framesKey = JSON.stringify(manifest.frames)
      let scenesKey = JSON.stringify(manifest.scenes)
      // spec 26: the frames on no board are said in the log - at boot, and whenever the list changes
      let unplacedKey = ''
      const sayUnplaced = () => {
        const { unplaced } = readMembership(root, manifest.frames.map((f) => f.id))
        const key = unplaced.join(',')
        if (key && key !== unplacedKey) console.log(`[${NAME}] not on a board (${unplaced.length}): ${unplaced.join(', ')} - every frame goes on the board it belongs to: npx ${NAME} boards pin <board> <scene/frame ...>`)
        unplacedKey = key
      }
      sayUnplaced()
      const regen = debounce(() => {
        manifest = scanFrames(root, projectInfo())   // keep the cached manifest fresh for affectedFrameIds
        sayUnplaced()
        const changed = writeManifest(root, manifest)
        observeLater()   // a frame added (a new id, a rename) or gone
        const key = JSON.stringify(manifest.frames), sKey = JSON.stringify(manifest.scenes)
        if (changed && key !== framesKey) server.ws.send('sh:manifest', manifest as any)
        // a scene's title or description changed (its brief) with the frames intact: the shell
        // relabels its rows off `sh:scenes` - no manifest apply, no iframe re-keyed
        else if (changed && sKey !== scenesKey) server.ws.send('sh:scenes', { scenes: manifest.scenes } as any)
        framesKey = key; scenesKey = sKey
      }, 150)

      const watched = [join(root, 'design', 'scenes'), join(root, 'design', 'components')]
      const inScope = (file: string) => watched.some((w) => file.startsWith(w))

      // Tailwind's scan set is computed when the theme CSS compiles; a NEW frame file's
      // classes silently miss until that CSS rebuilds (friction log #22 - the canvas
      // renders a confident wrong design). Two phases per add/unlink:
      //   1. invalidate the theme module chain SYNCHRONOUSLY - an iframe mounting off
      //      the manifest event can then never fetch the pre-change compiled CSS;
      //   2. reloadModule (debounced) pushes the recompiled CSS to already-open frames.
      const themeModules = (): any[] => {
        const f = themeFile()
        if (!f) return []
        const out: any[] = []
        const seen = new Set<any>()
        const walk = (mod: any) => {
          if (!mod || seen.has(mod)) return
          seen.add(mod)
          out.push(mod)
          for (const im of mod.clientImportedModules ?? mod.importedModules ?? [])
            if (String(im.id ?? '').split('?')[0].endsWith('.css')) walk(im)
        }
        for (const mod of server.moduleGraph.getModulesByFile(f) ?? []) walk(mod)
        return out
      }
      const pushTheme = debounce(() => {
        for (const mod of themeModules()) server.reloadModule(mod).catch(() => { /* gone mid-reload */ })
      }, 150)
      const rescanTheme = () => {
        for (const mod of themeModules()) server.moduleGraph.invalidateModule(mod)
        pushTheme()
      }

      // The source GENERATION: bumped on any watched change under the project (frames, screens, css,
      // components - anything a frame may import), so a compiled bake (design/.local/bakes/<gen>/) can
      // never outlive an edit; older generations are pruned as they are superseded.
      const localDir = join(root, 'design', '.local'), boardsDirGen = join(root, 'design', 'boards'), manifestPath = join(root, 'design', 'manifest.json')
      const bumpGen = (f: string) => {
        if (f.startsWith(localDir) || f.startsWith(boardsDirGen) || f === manifestPath || f.includes('/node_modules/')) return
        bakeGen++
        prune()
      }
      // pruned against the generation current when the timer fires: an older timer must never delete a newer one
      const prune = () => setTimeout(async () => { try { (await import('./bake.ts')).pruneBakes(root, bakeGen) } catch { /* best-effort */ } }, 500)
      prune()   // a previous server's generation is dead on arrival
      server.watcher.on('add', bumpGen); server.watcher.on('unlink', bumpGen); server.watcher.on('change', bumpGen)
      server.watcher.on('add', (f) => { if (inScope(f)) { regen(); rescanTheme() } })
      server.watcher.on('unlink', (f) => { if (inScope(f)) { regen(); rescanTheme() } })
      // spec 20: statuses are read from context/ (the shipped record, contracts, plans) and from
      // the briefs' `phase`. A change there re-reads the sidebar (`sh:boards`) and the manifest -
      // coalesced per burst, like the boards watcher. context/'s JSON never reaches here (Vite's
      // watch ignores it: an out-of-graph .json change full-reloads every client).
      const contextDir = join(root, 'context') + sep
      let statusTimer: ReturnType<typeof setTimeout> | undefined
      const restatus = (f: string) => {
        if (!f.startsWith(contextDir) && !(inScope(f) && f.endsWith('_brief.md'))) return
        clearTimeout(statusTimer)
        statusTimer = setTimeout(() => { server.ws.send('sh:boards', {}); regen() }, 150)
      }
      server.watcher.on('add', restatus); server.watcher.on('unlink', restatus); server.watcher.on('change', restatus)
      // change: only meta edits matter; scanFrames re-extracts and writeManifest de-dupes writes.
      // a brief's first line is its scene's description; a note file IS its sticky (spec 18)
      server.watcher.on('change', (f) => inScope(f) && (/\.(tsx|jsx)$/.test(f) || f.endsWith('_brief.md') || isNoteFile(f)) && regen())
      // sidebar marks (spec 26): anything a frame reads changed on disk - an edit no hot update
      // carried (a sticky note, a file no page has loaded), an agent, a git pull. The fingerprints
      // say which frames; a hot update has already recorded its own, so nothing counts twice.
      const marksChanged = debounce(observeLater, 300)
      for (const ev of ['add', 'change', 'unlink'] as const) server.watcher.on(ev, (f) => { if (!f.startsWith(localDir) && !f.startsWith(boardsDirGen)) marksChanged() })
      const configFile = join(root, 'design', 'config.ts')
      server.watcher.on('change', (f) => {
        if (f !== configFile) return
        loadConfig(root).then((c) => { project = { name: c.share.name || basename(root), description: c.description }; regen() }).catch(() => { /* unreadable mid-edit; the next save tries again */ })
      })

      writeManifest(root, manifest)

      // Multi-viewer board sync: Vite's watcher deliberately ignores boards/ (write-loop
      // guard, spec §5.6), so a plain fs.watch broadcasts saves instead. Every viewer
      // whose board is CLEAN re-boots on a foreign sha; the dirty one keeps its edits and
      // converges through the 409 path on its next save. Self-echo is filtered client-side
      // (own save already advanced boardHash to the broadcast sha).
      const boardsDir = join(root, 'design', 'boards')
      try {
        mkdirSync(boardsDir, { recursive: true })   // watch needs it to exist; the API creates it lazily
        const timers = new Map<string, ReturnType<typeof setTimeout>>()
        // a board that is not JSON is said once per content (#6) - at boot, and whenever it changes
        const badBoards = new Map<string, string>()   // file → hash of the invalid content last reported
        const reportBad = (file: string, content: string, error: string) => {
          if (badBoards.get(file) === hash(content)) return
          badBoards.set(file, hash(content))
          console.warn(`[marver] design/boards/${file} is not valid JSON - ${error}`)
        }
        // never through a symlinked design/boards: what lies elsewhere is never read into the log
        if (!checkBoardsDir(root, boardsDir)) for (const b of listBoardFiles(boardsDir).boards) if (b.error) reportBad(`${b.name}.json`, b.content, b.error)
        // the built-in All Scenes board is gone (spec 26): a leftover file is set aside, said once
        if (nodeExists(join(boardsDir, `${ALL_SCENES}.json`))) console.log(`[${NAME}] design/boards/${ALL_SCENES}.json is left over from the All Scenes board, gone since 0.25 - nothing reads it any more; delete it when you like (its threads stay in design/comments/)`)
        // the LIST changed (a board or the folder registry added, written, or deleted): one
        // coalesced `sh:boards` per burst, so the sidebar re-reads its tree - deletions too,
        // which the content broadcast below cannot carry (nothing left to hash)
        let listTimer: ReturnType<typeof setTimeout> | undefined
        const watcher = watch(boardsDir, (_event, file) => {
          // the size cache (sizes.ts) is no board and no folder: the shell that wrote it already
          // holds every height in it - a sidebar re-read per settled Doc would be pure churn
          if (!file || !file.endsWith('.json') || file === SIZES_FILE || file === `${ALL_SCENES}.json`) return
          clearTimeout(listTimer)
          listTimer = setTimeout(() => { server.ws.send('sh:boards', {}); regen(); boardsChanged(root) }, 150)   // the manifest carries boards and folders too; boardsChanged re-lights the sidebar's live boards
          clearTimeout(timers.get(file))
          timers.set(file, setTimeout(() => {
            timers.delete(file)
            let content: string
            if (!isRegularFile(join(boardsDir, file))) return   // deleted, a directory, a symlink: never followed, never printed
            try { content = readFileSync(join(boardsDir, file), 'utf8') } catch { return }
            // a mid-write partial must not broadcast - viewers would reload onto garbage; a settled
            // invalid file says why, so the human and the agent both see it
            const { error } = parseBoard(content)
            if (error) { if (!checkBoardsDir(root, boardsDir)) reportBad(file, content, error); return }   // checked per read: the folder can change under us
            badBoards.delete(file)
            server.ws.send('sh:board', { name: file.replace(/\.json$/, ''), sha256: hash(content) })
          }, 120))
        })
        server.httpServer?.once('close', () => watcher.close())
      } catch { /* watch unsupported here - sync degrades to the 409 path */ }

      // The shot inbox: the file-drop transport for the Live Jam verify loop. A no-shell
      // agent (Claude Code) cannot run `marver shot` and its WebFetch refuses localhost, so
      // "look at my frame" has to be Write-then-Read. The agent drops a `<name>.request.json`
      // ({frame, theme}) here; we render and write `<name>.result.json` ({ok, path|error})
      // next to it, then remove the request. Every jam CLI can Write, so this works for all
      // seven. The dir is under design/.local, outside Vite's HMR watch, so requests never
      // reload the canvas.
      try {
        const inbox = join(root, 'design', '.local', 'shots')
        mkdirSync(inbox, { recursive: true })
        const origin = listeningOrigin   // the shared helper hoisted above
        const inFlight = new Set<string>()
        const processRequest = (file: string) => {
          if (!file.endsWith('.request.json') || inFlight.has(file)) return
          const reqPath = join(inbox, file)
          if (!existsSync(reqPath)) return
          inFlight.add(file)
          setTimeout(async () => {   // let the write settle before reading
            const base = file.replace(/\.request\.json$/, '')
            const resultPath = join(inbox, `${base}.result.json`)
            // CLAIM the request by an atomic rename before reading it: whatever the agent writes
            // to the canonical name from now on is a new request, picked up by the next tick, and
            // can never be deleted with this one's result. (An overwrite in the 60ms above simply
            // becomes the claimed content.)
            const claimed = join(inbox, `.${base}.${process.pid}.${Date.now().toString(36)}.claimed`)
            try { renameSync(reqPath, claimed) } catch { inFlight.delete(file); return }   // gone, or someone else's
            try {
              // atomic: an agent polling the result never reads it half-written
              const write = (r: unknown) => {
                const tmp = join(inbox, `.${base}.${process.pid}.tmp`)
                try { writeFileSync(tmp, JSON.stringify(r, null, 2)); renameSync(tmp, resultPath) } catch { try { rmSync(tmp, { force: true }) } catch { /* ignore */ } }
              }
              let spec: Record<string, unknown>
              try {
                spec = JSON.parse(readFileSync(claimed, 'utf8'))
                if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('expected an object')
              } catch (err) { write({ ok: false, error: `malformed request - ${(err as Error).message}` }); return }
              // one validator, the same rules as the API: theme, scale, and ONE way of naming frames
              const theme = spec.theme === undefined ? 'light' : spec.theme
              if (typeof theme !== 'string' || !/^[a-z0-9-]+$/i.test(theme)) { write({ ok: false, error: 'invalid theme' }); return }
              const scale = spec.scale === undefined ? undefined : spec.scale
              if (scale !== undefined && !(Number.isInteger(scale) && (scale as number) >= 1 && (scale as number) <= 4)) { write({ ok: false, error: 'invalid scale' }); return }
              const ways = ['frame', 'frames', 'scene', 'all'].filter((k) => spec[k] !== undefined)
              if (ways.length !== 1) { write({ ok: false, error: 'name the frames one way: frame (an id), frames (an array of ids), scene (a name) or all (true)' }); return }
              const o = origin()
              if (!o) { write({ ok: false, error: 'dev server has no address yet - retry' }); return }
              const { shootFrame, shootBatch, resolveFrames } = await import('./shot.ts')
              if (ways[0] === 'frame') {
                if (typeof spec.frame !== 'string') { write({ ok: false, error: 'frame must be a frame id' }); return }
                write(await shootFrame({ root, viewports: config.viewports, frameId: spec.frame, theme, origin: o, scale: scale as number | undefined }))
                return
              }
              // a batch: {frames:[...]} | {scene:"name"} | {all:true} - one browser, several at a time
              const sel = resolveFrames(root, spec)
              if (!sel.ok) { write({ ok: false, error: sel.error }); return }
              try {
                const results = await shootBatch({ root, viewports: config.viewports, frames: sel.frames, theme, origin: o, scale: scale as number | undefined })
                write({ ok: true, results })
              } catch (err) { write({ ok: false, error: (err as Error).message }) }
            } finally {
              try { rmSync(claimed, { force: true }) } catch { /* ignore */ }
              inFlight.delete(file)
            }
          }, 60)
        }
        // fs.watch is the fast path; a slow sweep is the backstop, because fs.watch misses
        // events on some filesystems (macOS temp/FSEvents, network mounts) - the same reason
        // the comments daemon pairs its watcher with a rescan. Without it, an agent's request
        // file could sit unprocessed forever on exactly the machines where watching is flaky.
        const inboxWatcher = watch(inbox, { persistent: false }, (_e, file) => { if (file) processRequest(file) })
        const sweep = setInterval(() => {
          try { for (const f of readdirSync(inbox)) processRequest(f) } catch { /* dir vanished */ }
        }, 1000)
        sweep.unref?.()
        server.httpServer?.once('close', () => { inboxWatcher.close(); clearInterval(sweep) })
      } catch { /* no inbox watcher - the HTTP/CLI transport still serves shell-ful agents */ }
    },
  }
  return [main, updatesPlugin(root, () => manifest, () => devServer && hooks, landed)]
}

/** The marks look at the frames on disk; true when they recorded something. */
function observed(r: { doc: string[]; note: string[] }) { return r.doc.length + r.note.length > 0 }

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout>
  return ((...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }) as T
}

/** Extra vite plugin when the host runs Tailwind v4. The host's own @tailwindcss/vite
 *  wins (version-matched to their tailwindcss); the fallback is marver's bundled copy -
 *  Next.js hosts use @tailwindcss/postcss and never have the vite plugin (the blessed
 *  stack would otherwise render every frame without its utility classes). */
export async function tailwind4Plugin(root: string): Promise<Plugin[] | null> {
  const factories: (() => Promise<any>)[] = [
    () => import(join(root, 'node_modules', '@tailwindcss', 'vite', 'dist', 'index.mjs')),
    () => import('@tailwindcss/vite'),
  ]
  for (const load of factories) {
    try {
      const mod = await load()
      const factory = mod.default ?? mod
      const result = factory()
      return Array.isArray(result) ? result : [result]
    } catch { /* try the next source */ }
  }
  return null
}

/** Tailwind v3: inline PostCSS config extending the host's tailwind config with design/ globs. Host files untouched. */
export async function tailwind3Css(root: string): Promise<Record<string, unknown> | null> {
  for (const name of ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs']) {
    const file = join(root, name)
    if (!existsSync(file)) continue
    try {
      const { pathToFileURL } = await import('node:url')
      const twConfig = (await import(pathToFileURL(file).href)).default
      const tailwindcss = (await import(join(root, 'node_modules', 'tailwindcss', 'lib', 'index.js').replace(/\\/g, '/'))).default
      const content = Array.isArray(twConfig.content) ? twConfig.content : twConfig.content?.files ?? []
      return {
        postcss: {
          plugins: [tailwindcss({ ...twConfig, content: [...content, './design/**/*.{ts,tsx,html}'] })],
        },
      }
    } catch (err) {
      console.warn(`[marver] could not extend Tailwind v3 config (${(err as Error).message}). Add './design/**/*.{ts,tsx,html}' to its content globs manually.`)
      return null
    }
  }
  return null
}
