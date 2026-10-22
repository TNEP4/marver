import { createLogger, createServer, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, mkdirSync, realpathSync, watch as fsWatch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME, PKG } from '../cli/name.ts'
import { loadConfig } from './config.ts'
import { detectHost } from './detect.ts'
import { marverPlugin, tailwind3Css, tailwind4Plugin } from './plugin.ts'
import { iconModules, iconsPlugin } from './icons.ts'
import { locPlugin } from './loc.ts'
import { Startup } from './startup.ts'
import { legacyPort, marverHome, notePrefer, originOf, place, stopPrefer, type Recover, type RunAddress } from './slots.ts'
import { runIdentity } from './workspace.ts'
import { installedVersion } from './update.ts'

/** packageDir = the installed marver package root (dist/cli.js lives one level down). */
function packageDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/** realpath, or the path itself when it cannot be resolved (never throws at boot). */
const safeReal = (p: string): string => { try { return realpathSync(p) } catch { return p } }

/**
 * What the dev server must never hand out, however deep in the repo it sits.
 *
 * `marver dev` puts the whole repository on the web so frames can import from it.
 * The collaboration credential no longer lives in there - it moved to
 * ~/.marver/canvases/ precisely because guarding it here could not be finished -
 * but design/.local still holds the local profile and whatever a previous version
 * left behind, and none of that is anybody's business but the author's.
 *
 * Vite's own defaults are restated rather than assumed. `fs.deny` REPLACES the
 * default list, so an array containing only our own rule quietly re-exposes
 * `.env`, private keys, `.npmrc` and `.git` - a much larger hole than the one
 * being closed, opened by closing it. Kept as an exported constant so a test can
 * hold both halves.
 */
export const FS_DENY = [
  // Vite 8's defaults, verbatim.
  '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
  // Conventions Vite does not know about but that hold secrets all the same.
  '.dev.vars', '.dev.vars.*',
  // Ours. Narrow on purpose: a host app may legitimately import from some other
  // `.local` directory of its own, and nothing marver serves lives under this one.
  '**/design/.local/**',
]

/**
 * The half of the credential guard that globs cannot do.
 *
 * `fs.deny` matches the REQUEST path, lexically, and then Vite stats and streams
 * whatever that path resolves to. So a repository containing
 * `leak.json -> design/.local/anything` serves that file at `/leak.json` to any
 * authored frame that asks - the deny rule never sees the name it is looking for.
 * Verified against a real dev server before this existed.
 *
 * More patterns cannot fix that; only resolving can. This runs BEFORE Vite's own
 * middlewares (a `configureServer` hook that does not return a function is
 * installed first) and refuses any request whose real file lands inside
 * design/.local, whatever route it took to get there.
 *
 * "Whatever route" means every place Vite would look, not just the project root.
 * `public/` is mapped onto `/`, so `public/leak.json -> ../design/.local/x` is
 * served at `/leak.json` - and Vite skips its own deny checks entirely for public
 * files, so that spelling was reachable even with the root candidate guarded.
 * Each candidate is resolved; if any lands in design/.local, the request is
 * refused.
 *
 * The boundary this does NOT claim: a repository that can write symlinks can also
 * write `design/config.ts`, which `marver dev` imports and RUNS in this process
 * before any of the above exists. Running `dev` on a repository you do not trust
 * hands it your machine long before it hands it a file, so a symlink is not the
 * interesting way in. What this closes is the frame-in-a-trusted-repo case: a
 * component that runs in the browser, same-origin, that can only ask for URLs and
 * cannot create a file to ask for.
 *
 * The registry is guarded the same way (spec 28 A1.13 #5): ~/.marver/running/ holds each running
 * canvas's proof key and canvases/ the collaboration credentials, and a host whose workspace root is the
 * home folder - or a MARVER_HOME inside the repository - would otherwise put them in reach of `/@fs/`.
 * Both are guarded when MARVER_HOME moves this run's: the one it writes, and the one in the home folder.
 */
