import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome } from '../src/server/cdp.ts'

/**
 * Bakes that survive a restart (bake-reuse.ts), on a real `marver dev` and its real compiler: a start with nothing
 * changed reuses the last session's bakes - the same generation, answered from the disk; a frame edited while the
 * server was stopped, or a config read at boot edited while it ran, is a fresh generation that compiles again.
 */

const PORT = 6100 + Math.floor(Math.random() * 300)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`
const OWNER = { cookie: 'mv_c=tok', 'x-mv-c': 'tok', 'content-type': 'application/json' }
const ASK = { frame: 'app/glass', theme: 'light', w: 500, h: 300 }

const GLASS = `export const meta = { title: 'Glass' }
export default () => (
  <main style={{ position: 'relative', margin: 0, minHeight: '100vh', background: 'linear-gradient(135deg, #19c2a0, #7b61ff)' }}>
    <div style={{ position: 'absolute', left: 40, top: 40, width: 300, padding: 18, borderRadius: 16, background: 'rgba(255,255,255,.35)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>Glass</div>
  </main>
)
`

let root = ''
let server: ChildProcess | null = null
let log = ''
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const bakesDir = () => join(root, 'design', '.local', 'bakes')
const record = (): { gen: number } | null => { try { return JSON.parse(readFileSync(join(bakesDir(), 'reuse.json'), 'utf8')) } catch { return null } }

async function start(): Promise<void> {
  log = ''
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) return
    await wait(200)
  }
  throw new Error(`dev server did not start: ${log.slice(-800)}`)
}
async function stop(): Promise<void> {
  const s = server
  server = null
  if (!s || s.exitCode !== null) return
  const gone = new Promise((r) => s.once('exit', r))
  s.kill('SIGTERM')
  await Promise.race([gone, wait(15_000)])
  if (s.exitCode === null) s.kill('SIGKILL')
}
type Answer = { ok: boolean; ms?: number; error?: string; targets?: { verified: boolean; texture: string }[] }
async function ask(): Promise<{ gen: number; answer: Answer }> {
  const r = await fetch(`${ORIGIN}/__mv/api/bakes`, { method: 'POST', headers: OWNER, body: JSON.stringify({ asks: [ASK] }) })
  const j = await r.json() as { gen: number; answers: Answer[] }
  return { gen: j.gen, answer: j.answers[0] }
}
/** Ask until the compile is done (the page's own retry, faster). */
async function baked(): Promise<{ gen: number; answer: Answer; asks: number }> {
  for (let i = 1; i < 200; i++) {
    const a = await ask()
    if (a.answer.ok || !/compiling/.test(a.answer.error ?? '')) return { ...a, asks: i }
    await wait(300)
  }
  throw new Error('never baked')
}
async function until(fn: () => boolean, ms = 20_000): Promise<void> {
  const t0 = Date.now()
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await wait(100) }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mv-bake-reuse-dev-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bake-reuse-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const repoNm = join(repoRoot, 'node_modules')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(repoNm)) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver') symlinkSync(join(repoNm, e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  mkdirSync(join(root, 'design', 'scenes', 'app'), { recursive: true })
  writeFileSync(join(root, 'design', 'scenes', 'app', 'glass.tsx'), GLASS)
  mkdirSync(join(root, 'design', 'boards'), { recursive: true })
  writeFileSync(join(root, 'design', 'boards', 'main.json'), JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [{ key: 'g1', frame: 'app/glass', x: 0, y: 0, w: 500, h: 300 }] }))
})
afterAll(async () => { await stop(); rmSync(root, { recursive: true, force: true }) })

const maybe = findChrome() ? describe : describe.skip
maybe('bakes that survive a restart (a real dev server)', () => {
  let first = 0

  it('a first start compiles, and once quiet records its generation', async () => {
    await start()
    const b = await baked()
    expect(b.answer.ok, b.answer.error).toBe(true)
    expect(b.answer.targets?.some((t) => t.verified && t.texture)).toBe(true)
    first = b.gen
    await until(() => record()?.gen === first)
  }, 180_000)

  it('a restart with nothing changed reuses them: the same generation, answered from the disk at once', async () => {
    await stop()
    await start()
    const a = await ask()
    expect(a.gen).toBe(first)
    expect(a.answer.ok, a.answer.error).toBe(true)
    expect(a.answer.ms).toBe(0)   // the disk cache's answer: no compile
    expect(log).toMatch(/bakes: reusing the last session's/)
    expect(existsSync(join(bakesDir(), String(first)))).toBe(true)
  }, 120_000)

  it('a frame edited while the server was stopped: a fresh generation, compiled again, the old one pruned', async () => {
    await stop()
    appendFileSync(join(root, 'design', 'scenes', 'app', 'glass.tsx'), '\n// edited while stopped\n')
    await start()
    const b = await baked()
    expect(b.gen).not.toBe(first)
    expect(b.answer.ok, b.answer.error).toBe(true)
    expect(b.asks).toBeGreaterThan(0)
    expect(log).not.toMatch(/bakes: reusing/)
    await until(() => !existsSync(join(bakesDir(), String(first))))
    await until(() => record()?.gen === b.gen)
    first = b.gen
  }, 180_000)

  it('a config read at boot edited while it runs: no record from this session, so the next start is fresh', async () => {
    writeFileSync(join(root, 'design', 'config.ts'), 'export default { description: "edited in the session" }\n')
    await until(() => record() === null, 30_000)
    expect(log).toMatch(/design\/config\.ts changed while the server ran/)
    await stop()
    await start()
    const b = await baked()
    expect(b.gen).not.toBe(first)
    expect(log).not.toMatch(/bakes: reusing/)
  }, 180_000)
})
