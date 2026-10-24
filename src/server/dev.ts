import { createLogger, createServer, searchForWorkspaceRoot, type DevEnvironment, type ResolvedConfig, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, mkdirSync, realpathSync, statSync, watch as fsWatch, writeSync } from 'node:fs'
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
import { forgetDevTraces, marverHome, notePrefer, originOf, place, ranDevBefore, startedWhere, stopPrefer, type Recover, type RunAddress } from './slots.ts'
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
 * Guarded at every way Vite finds a file, not only at the request's own path: Vite resolves an
 * extensionless `?import` (`/.mv-home/running/slot-1?import` is slot-1.json) and a directory's index, so the
 * guard looks where a missing path would land; and the homes are in `fs.deny` (registryDeny) and refused by
 * this plugin's own `load`, so no query (`?import`, `?raw`, `?url`, `?inline`) and no spelling of the id that
 * reaches Vite's module pipeline (`/@fs/`, `/@id/`) loads one of their files.
 */
function denyLocalSecrets(root: string): any {
  const guardedAt = join(root, 'design', '.local')
  const homes = registryHomes()
  // Vite's default publicDir. dev.ts never overrides it, so this is the one extra
  // place a request path can come from.
  const publicAt = join(root, 'public')
  // A missing design/.local (or registry) means there is nothing there to protect.
  const real = (d: string) => { try { return realpathSync(d) } catch { return null } }
  /** what a resolved path is inside: design/.local, a registry home, or nothing */
  const refusal = (reals: string[]): string | null => {
    const local = real(guardedAt)
    if (local && reals.some((r) => inside(r, local))) return 'design/.local holds this canvas\'s credentials and is never served'
    for (const h of homes) {
      const home = real(h)
      if (home && reals.some((r) => inside(r, home))) return 'the canvas registry (~/.marver) is never served'
    }
    return null
  }
  return {
    name: 'marver:deny-local-secrets',
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: () => void) => {
        let pathname: string
        try { pathname = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]) } catch { return next() }
        const rel = '.' + (pathname.startsWith('/') ? pathname : `/${pathname}`)
        // `/@fs/<abs>` is Vite's escape hatch for files outside the root, and `/@id/<id>` hands an id to
        // its resolver as it is (an absolute path, or one in the root); root and public are the two
        // places an ordinary path can land. Queries do not change which file: they are cut off above.
        const id = pathname.startsWith('/@id/') ? pathname.slice('/@id/'.length) : null
        const bases = pathname.startsWith('/@fs/') ? [pathname.slice('/@fs'.length)]
          : id !== null ? [...(id.startsWith('/') ? [resolvePath(id)] : []), resolvePath(root, '.' + (id.startsWith('/') ? id : `/${id}`))]
          : [resolvePath(root, rel), resolvePath(publicAt, rel)]
        const why = refusal(bases.flatMap(resolvedAs))
        if (!why) return next()
        res.statusCode = 403
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(why)
      })
    },
    // Vite's module pipeline, whatever the request looked like: every id it loads passes here first
    // (`order: 'pre'`, ahead of the asset plugin's `?raw` / `?inline` reads)
    load: {
      order: 'pre',
      handler(id: string) {
        const file = id.split('?')[0].split('#')[0]
        if (!isAbsolute(file)) return null   // a virtual module (`\0...`, `virtual:...`): no file
        const at = landing(file)
        const why = at === null ? null : refusal([at])
        if (why) throw new Error(why)
        return null
      },
    },
  }
}

/** Vite's default `resolve.extensions`: an extensionless import is tried with each, in this order. */
const VITE_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']

