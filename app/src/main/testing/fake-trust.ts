/**
 * A stand-in for the trust stream, for the window stream's own cases (dev builds, `MARVER_APP_TEST=1` and
 * `MARVER_APP_FAKE_TRUST=1`): the registry, the navigation adapter, the admission and the canvas reports, driven by
 * test hooks, so the window lifecycle - the guard against Chromium's real beforeunload, crashes, keys, focus,
 * fullscreen, the quit, the hang - runs against real webContents before the trust stream's modules land. It
 * proves nothing: a commit on the tab's own bound origin counts as attributed unless a case says otherwise.
 *
 * `MARVER_APP_FAKE_ENTRIES` (a JSON array of slot records) are the canvases running at launch.
 * Hooks: `fake:entry` (a registry entry, starting or ready), `fake:gone`, `fake:mode` (a tab's next commits:
 * `prove`, `unattributed`, `unverified` - a failure as the proof's cancel would make it), `fake:report` (a canvas
 * report from the admitted document, as the bridge would hand it on), `fake:admits`.
 */
import { randomBytes } from 'node:crypto'
import { session, type WebContents } from 'electron'
import type { CanvasReports } from '../bridge.ts'
import type { FailWhy, NavAdapter, NavEvent } from '../nav.ts'
import type { RegistryEntry, RegistryEvent } from '../registry.ts'
import { localPartition } from '../sessions.ts'
import { getTab, type Tab } from '../tabs.ts'
import type { TrustPort } from '../views.ts'
import { note, provide } from './index.ts'

type Mode = 'prove' | 'unattributed' | 'unverified'

