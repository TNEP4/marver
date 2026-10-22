#!/usr/bin/env node
import { cac } from 'cac'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
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
    .option('--port <port>', 'A port of its own (default: a free slot, localhost:4805-4824 - usually the same one next time; a port in that range takes exactly that slot)')
    .option('--recover [n]', 'Run on an address this canvas had before, where an unsent Jam capture waits: alone it lists them; with a number it starts on that one; --recover --port <p>: the port 0.26 used')
    .action(async (opts) => {
      const { dev, DevStartError, DevLockError } = await import('../server/dev.ts')
      let port: number | undefined
      if (opts.port !== undefined) {
        const n = Number(opts.port)
        if (Number.isInteger(n) && n > 0 && n < 65536) port = n
        else console.warn(`[${NAME}] ignoring invalid --port "${opts.port}"`)
      }
      // a canvas that ends on its own once it served (a file watcher failed) has closed everything by then: say why, exit 1
      const onFail = (err: InstanceType<typeof DevStartError>) => { console.error(`\n  ${err.message}\n`); process.exit(1) }
      // a start that fails has already given back everything it held (spec 28 A1.1); the process ends here
      try {
        if (opts.recover !== undefined && opts.recover !== false) await (await import('./recover.ts')).recoverCommand(resolve(opts.root), opts.recover, port, { onFail })
        else await dev(resolve(opts.root), { port, onFail })
      } catch (err) {
        if (!(err instanceof DevStartError)) throw err
        console.error(`\n  ${err.message}\n`)
        // an unforeseen failure keeps its stack; the named ones (a held lock, all slots taken, a port just taken) say enough
        if (!(err instanceof DevLockError) && /^the canvas could not start/.test(err.message) && err.cause instanceof Error && err.cause.stack) console.error(err.cause.stack)
        process.exit(1)
      }
    })
}

cli
  .command('ls', 'The canvases running on this Mac: slot, link, name, version, state, uptime, folder (no repo needed)')
  .option('--json', 'Machine-readable output (never a canvas\'s key)')
  .action(async (opts) => { (await import('./ls.ts')).lsCommand({ json: opts.json === true }) })

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
  .command('comments <action> [value]', 'Comment collaboration: connect <url> · sync · list · new <scene/frame> · reply <thread> · move <thread> · resolve <thread> · invite <email> · revoke <email>')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--token <token>', 'connect: the canvas\'s MARVER_CLI_TOKEN (default $MARVER_CLI_TOKEN) - the identity-mode path')
  .option('--invite <token>', 'connect: claim this invite instead of signing in')
  .option('--canvas-password <password>', 'connect: the canvas gate password (default $MARVER_PASSWORD or prompt)')
  .option('--email <email>', 'connect: account email (skips the prompt)')
  .option('--password <password>', 'connect: account password (skips the prompt - mind your shell history)')
  .option('--name <name>', 'connect --invite: display name for the new account')
  .option('--open', 'list: only unresolved threads')
  .option('--json', 'list: machine-readable output')
  .option('--board <board>', 'list: scope to one board · new: the board to pin on (default: the one its link opens)')
  .option('--body <text>', 'new / reply: the text')
  .option('--on <text>', 'new / move: pin on the element showing these words')
  .option('--at <selector>', 'new / move: pin on the element this data-testid or CSS selector names (an element without words, like an icon)')
  .option('--nth <n>', 'new / move: which of several matching elements (1 = the first)')
  .option('--viewport <name>', 'new / move: check the frame at this viewport (default: its own)')
  .option('--theme <name>', 'new / move: check the frame in this theme (default: light)')
  .option('--thread <id>', 'new: add the note to this open thread instead of pinning a new one')
  .option('--fyi', 'new: the note asks nothing (default: it asks - it comes first for the human)')
  .option('--ask', 'reply: the reply asks the human something')
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
  .command('link [...targets]', 'The canvas link that lands on frames: link <scene/frame | scene ...> - their board, in canvas mode, selected and fitted')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--board <board>', 'The board to open (default: the first board that shows them all, else one link per board)')
  .action(async (targets: string[], opts) => {
    const { linkCommand } = await import('./link.ts')
    try { await linkCommand(resolve(opts.root), targets ?? [], opts) }
    catch (err) {
      console.error(`[${NAME}] ${(err as Error).message}`)
      process.exit(1)
    }
  })