const inside = (real: string, dir: string) => {
  const rel = relative(dir, real)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Where a path lands once links are followed, whether or not it exists: the real path of its nearest
 * existing folder with the rest of the path after it. Vite's resolution only ever adds to the last name
 * (an extension, `/index`), so a path whose folder is inside a guarded one lands inside it, whatever
 * Vite then tries.
 */
function landing(p: string): string | null {
  let dir = p
  let rest = ''
  for (;;) {
    try { return rest ? join(realpathSync(dir), rest) : realpathSync(dir) } catch { /* not there */ }
    const up = dirname(dir)
    if (up === dir) return null
    rest = rest ? join(basename(dir), rest) : basename(dir)
    dir = up
  }
}

/**
 * The real files a request path can be served as. Vite derives more paths than it is asked for: a
 * missing `/leak` can resolve to `leak.html` or, as an import, `leak.json` (every one of Vite's
 * extensions); a folder to its `index` (`index.html`, `index.json`, ...). Enumerating a bundler's
 * resolution rules is not a game anyone wins, which is why the credential itself lives outside the
 * repository and the registry is also in `fs.deny` and refused at `load` - this list is depth, not the
 * defence. It covers the derivations Vite actually applies, and where a missing path would land.
 */
function resolvedAs(base: string): string[] {
  const at = (p: string) => { try { return realpathSync(p) } catch { return null } }
  const isDir = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }
  const found = at(base)
  if (found !== null) {
    if (!isDir(found)) return [found]
    return [found, ...['', '.html', ...VITE_EXTENSIONS].map((e) => at(join(base, `index${e}`))).filter((r): r is string => r !== null)]
  }
  const lands = landing(base)
  return [...(lands ? [lands] : []), ...['.html', ...VITE_EXTENSIONS].map((e) => at(`${base}${e}`)).filter((r): r is string => r !== null)]
}

/** The registry's homes (A1.13 #5): this run's MARVER_HOME and the ~/.marver in the home folder, each as
 *  given and as its real path (a request names the one, Vite resolves ids to the other). */
export function registryHomes(): string[] {
  return [...new Set([marverHome(), join(homedir(), '.marver')].flatMap((h) => [resolvePath(h), safeReal(resolvePath(h))]))]
}

/** The homes as `fs.deny` globs - each folder and everything in it, its name matched literally - so Vite's
 *  own file serving and module loading refuse them too, by the resolved path it checks. */
export function registryDeny(homes = registryHomes()): string[] {
  const literal = (p: string) => p.replace(/[\\*?[\]{}()!+@|]/g, '\\$&')
  return homes.flatMap((h) => [literal(h), `${literal(h)}/**`])
}

/** The canvas did not start: what failed, said - everything the start held is given back first. */
export class DevStartError extends Error {}
/** A canvas already runs in this folder (or one is starting): the line says where, or what to do. */
export class DevLockError extends DevStartError {}

/** The steps of a start, as `DevOptions.at` sees them. */
export type StartStep = 'locked' | 'claimed' | 'env' | 'configure' | 'created' | 'listening' | 'published' | 'dispose' | 'disposed'
export interface DevOptions {
  /** --port: a port of its own; inside the slot range it claims exactly that slot (spec 28 A1.3) */
  port?: number
  /** --recover: exactly this earlier address and workspace key - never another (A1.6) */
  recover?: Recover
  /** tests only (startup.test.ts): called at each step of the start - a throw fails it there, a promise
   *  that never settles pauses it. 'env' runs inside Vite's environment initialisation, 'configure'
   *  after Marver's configureServer, 'dispose' as what a server that never serves made begins to close
   *  (a failed start's, a failed or left restart's) - a promise there holds that close - and 'disposed' once it is closed */
  at?: (step: StartStep, info?: { port: number }) => unknown
  /** the canvas ended on its own once it served - a file watcher failed: called once everything is closed (the CLI
   *  prints it and exits 1). Without it, the line is printed */
  onFail?: (err: DevStartError) => void
}

/** The line for a file watcher that fails: `fs.watch` in a sandbox (Codex's: every one fails with EMFILE), or a
 *  system's watch limit. */
export const cannotWatch = (err: unknown): string =>
  `${NAME} dev cannot watch this folder (${(err as Error)?.message ?? err}) - in a sandbox? ask the person to run npx ${NAME} dev in their own terminal`

/** What becomes of the start's file watchers' errors. Each watcher the start makes - Vite's, and every one of
 *  Marver's - is handed here as it is made; without a listener, its error would end the process with Node's own
 *  "Unhandled 'error' event". The first error fails the start at its next step, through the Startup like any
 *  failure (nothing left, exit 1); once the canvas serves, it ends the canvas (its one close), then says so. */
