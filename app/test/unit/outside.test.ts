/**
 * Reading processes from outside (spec 28 A3.8 #47-#49, r2 #1, r3 #2), on fixture processes: the kernel's reaped
 * CPU through procusage.swift - a child that starts and is reaped wholly between two reads is counted, a child alive
 * at the start that ends inside the window is counted up to its exit - an unreadable browser is inconclusive, a
 * canvas renderer is taken out (and one that ends inside the window makes the run inconclusive); footprint and RSS
 * read for live pids, missing for gone ones. No Electron.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { childrenOf, cpuPass, cpuTimes, cpuWindow, footprintMB, rssMB } from '../harness/outside.ts'

const kids: ChildProcess[] = []
afterEach(() => { for (const k of kids.splice(0)) k.kill('SIGKILL') })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A parent that, on each stdin line, runs that line as a burn: `child <ms>` spawns and reaps a child burning ms;
 *  `hold <ms>` spawns a child that burns ms, then waits for `end` to burn ms again and exit; `end` ends it. */
const PARENT = `
const { spawn } = require('node:child_process')
const burn = (ms) => \`const e = Date.now() + \${ms}; while (Date.now() < e) {}\`
let held = null
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const [cmd, ms] = l.split(' ')
  if (cmd === 'child') spawn(process.execPath, ['-e', burn(Number(ms))], { stdio: 'ignore' }).on('exit', () => console.log('reaped'))
  if (cmd === 'hold') { held = spawn(process.execPath, ['-e', burn(Number(ms)) + "; console.log('held'); process.stdin.once('data', () => { " + burn(Number(ms)) + "; process.exit(0) })"], { stdio: ['pipe', 'inherit', 'ignore'] }); held.on('exit', () => console.log('reaped')) }
  if (cmd === 'end' && held) held.stdin.write('x\\n')
})
setInterval(() => {}, 1000)
`
function parent() {
  const p = spawn(process.execPath, ['-e', PARENT], { stdio: ['pipe', 'pipe', 'ignore'] })
  kids.push(p)
  let said = ''
  p.stdout!.on('data', (c) => { said += c })
  return { p, said: () => said, send: (l: string) => p.stdin!.write(l + '\n'), until: async (w: string, n = 1) => { const end = Date.now() + 10_000; while ((said.match(new RegExp(w, 'g'))?.length ?? 0) < n) { if (Date.now() > end) throw new Error(`no ${w}`); await sleep(20) } } }
}
function idle() { const s = spawn('/bin/sleep', ['60'], { stdio: 'ignore' }); kids.push(s); return s.pid! }

describe('the CPU gate\'s figure, from outside (A3.8 #49)', () => {
  it('a child that starts and is reaped wholly between two reads is counted (the parent\'s reaped total)', async () => {
    const f = parent()
    const handler = idle()
    await sleep(300)
    const a = await cpuPass(f.p.pid!, [handler], 'start')
    f.send('child 1000')
    await f.until('reaped')
    const b = await cpuPass(f.p.pid!, [handler], 'end')
    expect(a.childPids).toEqual([])
    expect(b.childPids).toEqual([])
    const w = cpuWindow(a, b, () => false)
    expect(w.kind).toBe('measured')
    expect(w.seconds).toBeGreaterThan(0.9)
    expect(w.seconds).toBeLessThan(1.6)
  })

  it('a child alive at the start that ends inside the window is counted up to its exit, not before the start', async () => {
    const f = parent()
    const handler = idle()
    f.send('hold 500')
    await f.until('held')
    const a = await cpuPass(f.p.pid!, [handler], 'start')
    expect(a.childPids).toHaveLength(1)
    expect(a.children[0]!.ownS).toBeGreaterThan(0.4)
    f.send('end')
    await f.until('reaped')
    const b = await cpuPass(f.p.pid!, [handler], 'end')
    const w = cpuWindow(a, b, () => false)
    expect(w.kind).toBe('measured')
    expect(w.seconds).toBeGreaterThan(0.4)
    expect(w.seconds).toBeLessThan(0.8)
    expect(w.ended).toEqual([a.childPids[0]])
  })

  it('a canvas renderer alive at both ends is taken out; one that ends inside the window makes the run inconclusive', async () => {
    const f = parent()
    const handler = idle()
    f.send('hold 300')
    await f.until('held')
    const a = await cpuPass(f.p.pid!, [handler], 'start')
    const canvasPid = a.childPids[0]!
    const isCanvas = (pid: number) => pid === canvasPid
    const mid = await cpuPass(f.p.pid!, [handler], 'end')
    expect(cpuWindow(a, mid, isCanvas)).toMatchObject({ kind: 'measured', canvases: [{ pid: canvasPid }] })
    f.send('end')
    await f.until('reaped')
    const b = await cpuPass(f.p.pid!, [handler], 'end')
    expect(cpuWindow(a, b, isCanvas)).toMatchObject({ kind: 'inconclusive', why: expect.stringContaining('ended inside the window') })
    // the same exit, not a canvas: counted against the app
    expect(cpuWindow(a, b, () => false).seconds).toBeGreaterThan(0.25)
  })

  it('a browser that cannot be read, or no handler, is inconclusive - never passed', async () => {
    const gone = spawn('/usr/bin/true'); await new Promise((r) => gone.on('exit', r))
    const a = await cpuPass(gone.pid!, [idle()], 'start')
    expect(a.browser).toBeNull()
    expect(cpuWindow(a, a, () => false)).toMatchObject({ kind: 'inconclusive', why: 'the browser could not be read' })
    const f = parent()
    const b = await cpuPass(f.p.pid!, [], 'start')
    expect(cpuWindow(b, b, () => false).kind).toBe('inconclusive')
  })
})

describe('footprint, RSS, children', () => {
  it('reads live pids and leaves gone ones out', async () => {
    const f = parent()
    f.send('hold 50')
    await f.until('held')
    const live = [process.pid, f.p.pid!]
    const fp = await footprintMB([...live, 999_999])
    expect(fp.get(process.pid)).toBeGreaterThan(5)
    expect(fp.has(999_999)).toBe(false)
    const rss = await rssMB(live)
    expect(rss.get(process.pid)).toBeGreaterThan(5)
    expect(await childrenOf(f.p.pid!)).toHaveLength(1)
    const cpu = await cpuTimes([process.pid, 999_999])
    expect(cpu.get(process.pid)!.startedAt).toBeLessThan(Date.now())
    expect(Math.abs(cpu.get(process.pid)!.startedAt - (Date.now() - process.uptime() * 1000))).toBeLessThan(2000)
    expect(cpu.has(999_999)).toBe(false)
  })
})
