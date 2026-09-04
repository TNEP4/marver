import { createLogger, createServer, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import { createServer as netServer } from 'node:net'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME, PKG } from '../cli/name.ts'
import { loadConfig } from './config.ts'
import { detectHost } from './detect.ts'
import { marverPlugin, tailwind3Css, tailwind4Plugin } from './plugin.ts'

/** packageDir = the installed marver package root (dist/cli.js lives one level down). */
function packageDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

const portFree = (p: number): Promise<boolean> => new Promise((res) => {
  const s = netServer()
  s.once('error', () => res(false))
  s.once('listening', () => s.close(() => res(true)))
  s.listen(p, '127.0.0.1')
})
/** realpath, or the path itself when it cannot be resolved (never throws at boot). */
const safeReal = (p: string): string => { try { return realpathSync(p) } catch { return p } }

/** C1: a deterministic per-project port in [5200,5399] derived from the root path. Two projects
 *  never collide, and the same project always lands on the same port across restarts. */
const projectPort = (root: string): number => {
  let h = 0
  for (let i = 0; i < root.length; i++) h = (Math.imul(h, 31) + root.charCodeAt(i)) | 0
  return 5200 + (Math.abs(h) % 200)
}
/** Pick the port to serve on: the desired one if free, else a DETERMINISTIC per-project fallback -
 *  never a silent next-free drift, which made a bookmarked tab silently serve a DIFFERENT project. */
async function pickPort(root: string, desired: number): Promise<{ port: number; fellBack: boolean }> {
  if (await portFree(desired)) return { port: desired, fellBack: false }
  let p = projectPort(root)
  for (let i = 0; i < 200; i++) {
    if (p !== desired && await portFree(p)) return { port: p, fellBack: true }
    p = 5200 + ((p - 5200 + 1) % 200)
  }
  return { port: desired, fellBack: true }
}

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
 */
function denyLocalSecrets(root: string): any {
  const guardedAt = join(root, 'design', '.local')
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
        let guarded: string
        // A missing design/.local means there is nothing here to protect.
        try { guarded = realpathSync(guardedAt) } catch { return next() }
        // A candidate that does not resolve is a 404 Vite will produce on its own.
        const leaks = candidates.some((c) => {
          try { return inside(realpathSync(c), guarded) } catch { return false }
        })
        if (!leaks) return next()
        res.statusCode = 403
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('design/.local holds this canvas\'s credentials and is never served')
      })
    },
  }
}

