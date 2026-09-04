import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome } from '../src/server/cdp.ts'

/**
 * Shots as ONE operation: a batch rides one browser, several frames at a time, every entry
 * answers for itself - and the browser exists only while the operation runs. Proven against
 * a REAL dev server from dist/cli.mjs and real Chrome, through every door (the API, the CLI,
 * the file-drop inbox), and the one property this release exists for: `kill -9` the server
 * mid-shot and nothing is left running. Skips, never fails, without Chrome.
 */
const hasChrome = !!findChrome()
const PORT = 5700 + Math.floor(Math.random() * 300)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const ORIGIN = `http://localhost:${PORT}`
let root = ''
let server: ChildProcess | null = null
let token = ''
let hang: Server | null = null
let hangPort = 0

/** Chrome browser processes (not helpers) on marver shot profiles, with their parent pid. */
const shotBrowsers = (): { pid: number; ppid: number; profile: string }[] => {
  const out = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout
  const rows: { pid: number; ppid: number; profile: string }[] = []
  for (const l of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)
    if (!m || !m[3].includes('--headless') || m[3].includes('--type=')) continue
    const p = /--user-data-dir=(\S+mv-shot-\S+)/.exec(m[3])
    if (p) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), profile: p[1] })
  }
  return rows
}
const ours = () => shotBrowsers().filter((r) => r.ppid === server?.pid)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const api = (body: unknown) => fetch(`${ORIGIN}/__mv/api/shots`, { method: 'POST', headers: { 'x-mv-work': token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const startServer = async () => {
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1', MARVER_SHOT_CONCURRENCY: '3' } })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000) {
    if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break
    await wait(200)
  }
  while (Date.now() - t0 < 60_000) {
    try { if (JSON.parse(readFileSync(join(root, 'design', 'manifest.json'), 'utf8')).frames.length >= 6) break } catch { /* not yet */ }
    await wait(200)
  }
  token = JSON.parse(readFileSync(join(root, 'design', '.local', 'dev.json'), 'utf8')).token
}

beforeAll(async () => {
  if (!hasChrome) return
  root = mkdtempSync(join(tmpdir(), 'mv-batch-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'batch-fixture', private: true, type: 'module' }))
  const repoRoot = join(import.meta.dirname, '..')
  const nm = join(root, 'node_modules')
  mkdirSync(nm)
  for (const e of readdirSync(join(repoRoot, 'node_modules'))) { if (e !== '.bin') symlinkSync(join(repoRoot, 'node_modules', e), join(nm, e)) }
  mkdirSync(join(nm, '@marver-design'))
  symlinkSync(repoRoot, join(nm, '@marver-design', 'marver'))
  // a socket that accepts and never answers: an <img> pointing at it never completes
  hang = createServer(() => {})
  await new Promise<void>((r) => hang!.listen(0, '127.0.0.1', () => r()))
  hangPort = (hang.address() as { port: number }).port
  const app = join(root, 'design', 'scenes', 'app')
  const other = join(root, 'design', 'scenes', 'other')
  mkdirSync(app, { recursive: true }); mkdirSync(other, { recursive: true })
  const fixed = (label: string, bg: string) => `export const meta = { title: '${label}', viewport: 'mobile' }
export default () => <main style={{ minHeight: '100vh', background: '${bg}' }}><h1 style={{ margin: 0, padding: 24, color: '#fff' }}>${label}</h1></main>
`
  writeFileSync(join(app, 'a.tsx'), fixed('A', '#0b5'))
  writeFileSync(join(app, 'b.tsx'), fixed('B', '#05b'))
  writeFileSync(join(app, 'c.tsx'), fixed('C', '#b05'))
  writeFileSync(join(other, 'x.tsx'), fixed('X', '#333'))
  writeFileSync(join(app, 'throws.tsx'), `export const meta = { title: 'Throws', viewport: 'mobile' }
export default () => { throw new Error('boom from the frame') }
`)
  writeFileSync(join(app, 'slow.tsx'), `export const meta = { title: 'Slow', viewport: 'mobile' }
export default () => <main style={{ minHeight: '100vh' }}><img src="http://127.0.0.1:${hangPort}/never.png" width={200} height={200} alt="" /><h1>Slow</h1></main>
`)
  await startServer()
}, 120_000)

afterAll(() => {
  try { server?.kill('SIGTERM') } catch { /* gone */ }
  hang?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!hasChrome)('a batch of shots is one operation', () => {
  it('shoots several frames in one browser, in the order asked, and leaves nothing running', async () => {
    const seen = new Set<string>()
    let samples = 0
    const sampler = setInterval(() => { for (const r of ours()) { seen.add(r.profile); samples++ } }, 100)
    const res = await api({ frames: ['app/a', 'app/b', 'app/c', 'other/x'] })
    clearInterval(sampler)
    expect(res.status).toBe(200)
    const { results } = await res.json()
    expect(results.map((r: any) => r.frame)).toEqual(['app/a', 'app/b', 'app/c', 'other/x'])
    for (const r of results) {
      expect(r.ok).toBe(true)
      expect(existsSync(join(root, r.path))).toBe(true)
      expect(r.width).toBe(390)
      expect(r.unsettled).toBeUndefined()
    }
    // the sampler saw the batch's browser (control), and exactly ONE profile served every frame
    expect(samples).toBeGreaterThan(0)
    expect(seen.size).toBe(1)
    // and it is gone, profile included, as soon as the operation is
    const t0 = Date.now()
    while (Date.now() - t0 < 2000 && ours().length) await wait(50)
    expect(ours()).toEqual([])
    await wait(400)   // the profile goes after exit; give the rm its beat
    for (const p of seen) expect(existsSync(p)).toBe(false)
  }, 60_000)

  it('a failing frame fails alone: unknown id and a throwing frame, the good one ships', async () => {
    const res = await api({ frames: ['app/a', 'nope/nothing', 'app/throws'] })
    expect(res.status).toBe(200)
    const { results } = await res.json()
    expect(results.map((r: any) => r.ok)).toEqual([true, false, false])
    expect(results[1].error).toMatch(/unknown frame "nope\/nothing"/)
    expect(results[2].error).toMatch(/boom from the frame/)
    expect(existsSync(join(root, results[0].path))).toBe(true)
  }, 60_000)

  it('validates the ask before anything renders', async () => {
    expect((await api({ frames: ['app/a', 'app/a'] })).status).toBe(400)
    expect((await api({ frames: ['app/a'], scale: 9 })).status).toBe(400)
    expect((await api({ frames: ['app/a'], theme: 'bad theme' })).status).toBe(400)
    expect((await api({ scene: 'nowhere' })).status).toBe(404)
    expect((await api({ frames: ['app/a'], scene: 'app' })).status).toBe(400)
    expect((await api({ frames: Array.from({ length: 201 }, (_, i) => `x/${i}`) })).status).toBe(400)
    expect((await api({})).status).toBe(400)
    expect((await fetch(`${ORIGIN}/__mv/api/shots`, { method: 'POST', body: '{}' })).status).toBe(403)
  })

  it('a scene and --all expand in manifest order', async () => {
    const scene = await (await api({ scene: 'other' })).json()
    expect(scene.results.map((r: any) => r.frame)).toEqual(['other/x'])
    const all = await (await api({ all: true, frames: undefined })).json()
    const listed = JSON.parse(readFileSync(join(root, 'design', 'manifest.json'), 'utf8')).frames.map((f: any) => f.id)
    expect(all.results.map((r: any) => r.frame)).toEqual(listed)
  }, 90_000)

  it('a frame that runs out of settle budget ships and SAYS so', async () => {
    const { results } = await (await api({ frames: ['app/slow', 'app/a'] })).json()
    expect(results[0].ok).toBe(true)
    expect(results[0].unsettled).toBe(true)
    expect(results[0].note).toMatch(/captured before the frame settled/)
    expect(results[1].unsettled).toBeUndefined()
  }, 60_000)

  it('the CLI: several frames, a scene, --json, and a failure on stderr with exit 1', () => {
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, 'shot', '--root', root, ...args], { cwd: root, encoding: 'utf8' })
    const two = run(['app/a', 'app/b'])
    expect(two.status).toBe(0)
    expect(two.stdout.trim().split('\n')).toEqual(['design/.local/shots/app--a--light.png', 'design/.local/shots/app--b--light.png'])
    const scene = run(['--scene', 'other'])
    expect(scene.status).toBe(0)
    expect(scene.stdout.trim()).toBe('design/.local/shots/other--x--light.png')
    const mixed = run(['app/a', 'app/throws'])
    expect(mixed.status).toBe(1)
    expect(mixed.stdout.trim()).toBe('design/.local/shots/app--a--light.png')
    expect(mixed.stderr).toMatch(/^app\/throws: the frame rendered an error/m)
    const json = run(['app/a', '--json'])
    expect(json.status).toBe(0)
    expect(JSON.parse(json.stdout).results[0]).toMatchObject({ frame: 'app/a', ok: true, path: 'design/.local/shots/app--a--light.png' })
    const none = run(['--scene', 'other', 'app/a'])
    expect(none.status).toBe(1)
    expect(none.stderr).toMatch(/name the frames, one way/)
  }, 120_000)

  it('the inbox takes a batch, writes the result atomically, and never deletes a request it did not process', async () => {
    const inbox = join(root, 'design', '.local', 'shots')
    writeFileSync(join(inbox, 'round.request.json'), JSON.stringify({ scene: 'other' }))
    const t0 = Date.now()
    while (Date.now() - t0 < 30_000 && !existsSync(join(inbox, 'round.result.json'))) await wait(100)
    const r = JSON.parse(readFileSync(join(inbox, 'round.result.json'), 'utf8'))
    expect(r.ok).toBe(true)
    expect(r.results.map((x: any) => x.frame)).toEqual(['other/x'])
    expect(existsSync(join(inbox, 'round.request.json'))).toBe(false)
    // overwrite while the first (slow) request is in flight: the second must still run
    writeFileSync(join(inbox, 'over.request.json'), JSON.stringify({ frame: 'app/slow' }))
    await wait(700)   // picked up (60ms settle + the sweep tick), now rendering
    writeFileSync(join(inbox, 'over.request.json'), JSON.stringify({ frame: 'app/b' }))
    const t1 = Date.now()
    let last: any = null
    while (Date.now() - t1 < 40_000) {
      try { last = JSON.parse(readFileSync(join(inbox, 'over.result.json'), 'utf8')) } catch { /* not yet or mid-rename */ }
      if (last?.path?.includes('app--b') && !existsSync(join(inbox, 'over.request.json'))) break
      await wait(100)
    }
    expect(last?.path).toBe('design/.local/shots/app--b--light.png')
    expect(existsSync(join(inbox, 'over.request.json'))).toBe(false)
  }, 90_000)

  it('THE property: kill -9 the server mid-shot and its browser is gone within two seconds', async () => {
    // a slow frame holds the browser open long enough to catch it in the act
    const inFlight = api({ frames: ['app/slow'] }).catch(() => null)
    const t0 = Date.now()
    while (Date.now() - t0 < 10_000 && !ours().length) await wait(50)
    const live = ours()
    expect(live.length).toBe(1)                        // control: the browser IS there
    expect(() => process.kill(live[0].pid, 0)).not.toThrow()
    server!.kill('SIGKILL')
    const t1 = Date.now()
    let alive = true
    while (Date.now() - t1 < 2000) {
      try { process.kill(live[0].pid, 0) } catch { alive = false; break }
      await wait(50)
    }
    expect(alive).toBe(false)
    expect(shotBrowsers().filter((r) => r.profile === live[0].profile)).toEqual([])
    await inFlight
    server = null
  }, 30_000)
})
