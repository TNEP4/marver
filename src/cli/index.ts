#!/usr/bin/env node
import { cac } from 'cac'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME } from './name.ts'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`${NAME} needs Node >= 22.18 (native TypeScript config loading). You have ${process.versions.node}.`)
  process.exit(1)
}

// design/config.ts loads through Node's native TS import; without "type" in the HOST's
// package.json Node prints MODULE_TYPELESS_PACKAGE_JSON advising the user to change
// THEIR package - wrong advice from a guest tool. Swallow that one code, keep the rest.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: any, ...rest: any[]) => {
  const opt = rest[0]
  const code = (typeof opt === 'object' && opt ? opt.code : rest[1]) ?? (warning && typeof warning === 'object' ? (warning as any).code : undefined)
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return
  emitWarning(warning, ...rest)
}) as typeof process.emitWarning

/** The real installed version - dist/cli.mjs lives one level under the package root. */
function version(): string {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version
  } catch { return '0.0.0' }
}

/** The project root, REAL path. A root reached through a symlink (macOS's /var → /private/var,
 *  a linked projects folder) would be watched under the link while the OS reports events under
 *  the real path - and every frame add, brief edit and config change would go unseen. */
const resolve = (dir: string): string => { const p = resolvePath(dir); try { return realpathSync(p) } catch { return p } }

const cli = cac(NAME)

cli
  .command('init', 'Scaffold design/ in this repo')
  .option('--mode <mode>', 'studio | embedded', { default: 'studio' })
  .option('--no-demo', 'Skip the demo scene (the demo ships unless this flag is passed)')
  .option('--kind <kind>', "product | knowledge - the sidebar's typed folders (a fresh canvas: product when an app is detected)")
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .action(async (opts) => {
    if (opts.kind !== undefined && opts.kind !== 'product' && opts.kind !== 'knowledge') {
      console.error(`[${NAME}] --kind ${opts.kind}: use product or knowledge`)
      process.exit(1)
    }
    const { init } = await import('./init.ts')
    init(resolve(opts.root), { mode: opts.mode === 'embedded' ? 'embedded' : 'studio', demo: opts.demo !== false, kind: opts.kind })
  })

// One command, two names: `dev` reads naturally to developers, `canvas` to everyone
// else. Both start the full local canvas - hot reload, comments, Live Jam, working
// state - there is no reduced mode. cac has no alias API, so register both.
for (const [name, desc] of [
  ['dev', 'Start the local canvas (everything on: hot reload, comments, Live Jam)'],
  ['canvas', 'Start the local canvas - same as dev'],
] as const) {
  cli
    .command(name, desc)
    .option('--root <dir>', 'Host repo root', { default: '.' })
    .option('--port <port>', 'Port (default 5199)')
    .action(async (opts) => {
      const { dev } = await import('../server/dev.ts')
      let port: number | undefined
      if (opts.port !== undefined) {
        const n = Number(opts.port)
        if (Number.isInteger(n) && n > 0 && n < 65536) port = n
        else console.warn(`[${NAME}] ignoring invalid --port "${opts.port}"`)
      }
      await dev(resolve(opts.root), port)
    })
}

cli
  .command('build', 'Static export → design/.dist (what ships comes from design/publish.json - publishing is default-closed)')
  .option('--boards <names>', 'Publish only these boards (comma-separated); overrides the publish policy')
  .option('--all-boards', 'Publish every board - the loud override for the default-closed policy')
  .option('--embed-seeds', 'Copy comment history INTO the web root (identifying - every event carries its author\'s email)')
  .option('--no-textures', 'Skip compiling the glass textures the published frames rest under (needs Chrome; a CI without one skips on its own)')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .action(async (opts) => {
    const { buildSite } = await import('../server/build.ts')
    try {
      // cac yields `true` for a valueless/empty --boards; any presence of the flag
      // must reach buildSite so an empty filter fails CLOSED, never publishes all
      const boards = opts.boards === undefined ? undefined : typeof opts.boards === 'string' ? opts.boards : ''
      await buildSite(resolve(opts.root), boards, opts.allBoards === true, opts.embedSeeds === true, opts.textures !== false && !process.env.MARVER_NO_TEXTURES)
    } catch (err) {
      console.error(`[${NAME}] build failed: ${(err as Error).message}`)
      process.exit(1)
    }
  })

