import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { createChanges } from '../src/server/changes.ts'
import { scanFrames } from '../src/server/manifest.ts'
import { guardUpdates, type UpdateHooks } from '../src/server/updates.ts'

// The frame host's registry takes every design update and changes nothing in a document, so no document hears an update
// whose only boundary it is (updates.ts guardUpdates) - Marver's own registry, by its file: a host app's module of the same
// name, with an accept of its own, still sends its update. A real Vite dev server, no browser.

const MARVER_REGISTRY = realpathSync(join(import.meta.dirname, '..', 'src', 'client', 'frame-host', 'registry.ts'))
let root = ''
let server: ViteDevServer | null = null
const sent: string[] = [], raw: string[] = []   // what goes out past the filter; what Vite sent to it
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const put = (r: string, b: string) => { mkdirSync(dirname(join(root, r)), { recursive: true }); writeFileSync(join(root, r), b) }

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-registry-')))
  put('package.json', '{"name":"registry-fixture","type":"module"}')
  put('src/frame-host/registry.ts', 'export const n = 1\nif (import.meta.hot) import.meta.hot.accept((m) => { document.title = String(m?.n) })\n')
  put('design/scenes/s/f.tsx', "import { n } from '../../../src/frame-host/registry.ts'\nexport default () => n\n")
  const manifest = scanFrames(root)
  const changes = createChanges({ root, envs: () => Object.keys(server!.environments).length, write: () => {} })
  const hooks: UpdateHooks = { onFrames: () => {}, onReload: () => {} }
  server = await createServer({
    root, configFile: false, logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true, hmr: { port: 11100 + Math.floor(Math.random() * 300) }, fs: { allow: [root, dirname(MARVER_REGISTRY)] } },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  const env = server.environments.client
  const send = env.hot.send.bind(env.hot) as (...a: unknown[]) => void
  env.hot.send = ((p: { type?: string; updates?: { path: string }[] }, ...r: unknown[]) => { if (p?.type === 'update') sent.push(...(p.updates ?? []).map((u) => u.path)); return send(p, ...r) }) as typeof send
  guardUpdates(server, root, () => manifest, hooks, changes, () => {}, MARVER_REGISTRY)
  const guarded = env.hot.send.bind(env.hot) as (...a: unknown[]) => void
  env.hot.send = ((p: { type?: string; updates?: { path: string }[] }, ...r: unknown[]) => { if (p?.type === 'update') raw.push(...(p.updates ?? []).map((u) => u.path)); return guarded(p, ...r) }) as typeof guarded
}, 60_000)
afterAll(async () => { await server?.close(); if (root) rmSync(root, { recursive: true, force: true }) })

describe('the registry filter', () => {
  it('a host app\'s own src/frame-host/registry.ts, with an accept of its own: its update goes out', async () => {
    const env = server!.environments.client
    await env.transformRequest('/src/frame-host/registry.ts')
    sent.length = 0
    put('src/frame-host/registry.ts', 'export const n = 2\nif (import.meta.hot) import.meta.hot.accept((m) => { document.title = String(m?.n) })\n')
    server!.watcher.emit('change', join(root, 'src/frame-host/registry.ts'))
    await sleep(500)
    expect(sent).toContain('/src/frame-host/registry.ts')
  })

  it('Marver\'s own registry: its update reaches no document', async () => {
    const env = server!.environments.client
    await env.transformRequest(`/@fs${MARVER_REGISTRY}`)
    const mod = [...env.moduleGraph.getModulesByFile(MARVER_REGISTRY)!][0]
    const was = mod.lastHMRTimestamp
    sent.length = 0; raw.length = 0
    server!.watcher.emit('change', MARVER_REGISTRY)   // as a design edit propagates to it; the file itself is untouched
    await sleep(500)
    expect(raw.some((p) => p.endsWith('/frame-host/registry.ts'))).toBe(true)   // Vite sent it
    expect(sent.filter((p) => p.endsWith('/frame-host/registry.ts'))).toEqual([])
    expect(mod.lastHMRTimestamp).toBeGreaterThan(was)                            // and moved the module on, as before
  })

  it('a payload with the registry and another boundary keeps the other one, as Vite sent it', () => {
    const env = server!.environments.client
    const registry = [...env.moduleGraph.getModulesByFile(MARVER_REGISTRY)!][0].url
    sent.length = 0
    const u = (path: string) => ({ type: 'js-update' as const, path, acceptedPath: path, timestamp: 1, explicitImportRequired: false, isWithinCircularImport: false })
    env.hot.send({ type: 'update', updates: [u(registry), u('/src/frame-host/registry.ts')] })
    expect(sent).toEqual(['/src/frame-host/registry.ts'])
  })
})
