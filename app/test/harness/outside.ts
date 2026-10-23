/**
 * Reading the app from outside (spec 28 A3.8 #2, #47-#49): what the budgets measure, never asked of the app about
 * itself. Owner: the flash and native acceptance stream; the unloading stream's effect report reads it too.
 *
 * - `childrenOf(pid)`: `pgrep -P`, the browser's helpers;
 * - `footprintMB(pids)`: `/usr/bin/footprint -p` (Activity Monitor's Memory), one call for many pids; a pid it
 *   cannot read is missing - a memory gate is then inconclusive, never passed on RSS;
 * - `cpuTimes(pids)`: `procusage.swift` (`proc_pid_rusage`, RUSAGE_INFO_V4, mach ticks converted with
 *   `mach_timebase_info`): each process's own CPU plus its reaped children's (`ri_child_user_time` +
 *   `ri_child_system_time`), so a helper that lived wholly between two reads is counted (A3.8 r2 #1); a pid it
 *   cannot read is missing - the run is then inconclusive;
 * - `rssMB(pids)`: `ps`, reported, never gated.
 * Every spawn is `execFile` with an absolute path. Reading order errs against the app: the browser before its
 * children at the start, after them at the end.
 *
 * FROZEN signatures (A3.8 #53). Added beside them: `appProcesses` (a launch's processes with their roles, from the
 * command lines), `cpuPass` (one pass of the CPU gate in the order that errs against the app), `cpuWindow` (the
 * window's figure from two passes, canvases taken out, pure) and `crashpadOf` (the handler launchd adopted).
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { nativeTool } from './capture.ts'

const run = promisify(execFile)
/** stdout of a tool that may exit non-zero with a useful answer (pgrep: 1 for none; procusage: 3 for a missing pid) */
async function out(bin: string, args: string[], timeout = 10_000): Promise<string> {
  try { return (await run(bin, args, { timeout, maxBuffer: 32 << 20 })).stdout } catch (e) {
    const o = (e as { stdout?: string }).stdout
    if (typeof o === 'string') return o
    throw e
  }
}

/** One process as the CPU gate reads it: its own CPU and its reaped children's, seconds. */
export interface CpuRead { pid: number; startedAt: number; ownS: number; childrenS: number }

/** The helper's exit code when it cannot read: the run is inconclusive. */
export const PROCUSAGE_UNREADABLE = 3

export async function childrenOf(pid: number): Promise<number[]> {
  const o = await out('/usr/bin/pgrep', ['-P', String(pid)])
  return o.split('\n').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0)
}

export async function footprintMB(pids: readonly number[]): Promise<Map<number, number>> {
  const res = new Map<number, number>()
  if (!pids.length) return res
  const dir = mkdtempSync(join(tmpdir(), 'mvfp-'))
  const file = join(dir, 'fp.json')
  try {
    await out('/usr/bin/footprint', ['--noCategories', '-f', 'bytes', '-j', file, ...pids.flatMap((p) => ['-p', String(p)])], 30_000)
    for (const p of (JSON.parse(readFileSync(file, 'utf8')) as { processes?: { pid: number; footprint?: number; auxiliary?: { phys_footprint?: number } }[] }).processes ?? []) {
      const b = p?.auxiliary?.phys_footprint ?? p?.footprint
      if (Number.isFinite(b) && pids.includes(p.pid)) res.set(p.pid, b! / 2 ** 20)
    }
  } catch { /* nothing read: every pid missing */ } finally { rmSync(dir, { recursive: true, force: true }) }
  return res
}

export async function cpuTimes(pids: readonly number[]): Promise<Map<number, CpuRead>> {
  const res = new Map<number, CpuRead>()
  if (!pids.length) return res
  const o = await out(nativeTool('procusage'), ['read', ...pids.map(String)])
  for (const l of o.split('\n')) {
    if (!l.trim()) continue
    const r = JSON.parse(l) as CpuRead & { missing?: boolean }
    if (!r.missing) res.set(r.pid, { pid: r.pid, startedAt: r.startedAt, ownS: r.ownS, childrenS: r.childrenS })
  }
  return res
}

export async function rssMB(pids: readonly number[]): Promise<Map<number, number>> {
  const res = new Map<number, number>()
  if (!pids.length) return res
  const o = await out('/bin/ps', ['-o', 'pid=,rss=', '-p', pids.join(',')])
  for (const row of o.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(row)
    if (m) res.set(Number(m[1]), Number(m[2]) / 1024)
  }
  return res
}

// ---- a launch's processes, and the CPU gate's passes ------------------------------------------------------------

export type OutsideRole = 'browser' | 'gpu' | 'utility' | 'renderer' | 'crashpad' | 'other'
export interface OutsideProc { pid: number; role: OutsideRole; sub?: string; command: string }

/** Crashpad's handler for a launch: launchd adopts it, so it is found by its path inside the bundle (or its database). */
export async function crashpadOf(o: { bundle?: string; database?: string }): Promise<number[]> {
  const pids = new Set<number>()
  if (o.bundle) for (const p of (JSON.parse(await out(nativeTool('procusage'), ['find', o.bundle])) as { pids: number[] }).pids) pids.add(p)
  if (o.database) for (const p of (await out('/usr/bin/pgrep', ['-f', o.database])).split('\n')) if (Number(p) > 0) pids.add(Number(p))
  const procs = await commandsOf([...pids])
  return [...procs.entries()].filter(([, c]) => /crashpad/i.test(c)).map(([p]) => p)
}