function denyLocalSecrets(root: string): any {
  const guardedAt = join(root, 'design', '.local')
  const homes = [...new Set([marverHome(), join(homedir(), '.marver')])]
  // Vite's default publicDir. dev.ts never overrides it, so this is the one extra
  // place a request path can come from.
  const publicAt = join(root, 'public')
  const inside = (real: string, dir: string) => {
    const rel = relative(dir, real)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  return {
    name: 'marver:deny-local-secrets',
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: () => void) => {
        let pathname: string
        try { pathname = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]) } catch { return next() }
        const rel = '.' + (pathname.startsWith('/') ? pathname : `/${pathname}`)
        // `/@fs/<abs>` is Vite's escape hatch for files outside the root; root and
        // public are the two places an ordinary path can land.
        // Vite derives more paths than it is asked for: `/leak` can resolve to
        // `leak.html`, `leak/index`, `leak/index.html`. Enumerating a bundler's
        // resolution rules is not a game anyone wins, which is why the credential
        // itself now lives outside the repository - this list is depth, not the
        // defence. It covers the derivations Vite actually applies.
        const derived = (base: string) => [base, `${base}.html`, join(base, 'index'), join(base, 'index.html')]
        const candidates = pathname.startsWith('/@fs/')
          ? derived(pathname.slice('/@fs'.length))
          : [...derived(resolvePath(root, rel)), ...derived(resolvePath(publicAt, rel))]
        // A missing design/.local (or registry) means there is nothing there to protect.
        const real = (d: string) => { try { return realpathSync(d) } catch { return null } }
        // A candidate that does not resolve is a 404 Vite will produce on its own.
        const leak = (dir: string | null) => dir !== null && candidates.some((c) => {
          try { return inside(realpathSync(c), dir) } catch { return false }
        })
        const local = leak(real(guardedAt))
        if (!local && !homes.some((h) => leak(real(h)))) return next()
        res.statusCode = 403
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(local ? 'design/.local holds this canvas\'s credentials and is never served' : 'the canvas registry (~/.marver) is never served')
      })
    },
  }
}

/** The canvas did not start: what failed, said - everything the start held is given back first. */
export class DevStartError extends Error {}
/** A canvas already runs in this folder (or one is starting): the line says where, or what to do. */
export class DevLockError extends DevStartError {}

/** The steps of a start, as `DevOptions.at` sees them. */
export type StartStep = 'locked' | 'claimed' | 'env' | 'configure' | 'created' | 'listening' | 'published'
export interface DevOptions {
  /** --port: a port of its own; inside the slot range it claims exactly that slot (spec 28 A1.3) */
  port?: number
  /** --recover: exactly this earlier address and workspace key - never another (A1.6) */
  recover?: Recover
  /** tests only (startup.test.ts): called at each step of the start - a throw fails it there, a promise
   *  that never settles pauses it. 'env' runs inside Vite's environment initialisation, 'configure'
   *  after Marver's configureServer */
  at?: (step: StartStep, info?: { port: number }) => unknown
}

/**
 * Start the canvas (spec 28 A1.1): 1. dev.lock, 2. an address - a slot, a port of its own, or
 * --recover's - held as a file, 3. Vite's server, 4. listening on exactly that port, 5. published: the
 * slot file as ready, dev.json, 6. the close. Every step's claims belong to one Startup, so a failure
 * anywhere closes what was made and gives back what was held, and `dev()` rejects with a DevStartError -
 * it never ends the process itself (the CLI does, A1.13 #4), so an embedding caller is left clean.
 */
export async function dev(root: string, opts: DevOptions = {}) {
  const t = new Startup()
  // every way out gives back what is held by then - a failed start, a close, an exit, Ctrl-C or a kill
  t.hookProcess()
  try {
    // 1. one canvas per folder (#19): the lock comes first, so a second `marver dev` never starts a server
    const { takeDevLock } = await import('./dev-lock.ts')
    const lock = await takeDevLock(root, { onTaken: (release) => t.claim(release) })
    if (!lock.ok) throw new DevLockError(lock.message)
    await opts.at?.('locked')
    return await boot(root, opts, lock.instance, t)
  } catch (err) {
    // newest first: the server if there is one, Marver's watchers, then the files
    await t.close()
    if (err instanceof DevStartError) throw err
    throw new DevStartError(`the canvas could not start: ${(err as Error)?.message ?? err}`, { cause: err })
  }
}

