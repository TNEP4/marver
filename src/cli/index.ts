#!/usr/bin/env node
import { cac } from 'cac'
import { resolve } from 'node:path'
import { NAME } from './name.ts'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`${NAME} needs Node >= 22.18 (native TypeScript config loading). You have ${process.versions.node}.`)
  process.exit(1)
}

const cli = cac(NAME)

cli
  .command('init', 'Scaffold design/ in this repo')
  .option('--mode <mode>', 'studio | embedded', { default: 'studio' })
  .option('--no-demo', 'Skip the demo scene')
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
  .command('build', 'Static export → design/.dist')
  .option('--boards <names>', 'Publish only these boards (comma-separated); the frame filter is applied at build time')
  .option('--root <dir>', 'Host repo root', { default: '.' })
  .action(async (opts) => {
    const { buildSite } = await import('../server/build.ts')
    try {
      await buildSite(resolve(opts.root), typeof opts.boards === 'string' ? opts.boards : undefined)
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

cli.help()
cli.version('0.1.0')
cli.parse()
