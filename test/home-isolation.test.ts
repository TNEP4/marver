import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CLI, fixtureRoot, startDev } from './dev-server.ts'
import { collabFileFor } from '../src/server/sync.ts'

/**
 * The suite's own registry (spec 28 A1.10, A1.13 #7): every canvas a test starts registers in the
 * suite's MARVER_HOME on the suite's slot ports (test/global-setup.ts) - never in ~/.marver, never on
 * 4805-4824, where the owner's own canvases run. Read-only towards ~/.marver.
 */

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const real = join(homedir(), '.marver', 'running')
const pidsIn = (dir: string) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')).pid } catch { return null } }) : []

describe('the suite never touches the real registry', () => {
  it('MARVER_HOME is the suite\'s own - the collaboration credentials there too - and the slots are moved off 4805-4824', () => {
    const home = process.env.MARVER_HOME!
    expect(home && isAbsolute(home)).toBe(true)
    expect(home.startsWith(join(homedir(), '.marver'))).toBe(false)
    expect(collabFileFor('/tmp/any-project').startsWith(join(home, 'canvases') + '/')).toBe(true)
    const base = Number(process.env.MARVER_SLOT_BASE)
    expect(base + 1 > 4824 || base + 20 < 4805).toBe(true)
  })

  it('a canvas a test starts registers in the suite\'s home, on the suite\'s slots, and is listed there - not in ~/.marver', async () => {
    const r = fixtureRoot('mv-home-iso-', { 'design/config.ts': 'export default { jam: false }\n' })
    roots.push(r)
    const d = await startDev(r)   // the suite's env, as every test's children get it
    try {
      const mine = join(process.env.MARVER_HOME!, 'running')
      const file = readdirSync(mine).find((f) => { try { return JSON.parse(readFileSync(join(mine, f), 'utf8')).pid === d.proc.pid } catch { return false } })
      expect(file).toMatch(/^slot-\d+\.json$/)
      expect(d.port).toBeGreaterThan(Number(process.env.MARVER_SLOT_BASE))
      expect(d.port).toBeLessThanOrEqual(Number(process.env.MARVER_SLOT_BASE) + 20)
      expect(pidsIn(real)).not.toContain(d.proc.pid)
      const listed = await new Promise<string>((resolve) => execFile(process.execPath, [CLI, 'ls', '--json'], { env: process.env }, (_e, out) => resolve(out)))
      expect(JSON.parse(listed).canvases.some((c: { pid: number; port: number }) => c.pid === d.proc.pid && c.port === d.port)).toBe(true)
      await d.stop()
      expect(readdirSync(mine).some((f) => { try { return JSON.parse(readFileSync(join(mine, f), 'utf8')).pid === d.proc.pid } catch { return false } })).toBe(false)
    } finally { await d.stop('SIGKILL') }
  }, 120_000)
})
