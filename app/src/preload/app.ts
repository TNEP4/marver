/**
 * The app pages' preload (spec 28 "Channels and who may use them", A2.14 #19): the strip's, Home's, Settings' and
 * the tab page's channel, as `window.marverPage`. Owner: the pages stream (the bridge in main checks every call).
 *
 * Sandboxed, one bundle of its own, `require('electron')` only (test/unit/bundle.test.ts). At document start it
 * reads which page it serves from its own URL (`marver-app://<kind>/`) and exposes that kind's named methods alone
 * (`StripApi`, `HomeApi`, `SettingsApi`, `TabPageApi` in src/shared/channels.ts) - never a generic send, and nothing
 * at all on any other document. Main-to-page channels are subscribed here, before the page's script runs: each
 * keeps its latest value, a subscriber gets it at once, and a snapshot carrying a `rev` no newer than the last
 * one is dropped. Subscribers get the payload alone, never Electron's event. `ready()` says `app:ready` once.
 * Whether a channel is an invoke or a send is `INVOKES`'s (src/shared/channels.ts), never this file's own choice.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { CH, isInvoke, RECEIVES, type HomeAction, type HomeActionAnswer, type HomeApi, type InvokeChannel, type LinkOpenAnswer, type PageApi, type PageKind, type PillAction, type SettingsApi, type SettingsSet, type SettingsSetResult, type SettingsView, type StripApi, type TabPageAction, type TabPageApi, type TabsMore, type WindowView } from '../shared/channels.ts'

type AppKind = Exclude<PageKind, 'canvas'>
const KINDS: readonly AppKind[] = ['strip', 'home', 'settings', 'tabpage']

const kind: AppKind | null = location.protocol === 'marver-app:' && (KINDS as readonly string[]).includes(location.host)
  ? location.host as AppKind : null

type Fn = (v: unknown) => void
const held = new Map<string, unknown>()
const revs = new Map<string, number>()
const subs = new Map<string, Set<Fn>>()

const revOf = (v: unknown): number | undefined =>
  v && typeof v === 'object' && typeof (v as { rev?: unknown }).rev === 'number' ? (v as { rev: number }).rev : undefined

function listen(ch: string): void {
  ipcRenderer.on(ch, (_e, payload: unknown) => {
    const rev = revOf(payload)
    if (rev !== undefined) {
      const last = revs.get(ch)
      if (last !== undefined && rev <= last) return   // an older snapshot: the page applies only a newer rev
      revs.set(ch, rev)
    }
    held.set(ch, payload)
    for (const fn of subs.get(ch) ?? []) { try { fn(payload) } catch (err) { console.error(err) } }
  })
}

function on(ch: string, fn: Fn): () => void {
  if (typeof fn !== 'function') return () => {}
  let set = subs.get(ch)
  if (!set) subs.set(ch, set = new Set())
  set.add(fn)
  if (held.has(ch)) { const v = held.get(ch); queueMicrotask(() => { if (set!.has(fn)) fn(v) }) }
  return () => { set!.delete(fn) }
}

type SendChannel = Exclude<(typeof CH)[keyof typeof CH], InvokeChannel>
/** A page-to-main send; an invoke channel never goes this way (`INVOKES`). */
const send = (ch: SendChannel, ...payload: [unknown?]): void => { if (!isInvoke(ch)) ipcRenderer.send(ch, ...payload) }
/** A page-to-main invoke, answered by main's handler (`INVOKES`). */
const invoke = <T>(ch: InvokeChannel, ...payload: [unknown?]): Promise<T> =>
  isInvoke(ch) ? ipcRenderer.invoke(ch, ...payload) as Promise<T> : Promise.reject(new Error(`${ch} is not an invoke`))

let readied = false
const ready = () => { if (!readied) { readied = true; send(CH.ready) } }

const str = (v: unknown, max = 80) => String(v ?? '').slice(0, max)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)

const tabActions = {
  activate: (id: string) => send(CH.tabActivate, { id: str(id) }),
  close: (id: string) => send(CH.tabClose, { id: str(id) }),
  tabMenu: (id: string, x: number, y: number) => send(CH.tabMenu, { id: str(id), x: num(x), y: num(y) }),
  openLink: (url: string) => invoke<LinkOpenAnswer>(CH.linkOpen, { url: str(url, 4096) }),
}

function build(k: AppKind): PageApi {
  for (const ch of RECEIVES[k]) listen(ch)
  const base = { ready, onWindow: (fn: (w: WindowView) => void) => on(CH.window, fn as Fn) }
  switch (k) {
    case 'strip': {
      const api: StripApi = {
        ...base, ...tabActions, kind: 'strip',
        onTabs: (fn) => on(CH.tabs, fn as Fn),
        onPill: (fn) => on(CH.pill, fn as Fn),
        onPageFocus: (fn) => on(CH.pageFocus, fn as Fn),
        more: (m: TabsMore) => send(CH.tabsMore, {
          ids: Array.isArray(m?.ids) ? m.ids.slice(0, 64).map((i) => str(i)) : [], x: num(m?.x), y: num(m?.y),
        }),
        pillAction: (a: PillAction) => send(CH.pillAction, { rev: num(a?.rev), act: a?.act === 'dismiss' ? 'dismiss' : 'button' }),
      }
      return api
    }
    case 'home': {
      const api: HomeApi = {
        ...base, ...tabActions, kind: 'home',
        onTabs: (fn) => on(CH.tabs, fn as Fn),
        onRecent: (fn) => on(CH.recent, fn as Fn),
        onHomeInfo: (fn) => on(CH.homeInfo, fn as Fn),
        onHomeFocus: (fn) => on(CH.homeFocus, fn as Fn),
        action: (a: HomeAction) => invoke<HomeActionAnswer>(CH.homeAction, a && typeof a === 'object'
          ? { action: str((a as { action?: unknown }).action, 16), ...('id' in a ? { id: str((a as { id?: unknown }).id) } : {}) }
          : {}),
      }
      return api
    }
    case 'settings': {
      const api: SettingsApi = {
        ...base, kind: 'settings',
        onStatus: (fn) => on(CH.status, fn as Fn),
        get: () => invoke<SettingsView>(CH.settingsGet),
        set: (s: SettingsSet) => invoke<SettingsSetResult>(CH.settingsSet, {
          file: s?.file === 'theme' ? 'theme' : 'config', key: str(s?.key, 32),
          value: typeof s?.value === 'boolean' || typeof s?.value === 'number' ? s.value : str(s?.value, 16),
        }),
        reveal: () => send(CH.settingsReveal),
      }
      return api
    }
    case 'tabpage': {
      const api: TabPageApi = {
        ...base, kind: 'tabpage',
        onTabpage: (fn) => on(CH.tabpage, fn as Fn),
        onPageFocus: (fn) => on(CH.pageFocus, fn as Fn),
        action: (rev: number, action: TabPageAction) => send(CH.tabpageAction, { rev: num(rev), action: str(action, 16) }),
      }
      return api
    }
  }
}

if (kind) contextBridge.exposeInMainWorld('marverPage', build(kind))
