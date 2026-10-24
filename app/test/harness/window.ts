/**
 * The window stream's cases (spec 28 A2.10): the app on a test profile with the fake trust standing in for the
 * trust stream's modules (src/main/testing/fake-trust.ts), and fake canvases (fake-canvas.ts) handed to it as
 * registry entries. Each case reads main's own record (`state`), the views as Electron reports them (`views`),
 * and the journal (`log`).
 */
import { launchPW, launchProd, type AppRun } from './app.ts'
import { runSlotBase, testEnv, type TestEnv } from './env.ts'
import { startFakeCanvas, type FakeCanvas, type FakeOptions } from './fake-canvas.ts'

export interface TabDump {
  id: string; kind: string; name: string; open: boolean; view: string; retained: boolean; path: string; state: string
  reg: { state: string; instance: string; origin: string | null; port: number; slot: number | null; ws?: string } | null
  doc: { gen: number; url: string; trusted: boolean; doc?: string; commits: number; shown: boolean; lifted?: boolean } | null
  reports: { safety: string; busy?: { busy: boolean; unsaved: boolean; why: string[] } }
  crash: { count: number; latched: boolean; inFlight?: string | false; pendingShow?: boolean }
  fail: { why: string; at: number; code?: number } | null
  hung: boolean; held: { at: number; action: string } | null; replacing: boolean; key?: number
  hasView: boolean; wcId: number | null; pageView: boolean; logo: string | null
  /** A3's unloading (A3.8 #39-#45) */
  unload?: { phase: 'closing' | 'unsure' | 'unloaded' | 'reopening'; reason: string; at: number; commit: number; origin: string; unloadedAt?: number; activatedAt?: number } | null
  unloadRefused?: number | null; hiddenAt?: number | null; audible?: boolean; devtools?: boolean; loading?: boolean
}
export interface State { active: string; tabs: TabDump[]; order: string[]; canvases: string[]; pill: { rev: number; kind: string; short: string; tab?: string } | null; focus: unknown; quitting: boolean }
export interface LogLine { topic: string; turn: number; t: string; data: Record<string, unknown> }
export interface ViewNow { key: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }

export interface WindowRun {
  run: AppRun
  env: TestEnv
  slotBase: number
  state(): Promise<State>
  tab(id: string): Promise<TabDump>
  views(): Promise<ViewNow[]>
  log(topic?: string, since?: number): Promise<LogLine[]>
  /** a fake canvas, running and registered with the app; its tab id */
  canvas(o?: Partial<FakeOptions>): Promise<{ fake: FakeCanvas; id: string }>
  /** wait until `pred(state)` holds (polling main's record) */
  until(pred: (s: State) => boolean, ms?: number, what?: string): Promise<State>
  /** the canvas's page reported this (as the bridge would hand it on) */
  report(id: string, busy: { unsaved: boolean; why?: string[] } | null, extra?: Record<string, unknown>): Promise<void>
  /** quits the app; `keep` leaves the home and the fake canvases for a second launch */
  close(o?: { keep?: boolean }): Promise<number | null>
}

export interface Prepared { extraEnv?: Record<string, string>; fakes?: FakeCanvas[] }

export async function launchWindow(kind: 'pw' | 'prod', o: {
  extraEnv?: Record<string, string>
  /** before the app starts: canvases already running, files in its home; what it returns joins the launch */
  prepare?: (env: TestEnv, slotBase: number) => Promise<Prepared>
  /** reuse a test home (a second launch on the same profile) */
  env?: TestEnv
} = {}): Promise<WindowRun> {
  const slotBase = runSlotBase()
  const env = o.env ?? testEnv(slotBase)
  const prepared = (await o.prepare?.(env, slotBase)) ?? {}
  const extraEnv = { MARVER_APP_FAKE_TRUST: '1', ...o.extraEnv, ...prepared.extraEnv }
  const run = kind === 'pw' ? await launchPW(env, { extraEnv }) : await launchProd(env, { extraEnv })
  const fakes: FakeCanvas[] = [...(prepared.fakes ?? [])]
  const state = () => run.call<State>('state')
  const until = async (pred: (s: State) => boolean, ms = 10_000, what = 'the state') => {
    const end = Date.now() + ms
    let s = await state()
    while (!pred(s)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s).slice(0, 2000)}`)
      await new Promise((r) => setTimeout(r, 40))
      s = await state()
    }
    return s
  }
  return {
    run, env, slotBase, state, until,
    tab: async (id) => { const t = (await state()).tabs.find((x) => x.id === id); if (!t) throw new Error(`no tab ${id}`); return t },
    views: () => run.call<ViewNow[]>('views'),
    log: async (topic, since = 0) => (await run.call<LogLine[]>('log', { since })).filter((l) => !topic || l.topic === topic),
    async canvas(opts = {}) {
      const fake = await startFakeCanvas({ home: env.home, slotBase, ...opts })
      fakes.push(fake)
      await fake.ready
      const rec = fake.record()
      await run.call('fake:entry', { ...rec, file: fake.slotFile })
      const s = await until((x) => x.tabs.some((t) => t.reg?.instance === fake.instance), 5000, 'the canvas tab')
      return { fake, id: s.tabs.find((t) => t.reg?.instance === fake.instance)!.id }
    },
    async report(id, busy, extra = {}) {
      const why = busy ? (busy.why ?? (busy.unsaved ? ['board-unsaved'] : [])) : undefined
      await run.call('fake:report', { tab: id, ...(busy ? { busy: { busy: why!.length > 0, unsaved: busy.unsaved, why } } : {}), ...extra })
    },
    async close(o2: { keep?: boolean } = {}) {
      try { await run.call('sheet', { mode: 'confirm' }) } catch { /* gone already */ }
      const code = await run.close()
      if (o2.keep) return code
      for (const f of fakes) await f.close().catch(() => {})
      env.cleanup()
      return code
    },
  }
}

/** A page script: answers every beforeunload with a refusal (until `window.__mayLeave`), and tells the server each time. */
export const REFUSE_UNLOAD = `addEventListener('beforeunload', function (e) { if (window.__mayLeave) return; try { navigator.sendBeacon('/__mv/test/beforeunload') } catch (x) {} e.preventDefault(); e.returnValue = '' }); say('script');`
/** Let every refusing page go, so the case's last quit can go through. */
export const MAY_LEAVE = 'window.__mayLeave = true; 1'
/** A page script: swallows every key, telling the server which. */
export const SWALLOW_KEYS = `addEventListener('keydown', function (e) { e.preventDefault(); e.stopImmediatePropagation(); try { navigator.sendBeacon('/__mv/test/key-' + encodeURIComponent(e.key)) } catch (x) {} }, true);`

export const hits = (f: FakeCanvas, path: string) => f.requests.filter((r) => r.path === path).length

/**
 * The fake page's own script has run (a page script that ends with `say('script')` - REFUSE_UNLOAD does - reports
 * it; `n` documents so far). A commit comes before the document's scripts: a case that needs its listeners waits.
 * (Not the first animation frame: an occluded window's page gets none outside Playwright's switches.)
 */
export async function scripted(f: FakeCanvas, n = 1, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (hits(f, '/__mv/test/script') < n) {
    if (Date.now() > end) throw new Error(`the fake page's script never reported (${hits(f, '/__mv/test/script')} of ${n})`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