async function boot(root: string, opts: DevOptions, instance: string, t: Startup) {
  const config = await loadConfig(root)
  const host = detectHost(root)
  const pkgDir = packageDir()
  const clientDir = join(pkgDir, 'src', 'client')
  const projectName = basename(root)
  // A1.6: one run, two values - the project's canonical id (its preference file) and the workspace this
  // run serves under (a --recover run's is the entry's)
  const run = runIdentity(root, opts.recover?.ws)
  // 2. the address (A1.3) - a slot, a port of its own, or --recover's exact one - held as a file before
  // anything binds. A config.port other than the scaffold's 5199 is a port of its own, as --port is.
  const fromConfig = opts.port === undefined && !opts.recover && config.port !== 5199 ? config.port : undefined
  const explicitPort = opts.port ?? fromConfig
  const placed = await place({
    root: run.root, name: basename(run.root), version: installedVersion() ?? '0.0.0', id: run.id, ws: run.ws, instance,
    onHold: (release) => t.claim(release),
    ...(opts.recover ? { recover: { port: opts.recover.port } }
      : explicitPort !== undefined ? { explicit: { port: explicitPort, from: fromConfig !== undefined ? 'config' as const : 'flag' as const } } : {}),
  })
  if (!placed.ok) throw new DevStartError(placed.message)
  const { claim } = placed
  for (const n of placed.notes) console.log(`  ${n}`)
  await opts.at?.('claimed', { port: claim.port })

  // spec 26: Marver alone updates frame documents - no Fast Refresh under design/ (JSX still compiles),
  // so a design edit always reaches the frame host's registry, whose update Marver turns into a calm,
  // queued reload of exactly the frames it touched. An embedded app's own src/** keeps Fast Refresh.
  const esc = (p: string) => join(p, 'design').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const designDir = new RegExp(`^(${[...new Set([root, safeReal(root)])].map(esc).join('|')})[/\\\\]`)   // ids are real paths
  const plugins: any[] = [denyLocalSecrets(root), react({ exclude: [/\/node_modules\//, designDir] })]
  // spec 27 Part 6: every host element in a design file names its source (data-mv-loc) - dev only,
  // never the published build; `jam: { loc: false }` turns it off
  if (config.jam?.loc !== false) plugins.unshift(locPlugin(root))
  if (host.tailwind === 4) {
    const tw = await tailwind4Plugin(root)
    if (tw) plugins.push(...tw)
    else console.warn(`[marver] tailwindcss v4 detected but @tailwindcss/vite could not be loaded - utility classes WILL be missing from frames. Fix: npm i -D @tailwindcss/vite (used only by the canvas, never by your app's build).`)
  }
  let css: Record<string, unknown> | undefined
  if (host.tailwind === 3) css = (await tailwind3Css(root)) ?? undefined

  plugins.push(...marverPlugin({ root, clientDir, config, detectedThemeCss: host.themeCss, workspace: run.ws, startup: t, proof: { instance, key: claim.key, port: claim.port } }), iconsPlugin(root))
  if (opts.at) {
    // the test seam's probe: its `options` runs inside Vite's environment initialisation (once per
    // environment - said once), its configureServer after Marver's (which is `enforce: 'pre'`)
    let env = false
    plugins.push({ name: 'marver:startup-probe', async options() { if (!env) { env = true; await opts.at!('env') } }, async configureServer() { await opts.at!('configure') } })
  }

  // ~35 lines of "Sourcemap for react-zoom-pan-pinch points to missing sources" per boot
  // (their published map is broken, not actionable here) were burying the warnings that
  // matter. Filter exactly that noise; everything else passes through.
  const logger = createLogger('info')
  const noise = (msg: string) => /Sourcemap for .*node_modules.*points to/.test(msg)
  const warnBase = logger.warn.bind(logger)
  const warnOnceBase = logger.warnOnce.bind(logger)
  logger.warn = (msg, opts) => { if (!noise(msg)) warnBase(msg, opts) }
  logger.warnOnce = (msg, opts) => { if (!noise(msg)) warnOnceBase(msg, opts) }

  const server = await createServer({
    configFile: false,
    root,
    // Marver's own pre-bundle folder (#7). Vite's default, node_modules/.vite, is shared with every other Vite
    // on this root (the app's own, a Vitest run, `vite --force`): when one of them optimizes it replaces deps/
    // under the running canvas, and each pre-bundle not served yet - mermaid's lazily loaded diagram chunks, a
    // first Md's marked - answers 504 "Outdated Optimize Dep" until a restart. Not under design/.local/: the
    // file deny rule answers 403 there.
    cacheDir: join(root, 'node_modules', '.vite-marver'),
    css: css as any,
    customLogger: logger,
    plugins,
    server: {
      // exactly the claimed port: it was checked free while its file was held (A1.3), and a program that
      // takes it in between is named below - never a quiet move to the next port
      port: claim.port,
      strictPort: true,
      // --recover binds the address it recorded; otherwise Vite's default, as before
      ...(opts.recover?.host ? { host: opts.recover.host } : {}),
      // with an overlay up, Vite's client reloads the whole page on the next update; a frame's error
      // shows on its own card (sh:error) and its fix arrives as a queued reload like any other edit
      hmr: { overlay: false },
      // keep Vite's workspace-root allowance: monorepo hosts import sibling packages.
      // Vite checks the REAL path of each file, so a root reached through a symlink
      // (/tmp -> /private/tmp, a linked Dropbox folder) must be allowed by its realpath too.
      fs: {
        allow: [...new Set([root, safeReal(root), pkgDir, safeReal(pkgDir), searchForWorkspaceRoot(root)])],
        deny: FS_DENY,
      },
      // Spec §5.6: our own writes must never bounce off the watcher - an out-of-graph
      // .json change makes Vite full-reload every client, shell included (measured).
      // Host build output is ignored too: `next build` (etc.) writing .next/ was firing
      // a storm of full page reloads at the open canvas (friction log #21).
      watch: {
        ignored: [
          '**/design/manifest.json', '**/design/boards/**', '**/design/.local/**', '**/design/.dist/**', '**/design/comments/**',
          '**/.next/**', '**/.turbo/**', '**/.vercel/**', '**/.output/**', '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**',
          // tool-output dirs written into the project must never reload the canvas
          '**/.gstack/**', '**/.git/**', '**/.playwright-mcp/**',
          // context/'s JSON (the map, sync state): read by the check and the status pass, never by a frame
          '**/context/map.json', '**/context/sync/**',
        ],
      },
      // A8: pre-transform the frame boot chain at server start so the FIRST frame load never
      // races Vite's on-demand transform/optimize (the cold-boot "frame never reported ready"
      // race - every content frame statically pulls the content primitives). optimizeDeps
      // already pre-bundles marked/mermaid; this warms the source modules around them.
      // Warm ONLY the frame boot chain (not the design frames themselves - warming those as
      // clientFiles registers each as a boundary-less /@fs/ module whose edit forces a full
      // page reload, defeating A7 controlled HMR). Frames transform on demand, fast, once the
      // chain + optimized deps are warm.
      warmup: {
        clientFiles: [
          join(clientDir, 'frame-host', 'main.tsx'),
          join(clientDir, 'frame-host', 'bridge.js'),
          join(clientDir, 'content', 'index.tsx'),
          join(clientDir, 'content', 'diagram.tsx'),
          join(clientDir, 'content', 'md.ts'),
        ],
      },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      // Vite 8 built-in; harmless no-op warning on older majors.
      tsconfigPaths: true,
    } as any,
    optimizeDeps: {
      exclude: [PKG],
      // marked/mermaid: content-frame deps. Pre-bundling avoids the 504
      // Outdated-Optimize-Dep white-frame on the FIRST Diagram/Md mount (friction
      // 0.2.2 #1). Nested "PKG > dep" form: Vite resolves them through marver's own
      // node_modules, so non-hoisted pnpm hosts resolve correctly too.
      include: [
        'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime',
        `${PKG} > marked`, `${PKG} > mermaid`, `${PKG} > roughjs`, `${PKG} > html-to-image`,
        // the chart runtime: imported from inside the excluded package, so never pre-bundled on its own - a
        // first chart frame fetched ~600 separate echarts modules (40 with these)
        `${PKG} > echarts/core`, `${PKG} > echarts/renderers`, `${PKG} > echarts/charts`, `${PKG} > echarts/components`,
        ...iconModules(root),   // the per-icon modules the design imports (icons.ts), bundled up front
      ],
      entries: [join(clientDir, 'frame-host', 'index.html'), 'design/**/*.{tsx,jsx}'],
    },
    logLevel: 'info',
  })

  // 3. Vite's full close, awaited, if anything after this fails - the close of the server serving then (a
  // restart replaces it, step 6)
  let closeVite = server.close.bind(server)
  t.defer(() => closeVite())
  /** what holds the HTTP server itself, put back on the new one after a restart (step 6) */
  const onRestart: (() => void)[] = []
  await opts.at?.('created')

  // 4. listen. A failure here ends the start: no retry inside the process (A1.1)
  try { await server.listen() } catch (err) {
    if (opts.recover) throw new DevStartError(`--recover could not bind ${opts.recover.bind}: ${(err as Error)?.message ?? err} - it never takes another address`, { cause: err })
    if (/is already in use/.test(String((err as Error)?.message)) || (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE')
      throw new DevStartError(`port ${claim.port} was just taken by another program - start again`, { cause: err })
    throw err
  }
  await opts.at?.('listening')
  const port = claim.port
  const origin = originOf(server.httpServer?.address()) ?? `http://localhost:${port}`

  // 5. publish: the slot file, whole, as ready with the address actually bound - the one the app loads -
  // and dev.json, the CLI's discovery + credential handshake (removed on every way out)
  claim.ready(origin)
  const { workActivity, writeDevInfo, removeDevInfo, boardsShowing, onBoardsChanged, nextActivitySeq } = await import('./work.ts')
  t.claim(() => removeDevInfo(root, instance))
  writeDevInfo(root, port, instance)
  await opts.at?.('published')

  // name the project on every boot, and say loudly when a port of its own was taken - so two concurrent
  // projects can never be confused (a tab bookmarked to one silently serving the other)
  if (placed.fellBackFrom) console.log(`\n  port ${placed.fellBackFrom} is in use - serving "${projectName}" on slot ${claim.slot} instead`)
  console.log(`\n  ${NAME} · ${projectName} → http://localhost:${port}/\n`)
  // where it ran before (A1.6): an unsent Jam capture waits at that address, in that browser. A --recover
  // run replays an entry, so it records nothing
  const address: RunAddress = { slot: claim.slot, url: claim.url, bind: origin, ws: run.ws }
  if (opts.recover) console.log(`  recovering: open ${opts.recover.url} in the browser that made the capture (the app loads ${opts.recover.bind}) - with Live Jam on, a capture waiting there sends itself; then stop this canvas (Ctrl-C)\n`)
  else {
    try {
      const { first, previous } = notePrefer(run.id, address)
      t.claim(() => stopPrefer(run.id, address))
      if (first && claim.slot) {
        const old = legacyPort(root)
        console.log(`  ports are now fixed slots: this canvas is at ${claim.url}${old !== port ? `\n  0.26 served it at http://localhost:${old}/ - a Jam capture left unsent there: npx ${NAME} dev --recover` : ''}\n`)
      } else if (previous && (previous.url !== address.url || previous.bind !== address.bind || previous.ws !== address.ws)) {
        console.log(`  last run was at ${previous.url} (bound ${previous.bind}) - a Jam capture left unsent there: npx ${NAME} dev --recover\n`)
      }
    } catch (err) { console.warn(`[${NAME}] could not record this canvas's address (${(err as Error).message}) - it runs; next time it may take another slot`) }
  }
  if (fromConfig !== undefined && !placed.fellBackFrom) console.log(`  this canvas keeps its own port (${fromConfig} in design/config.ts); remove it to use the slots\n`)
  // headless browsers and profiles an earlier version left behind (they outlived their
  // server; on macOS such a ghost can swallow the machine's link opens) - once, off the path
  setTimeout(async () => { try { await (await import('./shot.ts')).sweepGhosts((m) => console.log(`  ${m}`)) } catch { /* best-effort */ } }, 0)

  // Staleness signal: the new code is running, but the managed instructions on disk may
  // predate it (e.g. this workspace was scaffolded before jam.md shipped). Distinct from the
  // registry update-check below - this compares the INSTALLED package's templates against the
  // on-disk markers. Read-only and self-guarding; a re-init refreshes them.
  try {
    const { staleManagedInstructions } = await import('./managed.ts')
    const stale = staleManagedInstructions(root)
    if (stale.length) {
      const shown = stale.slice(0, 4).join(', ') + (stale.length > 4 ? `, +${stale.length - 4} more` : '')
      const v = installedVersion()
      console.log(`  instructions predate ${v ? NAME + ' ' + v : 'the installed version'} (${shown}) - run: npx ${NAME} init\n`)
    }
  } catch { /* a boot must never fail on an advisory check */ }

  // feature and project boards with no context/ to read: every status says Backlog - say why, once, at boot
  try {
    if (!existsSync(join(root, 'context'))) {
      const n = (await import('./manifest.ts')).statusBoards(root).length
      if (n) console.log(`  ${n} feature/project board${n === 1 ? '' : 's'}, no context/ - every status reads Backlog. To start it, tell your agent: "Set up our context."\n`)
    }
  } catch { /* advisory */ }

  // comment sync loop: ~30s exchanges with the publish target. The
  // ticker ALWAYS runs and re-reads credentials each pass, so `comments connect`
  // issued while dev is already open starts syncing on the next tick - no restart.
  // Single-flight; quiet on failure - the exchange is idempotent, the next one heals.
  const { loadCollab, syncOnce } = await import('./sync.ts')
  if (loadCollab(root)) console.log(`  comments: syncing with the published canvas\n`)
  let syncing = false
  const tick = async () => {
    if (syncing) return
    syncing = true
    try {
      const collab = loadCollab(root)
      if (collab) await syncOnce(root, collab).catch(() => { /* next tick heals */ })
    } finally { syncing = false }
  }
  void tick()
  const syncTimer = setInterval(tick, 30_000)
  syncTimer.unref()
  t.defer(() => clearInterval(syncTimer))

  // The working-state rail: ONE shared presence set (work.ts) that both the jam daemon and
  // the `marver work` CLI write; the glow rides the existing HMR rail (sh:jam-activity), so
  // the canvas lights up within the first second - no extra poll.
  // the frames glow, and the boards showing them light their sidebar icon. Sent when either changes -
  // a jam job's heartbeat re-marks its frames every 2s, and an unchanged answer is not news - each
  // with its place in the order (the page's snapshot of the same state carries it too)
  let sent = ''
  const broadcast = (frames: string[]) => {
    const state = { frames: [...frames].sort(), boards: boardsShowing(root, frames) }
    const key = JSON.stringify(state)
    if (key === sent) return
    sent = key
    server.ws.send('sh:jam-activity', { ...state, seq: nextActivitySeq() } as any)
  }
  const unsubscribe = workActivity.onChange(broadcast)
  // a pin moved to another board while the work runs: the lit boards move with it
  const offBoards = onBoardsChanged((r) => { if (r === root) broadcast(workActivity.active()) })
  const sweep = setInterval(() => workActivity.sweep(), 15_000)
  sweep.unref?.()
  t.defer(() => { unsubscribe(); offBoards(); clearInterval(sweep) })

  // Comments written OUTSIDE the shell - an agent's `comments new` / `reply` / `resolve`, a sync
  // pull, a teammate's merge - reach the open canvas at once (the board's log is re-read, its
  // fresh events raise their pill), instead of on the 30s poll. The shell's own writes echo here
  // too: harmless, a re-read is a union.
  {
    const dir = join(root, 'design', 'comments')
    const due = new Map<string, ReturnType<typeof setTimeout>>()
    try {
      mkdirSync(dir, { recursive: true })   // so the watcher attaches before the first comment
      const w = fsWatch(dir, { persistent: false }, (_e, file) => {
        const m = typeof file === 'string' ? file.match(/^([a-z0-9][a-z0-9-]*)\.jsonl$/) : null
        if (!m) return
        clearTimeout(due.get(m[1]))
        due.set(m[1], setTimeout(() => { due.delete(m[1]); server.ws.send('sh:jam-comment', { board: m[1] } as any) }, 120))
      })
      t.defer(() => { w.close(); for (const x of due.values()) clearTimeout(x) })
    } catch { /* the 30s poll is the backstop */ }
  }

  // Live Jam: the dev server IS the daemon. On by default - a resolved jam block means armed.
  if (config.jam) {
    const { startJam } = await import('./jam/daemon.ts')
    const { checkAnchor } = await import('./anchor-check.ts')
    const jam = startJam(root, config.jam, (m) => console.log(m),
      (board) => server.ws.send('sh:jam-comment', { board } as any),   // reply landed - fetch now, don't wait the 30s poll
      // a re-pin is found in the rendered frame, as `comments move` finds it
      (frameId, target, others, look) => checkAnchor({ root, viewports: config.viewports, origin: `http://localhost:${port}`, frameId, target, others, ...look }),
      // the queue changed - pages redraw the status icons by each tag's time (coalesced: one push per tick)
      (() => {
        let due: ReturnType<typeof setTimeout> | null = null
        return () => { due ??= setTimeout(async () => { due = null; const { jamLive } = await import('./jam/live.ts'); server.ws.send('sh:jam-queue', (jamLive.view?.() ?? { cards: [] }) as any) }, 60) }
      })(),
      // a jam picture: one frame shot headless into an immutable file behind an opaque id
      async (frameId, theme, entry, size) => {
        const { shootFrame } = await import('./shot.ts')
        const r = await shootFrame({ root, viewports: config.viewports, frameId, theme, origin: `http://localhost:${port}`, ...(size ? { size } : {}) })
        if (!r.ok) return null
        const { addPicture } = await import('./jam/capture.ts')
        return addPicture(root, r.path, { frame: frameId, ...entry, ...(/not checked for a stale surface/.test(r.note ?? '') ? { unchecked: true as const } : {}) })
      })
    if (jam) {
      t.defer(() => jam.stop())
      // words on this Mac (spec 27 Part 4): the audio socket beside the canvas; the model loads on first use
      const { createSpeech, speechLive } = await import('./jam/audio.ts')
      // a session's talk (what is said between its captures) goes to its transcript, on this Mac
      const { appendTalk } = await import('./jam/session.ts')
      const { logJam } = await import('./perf-jam.ts')
      const speech = createSpeech({ onTalk: (t) => appendTalk(root, t.session, t.words), onTiming: (t) => logJam(root, { kind: 'words', ...t }) })
      const attach = () => { if (server.httpServer) speech.attach(server.httpServer as import('node:http').Server) }
      attach()
      onRestart.push(attach)
      speechLive.svc = speech
      t.defer(() => { speech.stop(); speechLive.svc = undefined })
    }
  } else if (config.jamOff === 'no-agent') {
    // The one off-state nobody has explained yet - and a feature that arms itself has to say
    // when it could not, or silence reads as "marver has no such thing". Opting out is
    // deliberate, and a bad `jam.agent` already printed its own reason: both stay quiet.
    console.log(`  jam: no agent CLI on PATH (claude, codex, cursor, droid, opencode, grok, or pi) - install one and tag @${NAME} in a comment\n`)
  }
  // 6. from here every way out is a close: Marver's things newest first, Vite's server, then the files.
  // Vite's own SIGTERM path calls this same `close` (it reads the property when it runs).
  // A restart is no way out. Vite restarts in place when an .env file changes: it makes the new server (Marver's
  // configureServer runs for it), closes the old one through this same `close`, copies the new one's methods -
  // `close` and `restart` among them - over this object, and listens on the same port. So `restart` is wrapped
  // too: the one close it asks for closes the old Vite alone (Marver's watchers go with its HTTP server), the
  // claims, dev.json, the slot file and the process hooks stay, and both wraps go back on the new server.
  const wrap = () => {
    const vite = { close: server.close.bind(server), restart: server.restart.bind(server) }
    closeVite = vite.close
    let armed = false   // the restart's own close is next
    let restarting: Promise<void> | null = null
    const close = (() => {
      if (!armed) return t.close()
      armed = false
      return vite.close()
    }) as typeof server.close
    server.close = close
    server.restart = ((forceOptimize?: boolean) => restarting ??= (async () => {
      let failed: unknown
      armed = true
      try { await vite.restart(forceOptimize) } catch (err) { failed = err ?? new Error('restart failed') } finally { armed = false; restarting = null }
      // Vite could not make the new server (it says why): the old one serves on, as it was
      if (server.close === close) return
      wrap()
      if (failed === undefined) { for (const f of onRestart) f(); return }
      // the old server is closed and the new one could not listen: the canvas is down, so the start ends here
      console.error(`\n  the canvas stopped: it could not restart on port ${port} (${(failed as Error)?.message ?? failed}) - start it again\n`)
      await t.close()
      throw failed
    })()) as typeof server.restart
  }
  wrap()
  return server
}