export async function dev(root: string, portFlag?: number) {
  const config = await loadConfig(root)
  const host = detectHost(root)
  const pkgDir = packageDir()
  const clientDir = join(pkgDir, 'src', 'client')
  const projectName = basename(root)
  // C1 deterministic default: each project defaults to its OWN path-derived port, so two projects
  // never collide regardless of which starts first (5199-first-wins was order-dependent). An
  // explicit --port, or a config.port the user changed off the scaffolded 5199, still wins.
  const explicitPort = portFlag ?? (config.port !== 5199 ? config.port : undefined)
  const desiredPort = explicitPort ?? projectPort(root)
  const picked = await pickPort(root, desiredPort)

  const plugins: any[] = [denyLocalSecrets(root), react()]
  if (host.tailwind === 4) {
    const tw = await tailwind4Plugin(root)
    if (tw) plugins.push(...tw)
    else console.warn(`[marver] tailwindcss v4 detected but @tailwindcss/vite could not be loaded - utility classes WILL be missing from frames. Fix: npm i -D @tailwindcss/vite (used only by the canvas, never by your app's build).`)
  }
  let css: Record<string, unknown> | undefined
  if (host.tailwind === 3) css = (await tailwind3Css(root)) ?? undefined

  plugins.push(marverPlugin({ root, clientDir, config, detectedThemeCss: host.themeCss }))

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
    css: css as any,
    customLogger: logger,
    plugins,
    server: {
      port: picked.port,
      strictPort: false,
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
        `${PKG} > marked`, `${PKG} > mermaid`, `${PKG} > html-to-image`,
      ],
      entries: [join(clientDir, 'frame-host', 'index.html'), 'design/**/*.{tsx,jsx}'],
    },
    logLevel: 'info',
  })

  await server.listen()
  const addr = server.httpServer?.address()
  const port = typeof addr === 'object' && addr ? addr.port : picked.port
  // C1: name the project on every boot, and say loudly when the desired port was taken - so two
  // concurrent projects can never be confused (a tab bookmarked to one silently serving the other).
  if (picked.fellBack) console.log(`\n  port ${desiredPort} is in use - serving "${projectName}" on ${port} instead`)
  console.log(`\n  ${NAME} · ${projectName} → http://localhost:${port}/\n`)
  // headless browsers and profiles an earlier version left behind (they outlived their
  // server; on macOS such a ghost can swallow the machine's link opens) - once, off the path
  setTimeout(async () => { try { await (await import('./shot.ts')).sweepGhosts((m) => console.log(`  ${m}`)) } catch { /* best-effort */ } }, 0)

  // Staleness signal: the new code is running, but the managed instructions on disk may
  // predate it (e.g. this workspace was scaffolded before jam.md shipped). Distinct from the
  // registry update-check below - this compares the INSTALLED package's templates against the
  // on-disk markers. Read-only and self-guarding; a re-init refreshes them.
  try {
    const { staleManagedInstructions } = await import('./managed.ts')
    const { installedVersion } = await import('./update.ts')
    const stale = staleManagedInstructions(root)
    if (stale.length) {
      const shown = stale.slice(0, 4).join(', ') + (stale.length > 4 ? `, +${stale.length - 4} more` : '')
      const v = installedVersion()
      console.log(`  instructions predate ${v ? NAME + ' ' + v : 'the installed version'} (${shown}) - run: npx ${NAME} init\n`)
    }
  } catch { /* a boot must never fail on an advisory check */ }

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
  setInterval(tick, 30_000).unref()

  // The working-state rail: ONE shared presence set (work.ts) that both the jam daemon and
  // the `marver work` CLI write; the glow rides the existing HMR rail (sh:jam-activity), so
  // the canvas lights up within the first second - no extra poll. design/.local/dev.json is
  // the CLI's discovery + credential handshake, written per boot, removed on close.
  const { workActivity, writeDevInfo, removeDevInfo } = await import('./work.ts')
  const unsubscribe = workActivity.onChange((frames) => server.ws.send('sh:jam-activity', { frames } as any))
  const sweep = setInterval(() => workActivity.sweep(), 15_000)
  sweep.unref?.()
  writeDevInfo(root, port)
  {
    const close = server.close.bind(server)
    server.close = (async () => { unsubscribe(); clearInterval(sweep); removeDevInfo(root); return close() }) as typeof server.close
  }

  // Live Jam: the dev server IS the daemon. On by default - a resolved jam block means armed.
  if (config.jam) {
    const { startJam } = await import('./jam/daemon.ts')
    const jam = startJam(root, config.jam, (m) => console.log(m),
      (board) => server.ws.send('sh:jam-comment', { board } as any))   // reply landed - fetch now, don't wait the 30s poll
    if (jam) {
      const close = server.close.bind(server)
      server.close = (async () => { jam.stop(); return close() }) as typeof server.close
    }
  } else if (config.jamOff === 'no-agent') {
    // The one off-state nobody has explained yet - and a feature that arms itself has to say
    // when it could not, or silence reads as "marver has no such thing". Opting out is
    // deliberate, and a bad `jam.agent` already printed its own reason: both stay quiet.
    console.log(`  jam: no agent CLI on PATH (claude, codex, cursor, droid, opencode, grok, or pi) - install one and tag @${NAME} in a comment\n`)
  }
  return server
}
