/**
 * The test hooks (spec 28 A2.14 #27): compiled into the dev flavour, switched on only by `MARVER_APP_TEST=1`,
 * absent from the release build. Every call site is written `if (__MV_TEST__) ...`, so the release flavour's
 * tree-shaking drops this whole folder; the packaged smoke greps the bundle for SENTINEL and fails on a hit.
 *
 * Each area registers what its cases need with `provide(name, fn)`; tests reach them two ways, one client
 * (app/test/harness/control.ts) for both:
 * - Playwright: `electronApp.evaluate((_, [n, a]) => globalThis.__mvTest.call(n, a), [n, a])`;
 * - the production-switch harness: the control socket at `MARVER_APP_CONTROL` (control.ts).
 *
 * `note(topic, data)` keeps a bounded journal the `log` hook returns: the view journal (every setBounds,
 * setVisible, add and remove, stamped with its turn), crashes, pills - whatever a case reads for "in the
 * same turn" or "within 1 s".
 */
import { app } from 'electron'
import { serveControl } from './control.ts'
import type { Geometry, Layout } from '../tabs.ts'

export const SENTINEL = 'mv-test-hook'
export type Hook = (args: unknown) => unknown

const hooks = new Map<string, Hook>()
/** where each hook was provided (its caller's stack line), and the names provided more than once with every place */
const where = new Map<string, string>()
const twice = new Map<string, string[]>()
const journal: { topic: string; turn: number; t: string; data: unknown }[] = []
let turn = 0
let turnQueued = false

/** True only in a dev build launched with MARVER_APP_TEST=1. */
export function testMode(): boolean {
  return __MV_TEST__ && !__MARVER_RELEASE__ && process.env.MARVER_APP_TEST === '1'
}

/** The caller of provide(), as its stack names it: the function and file that provided a hook. */
function caller(): string {
  const lines = (new Error().stack ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at '))
  return lines[2]?.slice(3) ?? 'unknown'
}

/**
 * Register a hook (dev builds in test mode only). A name is provided once. A second registration never replaces the
 * first: the name is kept as provided twice, and calling it then fails naming every place that provided it - so two
 * streams that both provide a name (memory's and the recorder's, say) find out at the first case that calls it,
 * which says which; every other hook and the launch itself work on (a throw in main at launch would end every case
 * of the build with Electron's error box). The `hooks` hook lists such names too, as `name (provided twice)`.
 */
export function provide(name: string, fn: Hook): void {
  if (!(__MV_TEST__ && testMode())) return
  const at = caller()
  const first = where.get(name)
  if (first !== undefined) {
    twice.set(name, [...(twice.get(name) ?? [first]), at])
    process.stderr.write(`${SENTINEL}: the hook ${name} is provided twice: ${twice.get(name)!.join('; ')}\n`)
    return
  }
  where.set(name, at)
  hooks.set(name, fn)
}

/**
 * The one ground's journal topics (spec 28 A3.8 #35-#37, #53), FROZEN: the capture harness aligns them with
 * ScreenCaptureKit's display times (each line's `t` is `process.hrtime.bigint()`, mach_absolute_time on Darwin, as
 * SCK's `displayTime` is; a control case checks the two line up). `compose` is window.ts's as built, plus the
 * cover's state and each view's layout; `layout` every `commitLayout` that changed something; `present` every ask,
 * answer and refusal of a presentation epoch; `resize` a live resize's start and end.
 */
export interface JournalTopics {
  compose: { turn: number; active: string; w: number; h: number; cover: { visible: boolean; color: string }; changes: unknown[]; resizing?: boolean; layouts?: Record<string, Layout> }
  layout: { tab: string; event: string; from: Geometry; to: Geometry }
  present: { tab: string; op: 'ask' | 'answer' | 'stale' | 'mismatch' | 'refused' | 'lost' | 'uncover'; epoch: number; doc?: string; w?: number; h?: number; gen?: number }
  resize: { live: boolean; via: 'will-resize' | 'resized' | 'quiet' }
}
/** A journal line of a frozen topic, its shape checked. */
export function noteTopic<K extends keyof JournalTopics>(topic: K, data: JournalTopics[K]): void { note(topic, data) }

/** A journal line. `turn` advances once per macrotask: lines written in one turn share it. */
export function note(topic: string, data: unknown): void {
  if (!(__MV_TEST__ && testMode())) return
  if (!turnQueued) { turnQueued = true; setImmediate(() => { turn++; turnQueued = false }) }
  journal.push({ topic, turn, t: process.hrtime.bigint().toString(), data })
  if (journal.length > 20_000) journal.splice(0, journal.length - 20_000)
}

export async function callHook(name: string, args: unknown): Promise<unknown> {
  const both = twice.get(name)
  if (both) throw new Error(`${SENTINEL}: the hook ${name} is provided twice, so neither is called: ${both.join('; ')}`)
  const h = hooks.get(name)
  if (!h) throw new Error(`${SENTINEL}: no hook named ${name}`)
  return await h(args)
}

/** Called by main.ts once the lock is held (dev builds only). The base hooks every harness relies on. */
export function startTesting(): void {
  if (!(__MV_TEST__ && testMode())) return
  provide('ping', () => ({
    pong: true,
    pid: process.pid,
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    argv: process.argv,
    switches: ['disable-hang-monitor', 'remote-debugging-port', 'inspect', 'disable-renderer-backgrounding']
      .filter((s) => app.commandLine.hasSwitch(s)),
    userData: app.getPath('userData'),
    crashDumps: app.getPath('crashDumps'),
    env: { MARVER_HOME: process.env.MARVER_HOME, MARVER_SLOT_BASE: process.env.MARVER_SLOT_BASE },
    ready: app.isReady(),
  }))
  provide('log', (a) => {
    const since = typeof (a as { since?: unknown })?.since === 'number' ? (a as { since: number }).since : 0
    return journal.slice(since)
  })
  provide('hooks', () => [...hooks.keys()].map((n) => (twice.has(n) ? `${n} (provided twice)` : n)).sort())
  provide('exit', (a) => {
    const code = typeof (a as { code?: unknown })?.code === 'number' ? (a as { code: number }).code : 0
    setImmediate(() => app.exit(code))
    return true
  })
  provide('quit', () => { setImmediate(() => app.quit()); return true })
  ;(globalThis as { __mvTest?: unknown }).__mvTest = { call: callHook }
  const sock = process.env.MARVER_APP_CONTROL
  if (sock) serveControl(sock, callHook)
}
