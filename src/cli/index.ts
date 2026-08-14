#!/usr/bin/env node
import { cac } from 'cac'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

const cli = cac(NAME)

cli
  .command('init', 'Scaffold design/ in this repo')
  .option('--mode <mode>', 'studio | embedded', { default: 'studio' })
  .option('--no-demo', 'Skip the demo scene (the demo ships unless this flag is passed)')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .action(async (opts) => {
    const { init } = await import('./init.ts')
    init(resolve(opts.root), { mode: opts.mode === 'embedded' ? 'embedded' : 'studio', demo: opts.demo !== false })
  })

cli
  .command('dev', 'Start the canvas')
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

cli
  .command('build', 'Static export → design/.dist (what ships comes from design/publish.json - publishing is default-closed)')
  .option('--boards <names>', 'Publish only these boards (comma-separated); overrides the publish policy')
  .option('--all-boards', 'Publish every board - the loud override for the default-closed policy')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .action(async (opts) => {
    const { buildSite } = await import('../server/build.ts')
    try {
      // cac yields `true` for a valueless/empty --boards; any presence of the flag
      // must reach buildSite so an empty filter fails CLOSED, never publishes all
      const boards = opts.boards === undefined ? undefined : typeof opts.boards === 'string' ? opts.boards : ''
      await buildSite(resolve(opts.root), boards, opts.allBoards === true)
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

cli.help()
cli.version(version())
cli.parse()