cli
  .command('serve', 'Serve design/.dist (set MARVER_PASSWORD to gate it)')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--port <port>', 'Port (default $PORT or 4199)')
  .action(async (opts) => {
    const { serve } = await import('../server/serve.ts')
    let port: number | undefined
    if (opts.port !== undefined) {
      const n = Number(opts.port)
      if (Number.isInteger(n) && n > 0 && n < 65536) port = n
    }
    serve(resolve(opts.root), port)
  })

cli
  .command('comments <action> [value]', 'Comment collaboration: connect <url> · sync · list · reply <thread> · resolve <thread> · invite <email> · revoke <email>')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--token <token>', 'connect: the canvas\'s MARVER_CLI_TOKEN (default $MARVER_CLI_TOKEN) - the identity-mode path')
  .option('--invite <token>', 'connect: claim this invite instead of signing in')
  .option('--canvas-password <password>', 'connect: the canvas gate password (default $MARVER_PASSWORD or prompt)')
  .option('--email <email>', 'connect: account email (skips the prompt)')
  .option('--password <password>', 'connect: account password (skips the prompt - mind your shell history)')
  .option('--name <name>', 'connect --invite: display name for the new account')
  .option('--open', 'list: only unresolved threads')
  .option('--json', 'list: machine-readable output')
  .option('--board <board>', 'scope to one board')
  .option('--body <text>', 'reply: the reply text')
  .option('--addressed-in <frame>', 'resolve: the variant frame that answered the feedback')
  .action(async (action: string, value: string | undefined, opts) => {
    const { commentsCommand } = await import('./comments.ts')
    try { await commentsCommand(resolve(opts.root), action, value, opts) }
    catch (err) {
      console.error(`[${NAME}] ${(err as Error).message}`)
      process.exit(1)
    }
  })

cli
  .command('share <action> [value]', 'Sharing roster (owner): add <who> · remove <who> · block/unblock <email> · general <mode> · list · requests · explain <who> · who')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--role <role>', 'add / requests --approve: view (default) or comment')
  .option('--expires <iso>', 'add: expiry timestamp, e.g. 2026-12-31T00:00:00Z')
  .option('--approve <email>', 'requests: approve this pending request (canvas-wide in v1)')
  .option('--decline <email>', 'requests: decline this pending request (silent to the asker)')
  .option('--json', 'list: machine-readable output')
  .action(async (action: string, value: string | undefined, opts) => {
    const { shareCommand } = await import('./share.ts')
    try { await shareCommand(resolve(opts.root), action, value, opts) }
    catch (err) {
      console.error(`[${NAME}] ${(err as Error).message}`)
      process.exit(1)
    }
  })

cli
  .command('work <action> [...frames]', 'Working state on the canvas: start <scene/frame ...> · done <scene/frame ...> | --all · list')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--ttl <minutes>', 'start: minutes before the glow self-expires (default 10, max 30)')
  .option('--all', 'done: clear every working frame')
  .action(async (action: string, frames: string[], opts) => {
    const { workCommand } = await import('./work.ts')
    try { await workCommand(resolve(opts.root), action, frames ?? [], opts) }
    catch (err) {
      console.error(`[${NAME}] ${(err as Error).message}`)
      process.exit(1)
    }
  })

cli
  .command('boards [action] [name]', 'The sidebar as files: every folder and board in reading order, with types and statuses · new <name>: a board in its type\'s starting layout')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--json', 'The tree as JSON ({ tree, boards, landing, registry })')
  .option('--type <type>', 'new: start | feature | surface | project | feedback | context | deck | archive (default: the folder\'s)')
  .option('--folder <folder>', 'new: the folder it sits in')
  .option('--title <title>', 'new: what humans see')
  .option('--description <sentence>', 'new: what agents read')
  .option('--capability <slug>', 'new: the capability it shows, when not its own name')
  .action(async (action: string | undefined, name: string | undefined, opts) => {
    const { boardsCommand, boardsNew } = await import('./boards.ts')
    try {
      if (action === undefined) boardsCommand(resolve(opts.root), opts)
      else if (action === 'new') {
        if (!name) throw new Error('name the board: `boards new <name>`')
        for (const c of boardsNew(resolve(opts.root), name, opts)) console.log(`  + ${c}`)
      } else throw new Error(`unknown action "${action}" - \`boards\` lists, \`boards new <name>\` creates`)
    } catch (err) {
      console.error(`[${NAME}] ${(err as Error).message}`)
      process.exit(1)
    }
  })