cli
  .command('boards [action] [...args]', 'The sidebar as files: every folder and board in reading order, with types and statuses, and the frames on no board · new <name>: a board in its type\'s starting layout · pin <board> <scene/frame ...>: put frames on a board')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--json', 'The tree as JSON ({ tree, boards, landing, unplaced, registry })')
  .option('--type <type>', 'new: start | feature | surface | project | feedback | context | deck | archive (default: the folder\'s)')
  .option('--folder <folder>', 'new: the folder it sits in')
  .option('--title <title>', 'new: what humans see')
  .option('--description <sentence>', 'new: what agents read')
  .option('--capability <slug>', 'new: the capability it shows, when not its own name')
  .action(async (action: string | undefined, args: string[] | undefined, opts) => {
    const { boardsCommand, boardsNew, boardsPin } = await import('./boards.ts')
    const [name, ...frames] = args ?? []
    try {
      if (action === undefined) boardsCommand(resolve(opts.root), opts)
      else if (action === 'pin') {
        if (!name) throw new Error('name the board: `boards pin <board> <scene/frame ...>`')
        const { added, already } = boardsPin(resolve(opts.root), name, frames)
        for (const f of added) console.log(`  + ${f} on ${name}`)
        if (already.length) console.log(`  already on ${name}: ${already.join(', ')}`)
      } else if (action === 'new') {
        if (!name) throw new Error('name the board: `boards new <name>`')
        const made = boardsNew(resolve(opts.root), name, opts)
        for (const c of made) console.log(`  + ${c}`)
        // a feature's phase scenes start empty: a frame made in one shows once the board lists it
        if (/\((feature|project)\b/.test(made[0] ?? '') && !existsSync(join(resolve(opts.root), 'context')))
          console.log(`\n  note: no context/ yet - this board's status reads Backlog until there is one. Agent: end your reply with the context line in design/AGENTS.md ("Before the method").`)
        if (made.some((c) => c.endsWith('/_brief.md')) && !made.some((c) => /\.(tsx|jsx|html)$/.test(c)))
          console.log(`\n  next: a frame you make in these scenes shows on the board once it is pinned - a node in\n  design/boards/${name}.json (an agent does this as it works: design/AGENTS.md)`)
      } else throw new Error(`unknown action "${action}" - \`boards\` lists, \`boards new <name>\` creates, \`boards pin <board> <scene/frame ...>\` puts frames on a board`)
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
  .option('--kind <kind>', 'init: product (a shipped record) or knowledge (a delivered record)', { default: 'product' })
  .action(async (action: string, opts) => {
    const ctx = await import('./context.ts')
    const root = resolve(opts.root)
    try {
      if (action === 'init') {
        if (opts.kind !== 'product' && opts.kind !== 'knowledge') throw new Error(`--kind ${opts.kind}: use product or knowledge`)
        const created = ctx.contextInit(root, opts.kind)
        for (const c of created) console.log(`  + ${c}`)
        if (!created.length) console.log('  context/ is already set up - nothing to add')
        console.log(`\n  next: tell your agent "Read ${ctx.conventionsPath(root)} and set up our context" - the setup interview, then a first draft from evidence.\n  in ci: npx ${NAME} context check  (with full history: fetch-depth: 0)\n`)
      } else if (action === 'check') {
        const { readFileSync } = await import('node:fs')
        // in ci on a pull request the event supplies base, head and body; each one given here wins
        const fromEnv = ctx.pullRequestFromEnv() ?? {}
        const given = { ...(opts.base !== undefined ? { base: String(opts.base) } : {}), ...(opts.head !== undefined ? { head: String(opts.head) } : {}), ...(opts.bodyFile !== undefined ? { body: readFileSync(opts.bodyFile, 'utf8') } : {}) }
        const merged = { ...fromEnv, ...given }
        // an unreadable event no longer matters once a base is given explicitly
        if (given.base !== undefined) delete (merged as { prError?: string }).prError
        const r = ctx.contextCheck(root, merged)
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
  .command('marks', 'What the human has not reviewed: frames waiting on them (the ones that ask first), their answers nothing has acted on yet, and frames new since they looked')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--json', 'Machine-readable output')
  .option('--all', 'Also list the answers from before 0.26 that may already be handled')
  .action(async (opts) => {
    const { marksCommand } = await import('./marks.ts')
    marksCommand(resolve(opts.root), opts)
  })

cli
  .command('perf', 'The reload log: what each edit reloaded, page-wide reloads, the slowest frames to settle, one line per board load; --loads: what each board load did; --jam: Jam\'s timings')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .option('--minutes <n>', 'How far back to read (default 60; 24 h with --jam)')
  .option('--loads', 'Board loads, from the page: time to the visible frames ready, all ready, quiet, the last move and settled (or why it was cut, and how many frames were ready by then), how many moves and their causes, when the first frame started, the slowest frames and how long each waited for its turn to start, errors (design/.local/perf/page.jsonl)')
  .option('--jam', 'Jam\'s timings: captures, pictures, words, naming, runs, shots - numbers only (design/.local/perf/jam.jsonl)')
  .option('--json', 'Machine-readable output')
  .action(async (opts) => {
    const { perfCommand } = await import('./perf.ts')
    perfCommand(resolve(opts.root), opts)
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
