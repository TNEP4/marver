/**
 * Fake ports for the window stream's pure modules (tabs.ts, tabpage.ts, pill.ts): every effect recorded, the
 * guard's act and sheet answered by the case. No Electron.
 */
import type { RegistryEntry } from '../../src/main/registry.ts'
import { resetTabs, setTabsPorts, onRegistry, allTabs, onCommit, onReport, activate, isActive, savedPathIn, startReopen, tabIdent, type GuardAction, type GuardAnswer, type Sheet, type Tab, type TabsFile } from '../../src/main/tabs.ts'
import { scheduleRetry, setTabpagePorts } from '../../src/main/tabpage.ts'
import { recompute, resetPill, setPillPorts } from '../../src/main/pill.ts'
import type { PillView } from '../../src/shared/channels.ts'
import type { AppState } from '../../../src/shared/app-api.ts'

export interface Deferred<T> { promise: Promise<T>; resolve(v: T): void }
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

export interface World {
  clock: { now: number }
  acts: { tab: string; action: GuardAction }[]
  sheets: Sheet[]
  loads: string[]
  reloads: string[]
  states: { tab: string; s: AppState }[]
  forgets: string[]
  pills: (PillView | null)[]
  copies: string[]
  confirmed: string[]
  probes: string[]
  /** forward(): the window shown and brought to the front */
  forwards: number
  /** shown(): the tab was shown (its pending crash reload starts) */
  shown: string[]
  /** tabs.json as read at launch, with restoreTabs on (null: off, or no file) */
  saved: TabsFile | null
  /** the recorder's records (TabsPorts.record): kind, the tab named, the body */
  records: { kind: string; tab: string; who: unknown; body: Record<string, unknown> }[]
  /** journal lines (TabsPorts.log) */
  logs: { topic: string; data: Record<string, unknown> }[]
  /** load(): the tabs whose load was the reopen of an unloaded tab (views.ts arms reopenNext then) */
  reopens: string[]
  /** how the next act answers: a value, or a deferred the case resolves */
  actWith: (t: Tab, a: GuardAction) => Promise<GuardAnswer> | GuardAnswer
  askWith: (s: Sheet) => Promise<boolean> | boolean
  probeWith: (t: Tab) => Promise<'silent' | 'answers' | 'proved'> | 'silent' | 'answers' | 'proved'
  visible: boolean
}

export function world(): World {
  const w: World = {
    clock: { now: 1_000_000 }, acts: [], sheets: [], loads: [], reloads: [], states: [], forgets: [], pills: [], copies: [], confirmed: [], probes: [],
    forwards: 0, shown: [], saved: null, records: [], logs: [], reopens: [],
    actWith: () => 'done', askWith: () => false, probeWith: () => 'silent', visible: true,
  }
  resetTabs()
  resetPill()
  setTabsPorts({
    now: () => w.clock.now, home: '/Users/nic', appDark: () => false,
    // as views.ts's load(): an unloaded tab's load is its reopen (A3.8 #43)
    changed: () => recompute(), load: (t) => { w.loads.push(t.id); if (startReopen(t)) w.reopens.push(t.id) }, appState: (t, s) => { w.states.push({ tab: t.id, s }) },
    act: async (t, a) => { w.acts.push({ tab: t.id, action: a }); return w.actWith(t, a) },
    ask: async (s) => { w.sheets.push(s); return w.askWith(s) },
    forget: (t) => { w.forgets.push(t.id) }, save: () => {}, shown: (t) => { w.shown.push(t.id) },
    // as views.ts installs it: the failed tab's look, at once
    recheck: (t) => scheduleRetry(t, { now: true }),
    forward: () => { w.forwards += 1 }, savedPath: (ws, origin) => savedPathIn(w.saved, ws, origin),
    log: (topic, data) => { w.logs.push({ topic, data: data as Record<string, unknown> }) },
    record: (kind, who, body) => { w.records.push({ kind, tab: 'id' in who ? who.id : who.tab, who: 'id' in who ? tabIdent(who) : { ...who }, body: { ...(body as object) } }) },
  })
  setTabpagePorts({
    now: () => w.clock.now, isActive,
    reload: (t) => { w.reloads.push(t.id) }, confirmed: (t) => { w.confirmed.push(t.id) },
    probe: async (t) => { w.probes.push(t.id); return w.probeWith(t) }, load: (t) => { w.loads.push(t.id) }, changed: () => {},
  })
  setPillPorts({
    now: () => w.clock.now, home: '/Users/nic', visible: () => w.visible, send: (v) => { w.pills.push(v) },
    copyStart: (t) => { w.copies.push(t.id) }, notResponding: () => {},
  })
  return w
}

/** activate() through the model */
export function show(id: string): void { activate(id) }

let n = 0
export function entry(o: Partial<RegistryEntry> = {}): RegistryEntry {
  n += 1
  const port = o.port ?? 40100 + n
  return {
    file: `/home/running/slot-${n}.json`, key: Buffer.alloc(32), state: 'ready', pid: 1000 + n, instance: `inst-${n}`,
    slot: n, port, origin: `http://[::1]:${port}`, url: `http://localhost:${port}/`, root: `/Users/nic/repo-${n}`, name: `Canvas ${n}`,
    version: '0.27.1', features: ['bridge'], ws: (n.toString(16).padStart(2, '0')).repeat(8).slice(0, 16), startedAt: 1, ...o,
  }
}

/** A canvas tab from a registry entry, shown, with a trusted document admitted and (optionally) its first report. */
export function liveTab(w: World, o: { entry?: Partial<RegistryEntry>; busy?: { unsaved: boolean; why?: string[] } | null; show?: boolean } = {}): Tab {
  const e = entry(o.entry)
  onRegistry({ kind: 'entry', entry: e })
  const t = allTabs().find((x) => x.reg?.instance === e.instance)!
  if (o.show !== false) show(t.id)
  t.view = 'live'
  onCommit(t, { gen: 1, url: `${e.origin}/#/b/main`, attributed: true, admitted: `doc-${t.id}-1` })
  if (o.busy !== null) {
    const busy = o.busy ?? { unsaved: false }
    const why = (busy.why ?? (busy.unsaved ? ['board-unsaved'] : [])) as never[]
    onReport(t.id, t.doc!.doc!, { busy: { busy: why.length > 0, unsaved: busy.unsaved, why } })
  }
  w.loads.length = 0
  return t
}

/** A report from the tab's admitted document. */
export function report(t: Tab, unsaved: boolean, why?: string[]): void {
  const ws = (why ?? (unsaved ? ['board-unsaved'] : [])) as never[]
  onReport(t.id, t.doc!.doc!, { busy: { busy: ws.length > 0, unsaved, why: ws } })
}

export const flush = () => new Promise((r) => setImmediate(r))