cli
  .command('folders <action> [...modules]', 'The shared sidebar\'s typed folders · add <start|features|surfaces|projects|feedback|context|decks|archive ...>')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .action(async (action: string, modules: string[], opts) => {
    const { foldersAdd } = await import('./boards.ts')
    try {
      if (action !== 'add') throw new Error(`unknown action "${action}" - \`folders add <module ...>\``)
      const { added, existing } = foldersAdd(resolve(opts.root), modules)
      for (const a of added) console.log(`  + design/boards/_folders.json: ${a}`)
      for (const e of existing) console.log(`  = ${e} exists - left as it is`)
    } catch (err) {
      console.error(`[${NAME}] ${(err as Error).message}`)
      process.exit(1)
    }
  })

cli
  .command('context <action>', 'The project\'s context/ (spec 19) · init: create it · check: keep it true (exit 0 pass, 1 fail, 2 cannot determine) · index: regenerate the index\'s capability table')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--base <ref>', 'check: the pull request\'s base - a change to a contracted capability\'s code must change its contract or say why (in ci, read from the event)')
  .option('--head <ref>', 'check: the pull request\'s head (default HEAD)')
  .option('--body-file <file>', 'check: the pull request\'s body, for `no-contract-change: <capability> - <why>`')
  .option('--json', 'check: the findings as JSON ({ exit, failures, unsure, notes })')
  .action(async (action: string, opts) => {
    const ctx = await import('./context.ts')
    const root = resolve(opts.root)
    try {
      if (action === 'init') {
        const created = ctx.contextInit(root)
        for (const c of created) console.log(`  + ${c}`)
        if (!created.length) console.log('  context/ is already set up - nothing to add')
        console.log(`\n  next: tell your agent "Read design/instructions/context.md and set up our context" - the setup interview, then a first draft from evidence.\n  in ci: npx ${NAME} context check  (with full history: fetch-depth: 0)\n`)
      } else if (action === 'check') {
        const { readFileSync } = await import('node:fs')
        const pr = ctx.pullRequestFromEnv()
        const r = ctx.contextCheck(root, pr ?? { base: opts.base, head: opts.head, body: opts.bodyFile ? readFileSync(opts.bodyFile, 'utf8') : '' })
        if (opts.json) console.log(JSON.stringify(r, null, 2)); else ctx.printCheck(r)
        process.exit(r.exit)
      } else if (action === 'index') {
        const { words, changed } = ctx.contextIndex(root)
        console.log(`  context/INDEX.md: ${changed ? 'capability table regenerated' : 'already current'} - ${words} / ${ctx.INDEX_BUDGET} words`)
      } else throw new Error(`unknown action "${action}" - init, check or index`)
    } catch (err) {
      console.error(`[${NAME}] ${(err as Error).message}`)
      process.exit(1)
    }
  })

cli
  .command('shot [...frames]', 'Render frames headless and print the PNG paths (needs `dev` running): ids, --scene <name> or --all')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--scene <name>', 'Every frame of one scene')
  .option('--all', 'Every frame of the canvas')
  .option('--theme <name>', 'Theme to render (default: light)')
  .option('--scale <n>', 'Device pixels per CSS px, 1-4 (default: 2; 4 for print-quality stills)')
  .option('--json', 'Print the results as JSON ({ results: [...] }) instead of paths')
  .action(async (frames: string[], opts) => {
    const { shotCommand } = await import('./shot.ts')
    try { await shotCommand(resolve(opts.root), frames, opts) }
    catch (err) {
      console.error(`[${NAME}] ${(err as Error).message}`)
      process.exit(1)
    }
  })

cli.help()
cli.version(version())
cli.parse()
