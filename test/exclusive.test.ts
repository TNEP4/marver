import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pidRuns, releaseExclusive, takeExclusive } from '../src/server/exclusive.ts'

/**
 * The one-holder-per-file helper dev.lock and the slot files share (spec 28 A1.2): dev-lock's own
 * scenarios, against the bare helper on a plain file - real processes for "alive" and "dead", never
 * fakes. dev-lock.test.ts stays as it was, as the proof that dev.lock behaves exactly as before.
 */

const MODULE = resolve('src/server/exclusive.ts')
const dirs: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGCONT'); c.kill('SIGKILL') } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mv-excl-'))
  dirs.push(dir)
  return join(dir, 'slot-1.json')
}
const me = (instance = 'mine') => ({ pid: process.pid, instance, at: Date.now() })

const deadPid = async (): Promise<number> => {
  const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((r) => c.once('exit', r))
  return c.pid!
}

/** A separate starter: takes the file in its own process, prints the result, holds it until killed. */
const starter = (file: string, body: Record<string, unknown> = {}): Promise<{ ok: boolean; why?: string; child: ChildProcess }> => new Promise((res, rej) => {
  const src = `const m = await import(${JSON.stringify(MODULE)});
const me = { pid: process.pid, instance: 'c' + process.pid, at: Date.now() };
const r = await m.takeExclusive(${JSON.stringify(file)}, me, JSON.stringify({ ...${JSON.stringify(body)}, ...me }), { reclaimWaitMs: 200 });
process.stdout.write(JSON.stringify({ ok: r.ok, why: r.ok ? undefined : r.why }) + '\\n');
if (r.ok) setInterval(() => {}, 1000); else process.exit(0)`
  const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(c)
  let out = ''
  c.stdout!.on('data', (d) => {
    out += d
    if (out.includes('\n')) res({ ...JSON.parse(out.split('\n')[0]), child: c })
  })
  c.once('error', rej)
})

describe('exclusive files: one holder per file (A1.2)', () => {
  it('takes a free file and releases only its own', async () => {
    const file = fresh()
    const r = await takeExclusive(file, me(), JSON.stringify(me()))
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(process.pid)
    releaseExclusive(file, 'someone-else')
    expect(existsSync(file)).toBe(true)
    if (r.ok) r.release()
    expect(existsSync(file)).toBe(false)
  })

  it('three starters at once: exactly one holds it, the others are told it is held', async () => {
    const file = fresh()
    const results = await Promise.all([starter(file), starter(file), starter(file)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    for (const r of results.filter((r) => !r.ok)) expect(r.why).toBe('held')
  }, 30_000)

  it('a dead holder is reclaimed, and no .reclaim is left', async () => {
    const file = fresh()
    writeFileSync(file, JSON.stringify({ pid: await deadPid(), instance: 'old', at: 1 }))
    const r = await takeExclusive(file, me(), JSON.stringify(me()))
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).instance).toBe('mine')
    expect(existsSync(`${file}.reclaim`)).toBe(false)
  })

  it('four starters reclaiming one dead holder: exactly one wins', async () => {
    const file = fresh()
    writeFileSync(file, JSON.stringify({ pid: await deadPid(), instance: 'old', at: 1 }))
    const results = await Promise.all([starter(file), starter(file), starter(file), starter(file)])
    const winners = results.filter((r) => r.ok)
    expect(winners).toHaveLength(1)
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(winners[0].child.pid)
    expect(existsSync(`${file}.reclaim`)).toBe(false)
  }, 30_000)

  it('a leftover .reclaim is stuck after the wait, and is never removed by a guess', async () => {
    const file = fresh()
    writeFileSync(file, JSON.stringify({ pid: await deadPid(), instance: 'old', at: 1 }))
    writeFileSync(`${file}.reclaim`, JSON.stringify({ pid: await deadPid(), instance: 'crashed', at: 1 }))
    const t0 = Date.now()
    expect(await takeExclusive(file, me(), JSON.stringify(me()), { reclaimWaitMs: 50 })).toEqual({ ok: false, why: 'stuck' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
    expect(existsSync(`${file}.reclaim`)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).instance).toBe('old')
  })

  it('a holder paused with SIGSTOP is held, never taken over', async () => {
    const file = fresh()
    const first = await starter(file)
    expect(first.ok).toBe(true)
    first.child.kill('SIGSTOP')
    expect(pidRuns(first.child.pid)).toBe(true)
    const r = await takeExclusive(file, me(), JSON.stringify(me()))
    expect(r).toMatchObject({ ok: false, why: 'held', holder: { pid: first.child.pid } })
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(first.child.pid)
  }, 30_000)

  it('a file that names no holder is unreadable, and left as it is', async () => {
    const file = fresh()
    for (const junk of ['{"pid":', '{"pid":"12","instance":"x"}', '[]']) {
      writeFileSync(file, junk)
      expect(await takeExclusive(file, me(), JSON.stringify(me()))).toEqual({ ok: false, why: 'unreadable' })
      expect(readFileSync(file, 'utf8')).toBe(junk)
    }
  })

  it('a slot-shaped body (extra fields) reads as its holder', async () => {
    const file = fresh()
    const first = await starter(file, { v: 1, state: 'starting', slot: 1, port: 48805, key: 'k'.repeat(43) })
    expect(first.ok).toBe(true)
    const r = await takeExclusive(file, me(), JSON.stringify(me()))
    expect(r).toMatchObject({ ok: false, why: 'held', holder: { pid: first.child.pid, instance: `c${first.child.pid}` } })
  }, 30_000)

  it('the .reclaim names the claimant only - never the body it is writing (a slot\'s key)', async () => {
    const file = fresh()
    writeFileSync(file, JSON.stringify({ pid: await deadPid(), instance: 'old', at: 1 }))
    // a child that records each .reclaim's content as it is removed (the reclaim window, observed)
    const src = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const seen = []; const unlink = fs.unlinkSync;
fs.unlinkSync = (p) => { if (String(p).endsWith('.reclaim')) seen.push(fs.readFileSync(p, 'utf8')); return unlink(p) };
syncBuiltinESMExports();
const m = await import(${JSON.stringify(MODULE)});
const me = { pid: process.pid, instance: 'claimant', at: 1 };
const r = await m.takeExclusive(${JSON.stringify(file)}, me, JSON.stringify({ ...me, key: 'SECRET-KEY' }));
process.stdout.write(JSON.stringify({ ok: r.ok, seen }))`
    const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] })
    children.push(c)
    let out = ''
    c.stdout!.on('data', (d) => { out += d })
    await new Promise((r) => c.once('exit', r))
    const { ok, seen } = JSON.parse(out)
    expect(ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0])).toEqual({ pid: c.pid, instance: 'claimant', at: 1 })
    expect(seen[0]).not.toContain('SECRET-KEY')
    expect(readFileSync(file, 'utf8')).toContain('SECRET-KEY')
  }, 30_000)
})