async function commandsOf(pids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>()
  if (!pids.length) return m
  for (const row of (await out('/bin/ps', ['-o', 'pid=,command=', '-p', pids.join(',')])).split('\n')) {
    const x = /^\s*(\d+)\s+(.*)$/.exec(row)
    if (x) m.set(Number(x[1]), x[2]!)
  }
  return m
}

const roleOf = (cmd: string, isMain: boolean): OutsideRole => isMain ? 'browser' : /--type=gpu-process/.test(cmd) ? 'gpu'
  : /--type=utility/.test(cmd) ? 'utility' : /--type=renderer/.test(cmd) ? 'renderer' : /crashpad/i.test(cmd) ? 'crashpad' : 'other'

/** The browser, its live children and Crashpad's handler, each with its role as its command line says. */
export async function appProcesses(browser: number, o: { bundle?: string; database?: string } = {}): Promise<OutsideProc[]> {
  const kids = await childrenOf(browser)
  const handler = await crashpadOf(o)
  const cmds = await commandsOf([browser, ...kids, ...handler])
  return [browser, ...kids, ...handler.filter((p) => p !== browser && !kids.includes(p))].flatMap((pid) => {
    const command = cmds.get(pid)
    if (command === undefined) return []
    return [{ pid, role: roleOf(command, pid === browser), sub: /--utility-sub-type=(\S+)/.exec(command)?.[1], command }]
  })
}

/** One pass of the CPU gate: the browser, its live children, the handler, each read with procusage. */
export interface CpuPass { at: number; browser: CpuRead | null; children: CpuRead[]; handler: CpuRead[]; childPids: number[] }

/**
 * One pass, in the order that errs against the app (A3.8 #49): at the start the browser before its children (a
 * child reaped in between is then in neither, and counts in full at the end), at the end after them (a child reaped
 * in between counts twice). A child gone before its own read is skipped: it is then in the browser's reaped total.
 */
export async function cpuPass(browser: number, handler: readonly number[], at: 'start' | 'end'): Promise<CpuPass> {
  const pids = await childrenOf(browser)
  const readB = async () => (await cpuTimes([browser])).get(browser) ?? null
  let b: CpuRead | null = null
  if (at === 'start') b = await readB()
  const kids = await cpuTimes(pids)
  const h = await cpuTimes([...handler])
  if (at === 'end') b = await readB()
  return { at: Date.now(), browser: b, children: [...kids.values()], handler: [...h.values()], childPids: pids }
}

export interface CpuWindow {
  kind: 'measured' | 'inconclusive'
  why?: string
  /** the app's own CPU over the window, cores (canvases taken out) */
  cores: number
  seconds: number
  /** each canvas renderer alive at both ends: its Δ seconds, reported and subtracted */
  canvases: { pid: number; seconds: number }[]
  /** helpers that started or ended between the passes (an idle app should have none), reported */
  started: number[]
  ended: number[]
}

/**
 * The window's figure (A3.8 #49, r2 #1, r3 #2), pure: the app's CPU at a pass is the browser's own and reaped total,
 * plus every live child's own and reaped, plus the handler's; over the window the end's minus the start's. A process
 * alive at both ends counts its Δ, one that ended counts up to its exit (through the browser's reaped total), one
 * that lived wholly inside counts in full. `canvas(pid, startedAt)` names the canvas renderers (the recorder's
 * `sample` lines, joined by pid and a start within 1 s): each alive at both ends is subtracted; a canvas renderer
 * that starts or ends inside the window cannot be taken out of the reaped total, so the run is inconclusive. A pass
 * that could not read the browser or the handler is inconclusive, never passed.
 */
export function cpuWindow(a: CpuPass, b: CpuPass, canvas: (pid: number, startedAt: number) => boolean): CpuWindow {
  const none = (why: string): CpuWindow => ({ kind: 'inconclusive', why, cores: 0, seconds: 0, canvases: [], started: [], ended: [] })
  if (!a.browser || !b.browser) return none('the browser could not be read')
  if (a.browser.pid !== b.browser.pid || Math.abs(a.browser.startedAt - b.browser.startedAt) > 1000) return none('the browser changed')
  if (!a.handler.length || !b.handler.length) return none('Crashpad\'s handler could not be read')
  const tot = (r: CpuRead) => r.ownS + r.childrenS
  const sum = (p: CpuPass) => tot(p.browser!) + p.children.reduce((s, r) => s + tot(r), 0) + p.handler.reduce((s, r) => s + tot(r), 0)
  const key = (r: CpuRead) => `${r.pid}@${Math.round(r.startedAt / 1000)}`
  const startK = new Map(a.children.map((r) => [key(r), r]))
  const endK = new Map(b.children.map((r) => [key(r), r]))
  const canvases: { pid: number; seconds: number }[] = []
  for (const [k, r] of startK) {
    const isC = canvas(r.pid, r.startedAt)
    const e = endK.get(k)
    if (isC && !e) return none(`the canvas renderer ${r.pid} ended inside the window`)
    if (isC && e) canvases.push({ pid: r.pid, seconds: tot(e) - tot(r) })
  }
  for (const [k, r] of endK) if (!startK.has(k) && canvas(r.pid, r.startedAt)) return none(`the canvas renderer ${r.pid} started inside the window`)
  const seconds = sum(b) - sum(a) - canvases.reduce((s, c) => s + c.seconds, 0)
  const span = (b.at - a.at) / 1000
  return {
    kind: 'measured', cores: span > 0 ? seconds / span : 0, seconds, canvases,
    started: [...endK.keys()].filter((k) => !startK.has(k)).map((k) => Number(k.split('@')[0])),
    ended: [...startK.keys()].filter((k) => !endK.has(k)).map((k) => Number(k.split('@')[0])),
  }
}