export function fakeTrust(): TrustPort {
  const entries = new Map<string, RegistryEntry>()
  const regFns = new Set<(e: RegistryEvent) => void>()
  const reportFns = new Set<(tabId: string, doc: string, r: CanvasReports) => void>()
  const modes = new Map<string, Mode>()
  const admits: { tab: string; doc: string }[] = []
  const emit = (e: RegistryEvent) => { for (const f of regFns) f(e) }
  // the canvases already running at launch (restore's cases): MARVER_APP_FAKE_ENTRIES, a JSON array of slot records
  try {
    for (const r of JSON.parse(process.env.MARVER_APP_FAKE_ENTRIES ?? '[]') as RegistryEntry[]) entries.set(r.instance, { ...r, key: Buffer.alloc(32), features: r.features ?? ['bridge'] })
  } catch { /* none */ }

  const noHash = (u: string) => { try { const x = new URL(u); x.hash = ''; return x.toString() } catch { return u } }

  function attach(wc: WebContents, tab: Tab): NavAdapter {
    let gen = 0
    let committed = 0
    const fns = new Set<(e: NavEvent) => void>()
    const fire = (e: NavEvent) => { note('fake-nav', { tab: tab.id, ...e }); for (const f of fns) f(e) }
    const onStart = (d: { isMainFrame: boolean; isSameDocument: boolean; url: string }) => {
      if (!d.isMainFrame || d.isSameDocument) return
      gen += 1
      fire({ kind: 'start', gen, url: noHash(d.url) })
    }
    const onNavigate = (_e: unknown, url: string) => {
      const mode = modes.get(tab.id) ?? 'prove'
      let origin = ''
      try { origin = new URL(url).origin } catch { /* not a URL */ }
      const own = !!tab.reg?.origin && origin === tab.reg.origin
      committed = gen
      fire({ kind: 'commit', gen, url, attributed: own && mode === 'prove', instance: tab.reg?.instance })
    }
    const onFail = (_e: unknown, code: number, _d: string, url: string, isMain: boolean) => {
      if (!isMain || code === -3) return
      const mode = modes.get(tab.id) ?? 'prove'
      const why: FailWhy = mode === 'unverified' || code === -20 ? 'unverified' : tab.reg?.state === 'gone' ? 'gone' : 'unreachable'
      fire({ kind: 'fail', gen, url: noHash(url), why, code })
    }
    const onAbort = (_e: unknown, code: number, _d: string, _u: string, isMain: boolean) => { if (isMain && code === -3 && committed !== gen) fire({ kind: 'abort', gen }) }
    wc.on('did-start-navigation', onStart)
    wc.on('did-navigate', onNavigate)
    wc.on('did-fail-load', onFail)
    wc.on('did-fail-provisional-load', onAbort)
    let seen = 0
    wc.on('did-navigate', () => { seen += 1 })
    wc.on('did-fail-load', (_e, code, _d, _u, isMain) => { if (isMain && code !== -3) seen += 1 })
    wc.on('render-process-gone', () => { seen += 1 })
    // the trust stream's adapter also answers committed(), frame() and commits() (a2-trust): the fake does too
    return {
      gen: () => gen,
      attempt: () => undefined,
      stamp: () => gen || null,
      response: () => {},
      committed: () => undefined,
      frame: () => undefined,
      commits: () => seen,
      on(fn: (e: NavEvent) => void) { fns.add(fn); return () => { fns.delete(fn) } },
      dispose() {
        fns.clear()
        if (wc.isDestroyed()) return
        wc.off('did-start-navigation', onStart); wc.off('did-navigate', onNavigate)
        wc.off('did-fail-load', onFail); wc.off('did-fail-provisional-load', onAbort)
      },
    } as NavAdapter
  }

  provide('fake:entry', (a) => {
    const e = a as RegistryEntry & { key?: unknown }
    const entry: RegistryEntry = { ...e, key: Buffer.alloc(32), features: e.features ?? ['bridge'] }
    entries.set(entry.instance, entry)
    emit({ kind: 'entry', entry })
    return true
  })
  provide('fake:gone', (a) => {
    const { instance, why } = a as { instance: string; why?: 'pid' | 'removed' | 'closing' }
    const e = entries.get(instance)
    entries.delete(instance)
    emit({ kind: 'gone', file: e?.file ?? '', instance, why: why ?? 'pid' })
    return true
  })
  provide('fake:mode', (a) => { const { tab, mode } = a as { tab: string; mode: Mode }; modes.set(tab, mode); return true })
  provide('fake:report', (a) => {
    const { tab, doc, ...r } = a as { tab: string; doc?: string } & CanvasReports
    const t = getTab(tab)
    const d = doc ?? t?.doc?.doc ?? ''
    for (const f of reportFns) f(tab, d, r)
    return true
  })
  provide('fake:admits', () => admits)
  // the logo (A2.4): off until a case turns it on (MARVER_APP_FAKE_LOGO=1 from launch); each fetch answers after
  // `delayMs`, or rejects when its signal aborts
  const logo = { on: process.env.MARVER_APP_FAKE_LOGO === '1', delayMs: 0, url: 'data:image/svg+xml;base64,PHN2Zy8+', started: 0, aborted: 0, answered: 0, inFlight: 0, maxInFlight: 0 }
  provide('fake:logo', (a) => { Object.assign(logo, a ?? {}); return { ...logo } })
  const fetchLogo = (t: Tab, signal: AbortSignal): Promise<string | null> => new Promise((ok, fail) => {
    logo.started += 1
    logo.inFlight += 1
    logo.maxInFlight = Math.max(logo.maxInFlight, logo.inFlight)
    note('fake-trust', { logo: 'start', tab: t.id })
    const end = () => { logo.inFlight -= 1; signal.removeEventListener('abort', onAbort) }
    const x = setTimeout(() => { end(); logo.answered += 1; ok(logo.url) }, logo.delayMs)
    const onAbort = () => { clearTimeout(x); end(); logo.aborted += 1; fail(new Error('aborted')) }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })

  return {
    async session(ws) { return session.fromPartition(localPartition(ws)) },
    attach,
    admit(tabId) { const doc = randomBytes(16).toString('base64url'); admits.push({ tab: tabId, doc }); return doc },
    register() { /* the bridge's capability map: nothing to check here */ },
    entries: () => [...entries.values()],
    entryFor: (t) => (t.reg ? entries.get(t.reg.instance) : undefined),
    onRegistry(fn) { regFns.add(fn); return () => regFns.delete(fn) },
    onReport(fn) { reportFns.add(fn); return () => reportFns.delete(fn) },
    appState(tabId, s) { note('fake-trust', { appState: s, tab: tabId }); return true },
    menuClick(tabId, id) { note('fake-trust', { menuClick: id, tab: tabId }); return true },
    reopenNext(tabId) { note('fake-trust', { reopenNext: tabId }) },
    fetchLogo(t, signal) { return logo.on ? fetchLogo(t, signal) : Promise.resolve(null) },
  }
}
