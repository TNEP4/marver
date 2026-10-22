import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RECLAIM_STUCK, pidRuns, releaseDevLock, takeDevLock } from '../src/server/dev-lock.ts'
import { readDevInfo, removeDevInfo, writeDevInfo } from '../src/server/work.ts'
import { acquireLock, releaseLock } from '../src/server/jam/journal.ts'

const LOCK_MODULE = resolve('src/server/dev-lock.ts')
const roots: string[] = []
const children: ChildProcess[] = []
const servers: Server[] = []
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGCONT'); c.kill('SIGKILL') } catch { /* gone */ } }
  for (const s of servers.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'sh-devlock-'))
  roots.push(root)
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  return root
}
const local = (root: string, f: string) => join(root, 'design', '.local', f)

/** A process that is alive until killed. */
const sleeper = (): ChildProcess => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(c)
  return c
}
/** The pid of a process that has already exited. */
const deadPid = async (): Promise<number> => {
  const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((r) => c.once('exit', r))
  return c.pid!
}

/** A separate `marver dev`-style starter: takes the lock in its own process, prints the result, and
 *  holds it until killed - so "alive" and "dead" are real processes, not fakes. */
const starter = (root: string): Promise<{ ok: boolean; message?: string; child: ChildProcess }> => new Promise((res, rej) => {
  const src = `const m = await import(${JSON.stringify(LOCK_MODULE)});
const r = await m.takeDevLock(${JSON.stringify(root)}, { reclaimWaitMs: 200 });
process.stdout.write(JSON.stringify({ ok: r.ok, message: r.ok ? undefined : r.message }) + '\\n');
if (r.ok) setInterval(() => {}, 1000); else process.exit(0)`
  const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(c)
  let out = ''
  c.stdout!.on('data', (d) => {
    out += d
    const line = out.split('\n')[0]
    if (out.includes('\n')) res({ ...JSON.parse(line), child: c })
  })
  c.once('error', rej)
})

describe('dev.lock: one canvas per folder (#19)', () => {
  it('takes a free folder and releases only its own lock', async () => {
    const root = fresh()
    const a = await takeDevLock(root)
    expect(a.ok).toBe(true)
    const held = JSON.parse(readFileSync(local(root, 'dev.lock'), 'utf8'))
    expect(held.pid).toBe(process.pid)
    releaseDevLock(root, 'someone-else')
    expect(existsSync(local(root, 'dev.lock'))).toBe(true)
    if (a.ok) a.release()
    expect(existsSync(local(root, 'dev.lock'))).toBe(false)
  })

  it('two starters at once: exactly one runs, the other says where', async () => {
    const root = fresh()
    const results = await Promise.all([starter(root), starter(root), starter(root)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    for (const r of results.filter((r) => !r.ok)) expect(r.message).toMatch(/^a canvas already runs here/)
  }, 30_000)

  it('the refusal names the running canvas from its dev.json', async () => {
    const root = fresh()
    const first = await starter(root)
    expect(first.ok).toBe(true)
    writeFileSync(local(root, 'dev.json'), JSON.stringify({ port: 5298, token: 't', pid: first.child.pid, instance: 'x' }))
    const second = await takeDevLock(root)
    expect(second).toEqual({ ok: false, message: 'a canvas already runs here: http://localhost:5298 - open it, or stop it first' })
  }, 30_000)

  it('a dead holder is reclaimed', async () => {
    const root = fresh()
    writeFileSync(local(root, 'dev.lock'), JSON.stringify({ pid: await deadPid(), instance: 'old', at: 1 }))
    const r = await takeDevLock(root)
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(local(root, 'dev.lock'), 'utf8')).pid).toBe(process.pid)
    expect(existsSync(local(root, 'dev.lock.reclaim'))).toBe(false)
  })

  it('two starters reclaiming one dead lock: exactly one wins', async () => {
    const root = fresh()
    writeFileSync(local(root, 'dev.lock'), JSON.stringify({ pid: await deadPid(), instance: 'old', at: 1 }))
    const results = await Promise.all([starter(root), starter(root), starter(root), starter(root)])
    const winners = results.filter((r) => r.ok)
    expect(winners).toHaveLength(1)
    expect(JSON.parse(readFileSync(local(root, 'dev.lock'), 'utf8')).pid).toBe(winners[0].child.pid)
    expect(existsSync(local(root, 'dev.lock.reclaim'))).toBe(false)
  }, 30_000)

  it('a leftover reclaim lock fails closed with the line', async () => {
    const root = fresh()
    writeFileSync(local(root, 'dev.lock'), JSON.stringify({ pid: await deadPid(), instance: 'old', at: 1 }))
    writeFileSync(local(root, 'dev.lock.reclaim'), JSON.stringify({ pid: await deadPid(), instance: 'crashed', at: 1 }))
    const r = await takeDevLock(root, { reclaimWaitMs: 50 })
    expect(r).toEqual({ ok: false, message: RECLAIM_STUCK })
    expect(RECLAIM_STUCK).toBe('a canvas is starting here, or a start crashed: delete design/.local/dev.lock.reclaim if no canvas runs')
    expect(existsSync(local(root, 'dev.lock.reclaim'))).toBe(true)   // never removed by a guess
  })

  it('a holder paused with SIGSTOP is not taken over', async () => {
    const root = fresh()
    const first = await starter(root)
    expect(first.ok).toBe(true)
    first.child.kill('SIGSTOP')
    expect(pidRuns(first.child.pid)).toBe(true)
    const r = await takeDevLock(root)
    expect(r.ok).toBe(false)
    expect(JSON.parse(readFileSync(local(root, 'dev.lock'), 'utf8')).pid).toBe(first.child.pid)
  }, 30_000)

  it('a live 0.25 server (dev.json, no lock, port bound) is not taken over', async () => {
    const root = fresh()
    const srv = createServer()
    servers.push(srv)
    await new Promise<void>((r) => srv.listen(0, '::1', () => r()))
    const port = (srv.address() as { port: number }).port
    writeFileSync(local(root, 'dev.json'), JSON.stringify({ port, token: 'old', ts: 1 }))   // 0.25: no pid, no instance
    const r = await takeDevLock(root)
    expect(r).toEqual({ ok: false, message: `a canvas already runs here: http://localhost:${port} - open it, or stop it first (or delete design/.local/dev.json if it is not)` })
    expect(existsSync(local(root, 'dev.lock'))).toBe(false)   // the attempt left nothing behind
    expect(JSON.parse(readFileSync(local(root, 'dev.json'), 'utf8')).token).toBe('old')
  })

  it('a stale 0.25 dev.json (its port free) does not block', async () => {
    const root = fresh()
    const srv = createServer()
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as { port: number }).port
    await new Promise((r) => srv.close(r))
    writeFileSync(local(root, 'dev.json'), JSON.stringify({ port, token: 'old', ts: 1 }))
    expect((await takeDevLock(root)).ok).toBe(true)
  })

  it('a dev.json naming a live server stops a start even with the lock gone', async () => {
    const root = fresh()
    const live = sleeper()
    writeFileSync(local(root, 'dev.json'), JSON.stringify({ port: 5301, token: 't', pid: live.pid, instance: 'other' }))
    const r = await takeDevLock(root)
    expect(r).toEqual({ ok: false, message: 'a canvas already runs here: http://localhost:5301 - open it, or stop it first' })
  })
})