interface WatchGuard {
  add<W extends { on(event: 'error', fn: (err: Error) => void): unknown }>(w: W): W
  /** a watcher has failed: the start fails here */
  check(): void
  /** the start is done: a failure from now on closes the canvas */
  serving(close: () => Promise<void>): void
}
function watchGuard(onFail?: (err: DevStartError) => void): WatchGuard {
  let failed: DevStartError | null = null
  let close: (() => Promise<void>) | null = null
  const seen = new WeakSet<object>()
  const fail = (err: Error) => {
    if (failed) return
    const e = failed = new DevStartError(cannotWatch(err), { cause: err })
    if (close) void close().catch(() => { /* closing what failed */ }).then(() => (onFail ?? ((x) => console.error(`\n  ${x.message}\n`)))(e))
  }
  return {
    add(w) { if (!seen.has(w)) { seen.add(w); w.on('error', fail) } return w },
    check() { if (failed) throw failed },
    serving(c) { close = c },
  }
}

/** Said when a signal (Ctrl-C, a kill) stops a canvas that served: an open tab holds its edits until it is back. */
const STOPPED = 'canvas stopped - open tabs keep their edits and save when it is back'

/**
 * Start the canvas (spec 28 A1.1): 1. dev.lock, 2. an address - a slot, a port of its own, or
 * --recover's - held as a file, 3. Vite's server, 4. listening on exactly that port, 5. published: the
 * slot file as ready, dev.json, 6. the close (the slot file `closing` first). Every step's claims belong to one Startup, so a failure
 * anywhere closes what was made and gives back what was held, and `dev()` rejects with a DevStartError -
 * it never ends the process itself (the CLI does, A1.13 #4), so an embedding caller is left clean.
 */
export async function dev(root: string, opts: DevOptions = {}) {
  const t = new Startup()
  // every way out gives back what is held by then - a failed start, a close, an exit, Ctrl-C or a kill
  t.hookProcess()
  const watch = watchGuard(opts.onFail)
  let served = false
  try {
    // 1. one canvas per folder (#19): the lock comes first, so a second `marver dev` never starts a server
    const { takeDevLock } = await import('./dev-lock.ts')
    const lock = await takeDevLock(root, { onTaken: (release) => t.claim(release) })
    if (!lock.ok) throw new DevLockError(lock.message)
    // did a canvas run in this folder before? - read once the folder is this start's alone, so no other start's traces
    // are in it, and before this start writes any
    const ranBefore = ranDevBefore(root)
    // a start that never served, in a folder no canvas had run in, takes back the traces it wrote - once everything of
    // it has closed and before the lock goes, so the next start there finds the folder as this one did (its first)
    t.claim(() => { if (!served && !ranBefore) forgetDevTraces(root) })
    await opts.at?.('locked')
    const server = await boot(root, opts, lock.instance, t, { ranBefore, watch })
    // a watcher that failed during the start's last steps fails the start; one that fails from now on ends the canvas
    watch.check()
    watch.serving(() => server.close())
    // a stop by a signal says so, at once - before the claims go back and the signal ends the process
    t.onSignal(() => { try { writeSync(1, `\n  ${STOPPED}\n\n`) } catch { /* no terminal to say it to */ } })
    served = true
    return server
  } catch (err) {
    // newest first: the server if there is one, Marver's watchers, then the files (the traces, then the lock)
    await t.close()
    if (err instanceof DevStartError) throw err
    throw new DevStartError(`the canvas could not start: ${(err as Error)?.message ?? err}`, { cause: err })
  }
}

