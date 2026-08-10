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
    await dev(resolve(opts.root), opts.port ? Number(opts.port) : undefined)
  })

cli
  .command('build', 'Static export (M2)')
  .action(() => {
    console.log(`${NAME} build ships in M2 - see SPEC.md §12.`)
    process.exit(1)
  })

cli.help()
cli.version('0.1.0')
cli.parse()