describe('dev.json names its server', () => {
  it('the survivor\'s dev.json is untouched when the other exits', () => {
    const root = fresh()
    writeDevInfo(root, 5300, 'survivor')
    const before = readFileSync(local(root, 'dev.json'), 'utf8')
    removeDevInfo(root, 'the-one-that-was-refused')
    expect(readFileSync(local(root, 'dev.json'), 'utf8')).toBe(before)
    removeDevInfo(root, 'survivor')
    expect(existsSync(local(root, 'dev.json'))).toBe(false)
  })

  it('carries pid and instance; readDevInfo ignores a file whose pid is not running', async () => {
    const root = fresh()
    const token = writeDevInfo(root, 5300, 'me')
    const v = JSON.parse(readFileSync(local(root, 'dev.json'), 'utf8'))
    expect(v).toMatchObject({ port: 5300, token, pid: process.pid, instance: 'me' })
    expect(readDevInfo(root)).toEqual({ port: 5300, token, pid: process.pid })
    writeFileSync(local(root, 'dev.json'), JSON.stringify({ ...v, pid: await deadPid() }))
    expect(readDevInfo(root)).toBe(null)
  })

  it('a 0.25 file (no pid) is still read', () => {
    const root = fresh()
    writeFileSync(local(root, 'dev.json'), JSON.stringify({ port: 5300, token: 'tok', ts: 1 }))
    expect(readDevInfo(root)).toEqual({ port: 5300, token: 'tok' })
  })
})

describe('jam.lock: the same reclaim step', () => {
  it('a dead holder is reclaimed; a live one blocks', async () => {
    const root = fresh()
    const file = local(root, 'jam.lock')
    writeFileSync(file, String(sleeper().pid))
    expect(acquireLock(root)).toBe(false)
    writeFileSync(file, String(await deadPid()))
    expect(acquireLock(root)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid))
    expect(existsSync(`${file}.reclaim`)).toBe(false)
    releaseLock(root)
    expect(existsSync(file)).toBe(false)
  })

  it('another start mid-reclaim (or a crashed one) leaves the loop to it', async () => {
    const root = fresh()
    const file = local(root, 'jam.lock')
    writeFileSync(file, String(await deadPid()))
    writeFileSync(`${file}.reclaim`, '1')
    expect(acquireLock(root)).toBe(false)
    expect(existsSync(`${file}.reclaim`)).toBe(true)
  })
})