async function boot(root: string, opts: DevOptions, instance: string, t: Startup, ctx: { ranBefore: boolean; watch: WatchGuard }) {
  const { watch } = ctx
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
    // the name the shell shows (spec 28 A2.14 #23): the app's tab and Home card wear it, "TMS broker" not "tms-broker"
    root: run.root, name: config.share.name || basename(run.root), version: installedVersion() ?? '0.0.0', id: run.id, ws: run.ws, instance,
    onHold: (release) => t.claim(release),
    ...(opts.recover ? { recover: { port: opts.recover.port } }
      : explicitPort !== undefined ? { explicit: { port: explicitPort, from: fromConfig !== undefined ? 'config' as const : 'flag' as const } } : {}),
  })
  if (!placed.ok) throw new DevStartError(placed.message)
  const { claim } = placed
  // a close, whatever asks for it, first rewrites the slot file `closing` - still held, the file gone last, once nothing
  // of the start can bind or serve: however long that takes, `marver ls` and the app never read `ready` meanwhile
  t.onClose(() => claim.closing())
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

  // 3. Vite's server belongs to the start from the moment it holds anything, never from the moment it is handed
  // back - the first one, and each one a restart makes (step 6). Vite makes its file watcher and HMR socket, then
  // initialises its environments (each plugin's `options` runs there), then installs a SIGTERM handler and runs every
  // configureServer hook - and a throw at any of those leaves what it made behind: at the start to an embedding
  // caller, and in a restart, which Vite survives by saying so and serving on with the old server, to the canvas until
  // its process ends. So each construction is owned on its own, from its resolved config: each environment as Vite
  // makes it, with the watcher and the socket it is given; from its first configureServer hook, before any other
  // (Marver's own, a host's) can fail, the server itself, by its full close; and what Marver's plugin makes for that
  // server. One that throws is closed whole - at the start with the rest of the start, in a restart at once. The server
  // that serves is closed in the start's one place for it, `closeVite`: the close of the server serving then.
  interface Construction {
    envs: Set<DevEnvironment>
    parts: Set<{ close(): unknown }>
    /** the server's full close, from its first configureServer hook */
    close: (() => Promise<void>) | null
    /** what Marver's plugin made for this server (its HTTP server's close takes them, and one that never listened never closes) */
    mine: Set<() => unknown>
    withdraw: (() => void) | null
    /** the start ended while this one was a restart's: the restart closes it as it settles, never the start (step 6) */
    left: boolean
  }
  interface Replacing {
    /** the construction latest when it began */
    from: Construction | null
    /** Vite has put the new server in place on the start's server object */
    handed: boolean
    /** Vite has said it is about to close the old server - once a restart, at most (step 6) */
    armed: boolean
    /** the next close, in this same turn, is Vite's of the old server */
    oldClose: boolean
    /** the restart's end - its last cleanup included */
    over: Promise<void>
  }
  const constructions = new WeakMap<ResolvedConfig, Construction>()
  let latest: Construction | null = null
  let closeVite: () => Promise<void> = async () => {}
  let inPlace = false   // the start's place for the server serving: taken by the first server
  /** the start's end, once asked for (step 6) */
  let ending: Promise<void> | null = null
  /** the restart whose Vite run is on its way (step 6): its new server being made, put in place, listening */
  let replacing: Replacing | null = null
  /** every restart not over yet, from its start to its last cleanup - a failed construction's close included (step 6) */
  const restarts = new Set<Replacing>()
  const dispose = async (c: Construction) => {
    if (opts.at) await opts.at('dispose')
    if (c.close) await c.close().catch(() => { /* closing what failed */ })
    else {
      await Promise.allSettled([...c.envs].map(async (env) => {
        // an environment whose initialisation failed has no plugin container, and its close throws before the rest
        try { await env.close() } catch { await env.depsOptimizer?.close() }
      }))
      await Promise.allSettled([...c.parts].map(async (p) => p.close()))
    }
    for (const fn of [...c.mine].reverse()) { try { await fn() } catch { /* closing what failed */ } }
    if (opts.at) await opts.at('disposed')
  }
  // a restart's construction the start has left - or one begun once the start has ended - is the restart's to close
  const own = (c: Construction) => { if (!c.left && !ending) c.withdraw ??= t.defer(() => dispose(c)) }
  /** A construction is over: its server serves (the start's place closes it from now - at once, in this turn), or it
   *  never will - it threw, or the start ended while a restart made it (closed now). */
  const settle = (c: Construction, serves: boolean): Promise<void> | void => {
    c.withdraw?.()
    c.withdraw = null
    if (serves) c.mine.clear()   // the start holds them, and the server's own close takes them
    else return dispose(c)
  }
  /** what Marver's plugin hands the start: kept until the start ends - or, named for a server, until that server goes */
  const startup = {
    defer(fn: () => unknown, vite?: ViteDevServer): () => void {
      const c = vite ? constructions.get(vite.config) : undefined
      if (!c) return t.defer(fn)
      let done = false
      const once = () => { if (done) return; done = true; c.mine.delete(once); return fn() }
      c.mine.add(once)
      const withdraw = t.defer(once)
      return () => { c.mine.delete(once); withdraw() }
    },
  }
  plugins.push(...marverPlugin({ root, clientDir, config, detectedThemeCss: host.themeCss, workspace: run.ws, startup: { ...startup, watch: watch.add }, proof: { instance, key: claim.key, port: claim.port } }), iconsPlugin(root))
  plugins.unshift({
    name: 'marver:startup-owns-server',
    configResolved(resolved: ResolvedConfig) {
      // each construction resolves its own config: the start's, and each restart's
      const c: Construction = { envs: new Set(), parts: new Set(), close: null, mine: new Set(), withdraw: null, left: false }
      constructions.set(resolved, c)
      latest = c
      for (const env of Object.values(resolved.environments)) {
        const make = env.dev?.createEnvironment
        if (!make) continue
        env.dev.createEnvironment = async (name, config, context) => {
          const made = await make(name, config, context)
          own(c)
          c.envs.add(made)
          if (context.ws) c.parts.add(context.ws)
          const init = made.init.bind(made)
          // Vite's file watcher: its error is the start's (watchGuard), never Node's unhandled one
          made.init = (o) => { if (o?.watcher) { c.parts.add(o.watcher); watch.add(o.watcher) } return init(o) }
          return made
        }
      }
    },
    configureServer: {
      order: 'pre',
      handler(vite: ViteDevServer) {
        const c = constructions.get(vite.config)
        if (!c) return
        // the whole server now: its close closes the environments, the watcher, the socket and its SIGTERM handler with the rest
        c.close = vite.close.bind(vite)
        own(c)
        // a server binds only while the start lasts: a restart's whose listen Vite asks for once the start has ended fails
        // it - said as a listen error, which ends that restart. One asked for before cannot be called back (Node looks
        // the host up, then binds): it binds, and its restart closes it before the claims go back (step 6)
        const http = vite.httpServer as { listen: (...args: unknown[]) => unknown; emit(event: 'error', err: Error): boolean } | null
        if (http) {
          const listen = http.listen
          http.listen = function (this: unknown, ...args: unknown[]) {
            if (!ending) return listen.apply(this, args)
            process.nextTick(() => http.emit('error', new Error('the canvas has closed')))
            return this
          }
        }
        if (inPlace) return   // a restart's: its own until the restart settles it (step 6)
        inPlace = true
        closeVite = c.close
        c.withdraw?.()
        c.withdraw = null
        t.defer(() => closeVite())
      },
    },
  })
  if (opts.at) {
    // the test seam's probe: its `options` runs inside Vite's environment initialisation (once per
    // environment - said once per server made, a restart's too), its configureServer after Marver's (which is `enforce: 'pre'`)
    let env = false
    plugins.push({ name: 'marver:startup-probe', configResolved() { env = false }, async options() { if (!env) { env = true; await opts.at!('env') } }, async configureServer() { await opts.at!('configure') } })
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
        deny: [...FS_DENY, ...registryDeny()],
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

  // the start's server: it serves, and the start's place closes it
  const first = constructions.get(server.config)
  if (first) settle(first, true)
  /** what holds the HTTP server itself, put back on the new one after a restart (step 6) */
  const onRestart: (() => void)[] = []
  await opts.at?.('created')
  watch.check()

  // 4. listen. A failure here ends the start: no retry inside the process (A1.1)
  try { await server.listen() } catch (err) {
    if (opts.recover) throw new DevStartError(`--recover could not bind ${opts.recover.bind}: ${(err as Error)?.message ?? err} - it never takes another address`, { cause: err })
    if (/is already in use/.test(String((err as Error)?.message)) || (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE')
      throw new DevStartError(`port ${claim.port} was just taken by another program - start again`, { cause: err })
    throw err
  }
  await opts.at?.('listening')
  watch.check()
  const port = claim.port
  const origin = originOf(server.httpServer?.address()) ?? `http://localhost:${port}`

  // 5. publish: the slot file, whole, as ready with the address actually bound - the one the app loads -
  // and dev.json, the CLI's discovery + credential handshake (removed on every way out)
  claim.ready(origin)
  const { workActivity, writeDevInfo, removeDevInfo, boardsShowing, onBoardsChanged, nextActivitySeq } = await import('./work.ts')
  t.claim(() => removeDevInfo(root, instance))
  writeDevInfo(root, port, instance)
  await opts.at?.('published')
  watch.check()

  // name the project on every boot, and say loudly when a port of its own was taken - so two concurrent
  // projects can never be confused (a tab bookmarked to one silently serving the other)
  if (placed.fellBackFrom) console.log(`\n  port ${placed.fellBackFrom} is in use - serving "${projectName}" on slot ${claim.slot} instead`)
  console.log(`\n  ${NAME} · ${projectName} → http://localhost:${port}/\n`)
  // where it ran before (A1.6): a tab still open at another address holds its unsaved edits until this canvas runs
  // there again, and a Jam capture left unsent - if one was - waits there, in that browser. Nothing here knows
  // whether one was, so the hint says if. A --recover run replays an entry, so it records nothing
  const address: RunAddress = { slot: claim.slot, url: claim.url, bind: origin, ws: run.ws }
  if (opts.recover) console.log(`  recovering: open ${opts.recover.url} in the browser that made the capture (the app loads ${opts.recover.bind}) - with Live Jam on, a capture waiting there sends itself; then stop this canvas (Ctrl-C)\n`)
  else {
    try {
      const { first, previous } = notePrefer(run.id, address)
      t.claim(() => stopPrefer(run.id, address))
      const lines = startedWhere({ root, run: address, port, first, previous, ranBefore: ctx.ranBefore })
      if (lines.length) console.log(`${lines.map((l) => `  ${l}`).join('\n')}\n`)
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
      const w = watch.add(fsWatch(dir, { persistent: false }, (_e, file) => {
        const m = typeof file === 'string' ? file.match(/^([a-z0-9][a-z0-9-]*)\.jsonl$/) : null
        if (!m) return
        clearTimeout(due.get(m[1]))
        due.set(m[1], setTimeout(() => { due.delete(m[1]); server.ws.send('sh:jam-comment', { board: m[1] } as any) }, 120))
      }))
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
      },
      watch.add)
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
  // 6. from here every way out is a close: Marver's things newest first, Vite's server, then the files - the start's one
  // end (`end`), however it is asked for. Vite's own SIGTERM and stdin-end paths call this same `close` (they read the
  // property when they run); on a signal the start's hook has given the claims back first, synchronously, and the
  // signal it raises again ends the process before that close is done (Vite listens `once`).
  // A restart is no way out. Vite restarts in place when an .env file changes: it makes the new server (Marver's
  // configureServer runs for it), closes the old one through this object's `close`, puts the new one in place by
  // copying its methods over this object (Object.assign), then listens on the same port. So `close` and `restart` are
  // Marver's on this object for good, whatever Vite copies: accessors, whose setters take what Vite assigns - the new
  // server's own close and restart, kept aside (`live`) - and whose getters always answer Marver's. Vite's close of the
  // old server is told from anyone else's by what Vite does just before it: once the new server is made, Vite clears
  // its CLI shortcuts state on this object (`server._shortcutsState = void 0`) and asks for the close in the very next
  // statement, in the same turn. So that property is an accessor too, kept as it was, and its setter, the first time a
  // restart's new server is made and not in place yet, says the next close is Vite's (`oldClose`) - that one close, and
  // only until that turn ends (a test reads Vite's restart for that order: startup.test.ts). It closes the old server
  // alone (Marver's watchers go with its HTTP server); the claims, dev.json, the slot file and the process hooks stay.
  // Any other close, at any point of a restart - a timer set off while the new server was made among them - is the
  // start's end: it rewrites the slot file `closing` (held still), then closes what runs at once - the server serving,
  // which is the old one until the new one listens, and
  // Marver's things - but not the new server, which the restart closes once Vite is done with it (closed half-made, Vite
  // would go on making it; closed while it binds, Vite's close, which runs once, would find nothing bound and leave the
  // socket open): Vite's close of the old server is then refused, so the new one is never put in place, and one in place
  // whose listen is asked for from now on never binds (it fails, above). One whose listen was already on its way - Node
  // looking 'localhost' up before it binds - binds once that is done, and its restart closes it. So the end then waits
  // for every restart to be over (`restarts`), to its last cleanup - its server closed, what a server that could not be
  // made made, closed - however long that takes, and only then gives back the claims and the process hooks, last: while
  // anything of the start could still bind or serve, its lock, slot file and dev.json stay, and no starter finds the slot
  // free - the slot file saying `closing` all the while, so `marver ls` and the app never take it for a canvas that
  // serves. No restart awaits that end, so the wait ends. The one close a restart awaits is its own end when its new server
  // cannot listen, which never waits on that restart (the server it put in place closes with what runs). An exit or a
  // signal still gives the claims back at once, synchronously: the process ends, and its sockets with it. That reading of
  // Vite's restart is Vite 8.2's, not a contract: package.json takes vite ~8.2 only, and a test reads Vite's restart for
  // the order above (startup.test.ts) - re-check this step before widening that range.
  const end = (self?: Replacing): Promise<void> => {
    // every restart over, to its last cleanup - never a restart's own end waiting on that restart: it waits on this close
    const others = () => Promise.all([...restarts].filter((x) => x !== self).map((x) => x.over))
    ending ??= (async () => {
      const r = replacing
      const made = r && latest !== r.from ? latest : null
      if (made) { made.withdraw?.(); made.withdraw = null; made.left = true }
      // what runs closes, then every restart's own server, and the claims go back last
      await t.close(others)
    })()
    return ending.then(others).then(() => {})
  }
  /** Vite's own close and restart of the server on this object: the first server's, then those each restart put in place */
  const live = { close: server.close, restart: server.restart }
  const close = (() => {
    const r = replacing
    // Vite's close of the old server: that server alone - refused once the start has ended, so the new one is never put
    // in place and Vite's restart ends there
    if (r?.oldClose) { r.oldClose = false; return ending ? Promise.reject(new Error('the canvas has closed')) : live.close.call(server) }
    return end()
  }) as typeof server.close
  let restarting: Promise<void> | null = null
  const restart = ((forceOptimize?: boolean) => restarting ??= (async () => {
    if (ending) return   // the start has ended: nothing to restart
    let failed: unknown
    let over = () => {}
    const r: Replacing = replacing = { from: latest, handed: false, armed: false, oldClose: false, over: new Promise<void>((res) => { over = res }) }
    restarts.add(r)
    try {
      try { await live.restart.call(server, forceOptimize) } catch (err) { failed = err ?? new Error('restart failed') } finally {
        restarting = null
        replacing = null
      }
      // the server this restart began to make, if it got as far as resolving its config
      const made = latest !== r.from ? latest : null
      if (ending) {
        // the start ended while this restart ran: what it made closes now - refused its place, put in place and never
        // bound, or bound by a listen already on its way - and the restart ends with it, nothing to say: the close is what
        // was asked for, and gives the claims back once this is done
        if (made) await settle(made, false)
        return
      }
      if (!r.handed) {
        // Vite could not make the new server (it says why): the old one serves on, as it was, and what the new one
        // made before it threw - environments, watcher, socket, a SIGTERM handler, Marver's watchers for it - closes now
        if (made) await settle(made, false)
        if (failed !== undefined) throw failed
        return
      }
      // the server now: the start's place closes it - in this same turn, so no close finds it in neither
      if (made) settle(made, true)
      closeVite = live.close.bind(server)
      if (failed === undefined) { for (const f of onRestart) f(); return }
      // the old server is closed and the new one could not listen: the canvas is down, so the start ends here
      console.error(`\n  the canvas stopped: it could not restart on port ${port} (${(failed as Error)?.message ?? failed}) - start it again\n`)
      await end(r)
      throw failed
    } finally { restarts.delete(r); over() }
  })()) as typeof server.restart
  Object.defineProperty(server, 'close', { configurable: true, enumerable: true, get: () => close,
    set: (fn: typeof live.close) => { live.close = fn; if (replacing) replacing.handed = true } })
  Object.defineProperty(server, 'restart', { configurable: true, enumerable: true, get: () => restart,
    set: (fn: typeof live.restart) => { live.restart = fn } })
  let shortcuts = (server as unknown as { _shortcutsState?: unknown })._shortcutsState
  Object.defineProperty(server, '_shortcutsState', { configurable: true, enumerable: true, get: () => shortcuts,
    set: (v: unknown) => {
      shortcuts = v
      const r = replacing
      // Vite's restart, its new server made: it clears this, then closes the old server in its next statement
      if (!r || r.handed || r.armed || v !== undefined) return
      r.armed = r.oldClose = true
      queueMicrotask(() => { r.oldClose = false })
    } })
  return server
}
