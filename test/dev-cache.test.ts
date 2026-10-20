import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { init } from '../src/cli/init.ts'
import { dev } from '../src/server/dev.ts'

/**
 * #7: a content frame's diagram failed with "Failed to fetch dynamically imported module .../.vite/deps/..."
 * until `marver dev` restarted. Marver kept Vite's default cache folder, node_modules/.vite, which every other
 * Vite on the same root shares; when the host app's Vite (or a Vitest run, `vite --force`) optimized, it replaced
 * deps/ under the running canvas, and each pre-bundle not served yet - mermaid's lazily loaded diagram chunks -
 * answered 504 "Outdated Optimize Dep". Driven against a real Vite server and a real second one: the question
 * is what the running canvas still serves after the other optimizes.
 */

const repo = join(import.meta.dirname, '..')
let root = ''
let server: Awaited<ReturnType<typeof dev>> | null = null
let base = ''

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-devcache-')))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host', type: 'module', devDependencies: {} }))
  // the host's own node_modules (so the other Vite resolves react) - never the repo's caches
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(join(repo, 'node_modules'))) if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repo, 'node_modules', e), join(nm, e))
  init(root, { mode: 'studio', demo: true })
  server = await dev(root)
  const addr = server?.httpServer?.address() as any
  base = `http://localhost:${addr.port}`
}, 120_000)

afterAll(async () => {
  await server?.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('content frames keep their modules when another Vite optimizes the same root (#7)', () => {
  it('marver keeps its own pre-bundle folder', () => {
    expect(server!.config.cacheDir).toBe(join(root, 'node_modules', '.vite-marver'))
  })

  it('a state diagram chunk not served yet still answers after the host app\'s Vite optimizes', async () => {
    // the diagram runtime as a frame imports it: its pre-bundled mermaid entry
    const diag = await (await fetch(`${base}/@fs${join(repo, 'src', 'client', 'content', 'diagram.tsx')}`)).text()
    const entry = /"(\/[^"]*mermaid\.js\?v=[^"]*)"/.exec(diag)?.[1]
    expect(entry, 'the mermaid pre-bundle').toBeTruthy()
    const dir = entry!.slice(0, entry!.lastIndexOf('/') + 1)
    // load mermaid's static graph, as a page that drew a flowchart has: its lazy diagram chunks stay unserved
    const seen = new Set<string>()
    let chunk: string | undefined
    const crawl = async (u: string): Promise<void> => {
      if (seen.has(u)) return
      seen.add(u)
      const code = await (await fetch(base + u)).text()
      chunk ??= /import\("([^"]*\/stateDiagram-v2-[^"]+)"/.exec(code)?.[1]
      for (const m of code.matchAll(/(?:from|import)\s*"([^"]+)"/g)) if (m[1].startsWith(dir)) await crawl(m[1])
    }
    await crawl(entry!)
    expect(chunk, 'mermaid\'s lazily loaded state diagram chunk').toBeTruthy()
    // the host app's Vite on the same root, optimizing its own deps from scratch
    const other = await createServer({ root, configFile: false, logLevel: 'silent', server: { port: 0 }, optimizeDeps: { include: ['react'], force: true } })
    await other.listen()
    await (other as any).environments?.client?.depsOptimizer?.scanProcessing
    await new Promise((r) => setTimeout(r, 1500))
    await other.close()
    const res = await fetch(base + chunk)
    expect(res.status).toBe(200)
  }, 60_000)
})
