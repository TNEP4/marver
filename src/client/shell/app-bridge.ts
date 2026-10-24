/**
 * The shell's side of the Mac app (spec 28 A2.9; A2.14 #9, #13, #18, #26; v1.12 r1 #1, v1.13 r2 #1): what the canvas
 * tells the app through `window.marverApp`, and what it does when the app speaks. Inert anywhere else - in Chrome, on
 * a published canvas, under `marver shot` there is no `window.marverApp` (marver-app.ts), and nothing here listens,
 * sends or runs a timer.
 *
 * What the shell owes the app is A2.9's order and whole states: `mv:hello` first (its version, the board its link
 * names, and its `PAGE_ID`, the id the recorder stamps on every record), then `mv:theme`, `mv:busy` and `mv:menu`, each
 * sent whole and again whenever it changes. The admission - the app binding a document at its trusted commit and the
 * preload holding what the page said until then, replaying the latest of each, hello first (v1.12 r1 #1) - is the
 * preload's: `window.marverApp` is the same before and after, and the shell never sees a `doc`.
 *
 * - `mv:busy` is `{ busy, unsaved, why }` from unsaved.ts's reasons: sent once at boot, so the app's record of a page
 *   that runs is unknown for one turn at most (v1.13 r2 #1), then on every change of either;
 * - `mv:theme` is the ground under the strip: `play || viewTheme === 'dark'` (A2.14 #26; slides are play);
 * - `mv:menu` is the canvas's View and Jam items, each with its key as its `hint` - the app shows it in the item's
 *   name, never as an accelerator, so the key stays the page's (A2.7); a click replays that key, so the menu does
 *   exactly what the key does;
 * - `mv:app-state`: `shown` runs a resume reconcile, `untrusted` stops every microphone track the page holds (A2.14
 *   #13), `hidden` changes nothing (a hidden tab keeps running, A2.6).
 *
 * The one ground (0.27.2, A3.8 #27, #31): `mv:hello` says the inset the shell applied (inset.ts's `TOP`: 44 only when
 * the app said so and gave the whole presentation contract), and each `mv:present { epoch, w, h, frames }` is answered
 * once the viewport has that size (500 ms at most) and `frames` animation frames have passed, with the size it was
 * answered at - a newer request cancels an older wait, which is never answered. A request that never fits is answered
 * at the size found; main refuses it and the tab stays covered. rAF does not run in a hidden page, so a request to a
 * page nobody sees waits by itself. App 0.1 says no inset and asks nothing: none of it runs there.
 */
import { BOUNDS, type AppState, type Busy, type Hello, type MarverAppV1, type MenuItem, type Present } from '../../shared/app-api.ts'
import { APP } from './marver-app.ts'
import { TOP } from './inset.ts'
import { api, canvasStopped } from './api.ts'
import { asksBeforeLeaving, busyWhen, busyWhy, isUnsaved, leaveNow, onWorkChange, workChanged } from './unsaved.ts'
import { CONFIG, PUBLISHED, SOURCE_REVEALED, useStore } from './store.ts'
import { PAGE_ID } from './recorder.ts'
import { bootHash, UNPLACED } from './hash.ts'
import { useComments } from './comments-store.ts'
import { useNotes } from './notes.ts'
import { useJamCapture } from './jam-capture.ts'
import { useJamQueue } from './jam-queue.ts'
import { useJamUi } from './jam-state.ts'
import { useJamVoice, voiceUntrusted } from './jam-voice.ts'

/** The ground under the strip (A2.14 #26): the shell's own - never a frame's pinned theme. */
export const shellDark = (): boolean => { const s = useStore.getState(); return !!s.play || s.viewTheme === 'dark' }

/** `mv:hello`: within the contract's bounds, or the honest fallback (an unknown version, no board). */
export function helloNow(): Hello {
  const v = CONFIG.version
  const version = typeof v === 'string' && v.length <= BOUNDS.version && BOUNDS.versionChars.test(v) ? v : '0.0.0'
  const b = bootHash.board
  return { version, board: typeof b === 'string' && b.length <= BOUNDS.board ? b : null, page: PAGE_ID, inset: TOP }
}

/** How long the shell waits for its viewport to reach a request's size before it answers with the size it has. */
export const PRESENT_FIT_MS = 500

/**
 * The presentation's answer (A3.8 #27): one request at a time - a newer one cancels the wait of an older, which is
 * never answered. Wait for the asked viewport (1 px either way), then `frames` animation frames (1-8), then answer
 * with the viewport as it is. Exported for the browser tests' fake bridge; startAppBridge installs it.
 */
export function answerPresents(app: Pick<MarverAppV1, 'onPresent' | 'presented'>, call: (fn: () => void) => void = (fn) => fn()): () => void {
  if (typeof app.onPresent !== 'function' || typeof app.presented !== 'function') return () => {}
  let want = -1
  return app.onPresent((r: Present) => {
    if (!r || typeof r.epoch !== 'number') return
    want = r.epoch
    const since = performance.now()
    const frames = Math.min(BOUNDS.frames, Math.max(1, r.frames | 0))
    const step = (left: number) => requestAnimationFrame(() => {
      if (want !== r.epoch) return                                                  // superseded: never answered
      const fits = Math.abs(innerWidth - r.w) <= 1 && Math.abs(innerHeight - r.h) <= 1
      if (!fits && performance.now() - since < PRESENT_FIT_MS) return step(left)   // the resize has not reached this document yet
      if (fits && left > 1) return step(left - 1)
      call(() => app.presented!({ epoch: r.epoch, w: innerWidth, h: innerHeight }))
    })
    step(frames)
  })
}

/** `mv:busy` now. */
export function busyNow(): Busy {
  const why = busyWhy()
  return { busy: why.length > 0, unsaved: why.some(isUnsaved), why }
}

// ---- the menu (A2.7: the View and Jam items, today's keys) --------------------------------------------------

interface Item {
  id: string
  group: MenuItem['group']
  label: string
  hint: string
  /** the key a click replays - what App.tsx, Play.tsx and jamKey read: key, code and the modifiers */
  key: KeyboardEventInit
  /** a checkbox item: its mark is the page's state */
  checked?: () => boolean
  /** offered only while this answers true */
  when?: () => boolean
}
const jamOn = () => !PUBLISHED && !!CONFIG.jam
const laser = (inspect: boolean) => () => { const s = useStore.getState(); return s.laser && s.laserInspect === inspect }
const ITEMS: readonly Item[] = [
  { id: 'fit-all', group: 'view', label: 'Fit All', hint: '⇧1', key: { key: '!', code: 'Digit1', shiftKey: true } },
  { id: 'fit-selection', group: 'view', label: 'Fit Selection', hint: '⇧2', key: { key: '@', code: 'Digit2', shiftKey: true } },
  { id: 'actual-size', group: 'view', label: 'Actual Size', hint: '⇧0', key: { key: ')', code: 'Digit0', shiftKey: true } },
  { id: 'play', group: 'view', label: 'Play', hint: 'P', key: { key: 'p', code: 'KeyP' } },
  { id: 'hide-ui', group: 'view', label: 'Hide UI', hint: 'H', key: { key: 'h', code: 'KeyH' }, checked: () => document.body.classList.contains('sh-hide-ui') },
  { id: 'tidy', group: 'view', label: 'Tidy', hint: 'T', key: { key: 't', code: 'KeyT' } },
  { id: 'comments', group: 'view', label: 'Comments', hint: 'C', key: { key: 'c', code: 'KeyC' }, checked: () => useComments.getState().commentMode },
  { id: 'pins', group: 'view', label: 'Pins', hint: '⇧C', key: { key: 'C', code: 'KeyC', shiftKey: true }, checked: () => useComments.getState().show },
  { id: 'notes', group: 'view', label: 'Notes', hint: 'N', key: { key: 'n', code: 'KeyN' }, checked: () => useNotes.getState().all },
  { id: 'laser', group: 'view', label: 'Laser', hint: 'L', key: { key: 'l', code: 'KeyL' }, checked: laser(false), when: () => SOURCE_REVEALED },
  // with Option a Mac types a symbol (⌥L is "¬"): the shell names an Alt shortcut by the key pressed
  { id: 'inspect', group: 'view', label: 'Inspect', hint: '⌥L', key: { key: '¬', code: 'KeyL', altKey: true }, checked: laser(true), when: () => SOURCE_REVEALED },
  // D cycles the themes: a plain item, no mark (A2.14 #19)
  { id: 'theme', group: 'view', label: 'Theme', hint: 'D', key: { key: 'd', code: 'KeyD' }, when: () => CONFIG.themes.length > 1 },
  { id: 'session', group: 'jam', label: 'Session', hint: 'J', key: { key: 'j', code: 'KeyJ' }, checked: () => !!useJamQueue.getState().session, when: jamOn },
  { id: 'capture', group: 'jam', label: 'Capture', hint: 'S', key: { key: 's', code: 'KeyS' }, checked: () => !!useJamCapture.getState().current, when: jamOn },
  { id: 'lane', group: 'jam', label: 'The Lane', hint: 'Q', key: { key: 'q', code: 'KeyQ' }, checked: () => useJamUi.getState().laneKeys, when: jamOn },
  { id: 'next-review', group: 'jam', label: 'Next to Review', hint: 'V', key: { key: 'v', code: 'KeyV' }, when: jamOn },
]
const offered = (it: Item) => { try { return it.when?.() ?? true } catch { return false } }

/** `mv:menu` now: at most 40 items, ids, labels and hints within the contract's bounds. */
export function menuNow(): MenuItem[] {
  return ITEMS.filter(offered).slice(0, BOUNDS.menuItems).map((it) => ({
    id: it.id, group: it.group, label: it.label, hint: it.hint,
    ...(it.checked ? { checked: (() => { try { return !!it.checked!() } catch { return false } })() } : {}),
  }))
}

/** A menu item chosen in the app: its key, replayed on the shell's window - the same handlers, the same rules (a
 *  text field holding the focus does not stop it: the person chose the item). An id the page does not offer now
 *  does nothing. One id is the app's own, never in the menu: the tab's right-click Mark All as Seen clears every
 *  frame's "new" in this canvas, here and on disk, as the sidebar's Mark all as seen does for a board. */
export function runMenuItem(id: string): void {
  if (id === 'mark-all-seen') {
    const s = useStore.getState()
    if (!PUBLISHED && s.marks) s.markSeen(Object.keys(s.marks.changed))
    return
  }
  const it = ITEMS.find((x) => x.id === id)
  if (!it || !offered(it)) return
  window.dispatchEvent(new KeyboardEvent('keydown', { ...it.key, bubbles: true, cancelable: true }))
}

// ---- coming back into view ----------------------------------------------------------------------------------

let reconciling = false
/** The tab is shown again (`mv:app-state shown`, Codex r1 #14): the marks, the working state and the Jam queue are
 *  read again, and the board's file hash - a board changed on disk meanwhile is loaded again, never over an edit
 *  this page holds. One at a time: a `shown` while one runs is dropped. */
export async function resumeReconcile(): Promise<void> {
  if (reconciling || PUBLISHED || canvasStopped()) return
  reconciling = true
  try {
    const s = useStore.getState()
    void s.syncMarks()
    void s.syncWorking()
    if (jamOn()) void useJamQueue.getState().load()
    const board = s.board
    if (!s.manifest || board === UNPLACED || s.dirty || s.gesture) return
    const r = await api(`boards/${board}`)
    if (!r.ok) return
    const body = await r.json().catch(() => null) as { sha256?: unknown } | null
    const now = useStore.getState()
    if (now.board !== board || now.dirty || now.gesture) return
    const disk = typeof body?.sha256 === 'string' ? body.sha256 : null
    if (disk !== now.boardHash) await now.boot()
  } catch { /* the next shown, or the live socket, heals it */ } finally { reconciling = false }
}

function onAppState(s: AppState): void {
  if (s === 'shown') void resumeReconcile()
  else if (s === 'untrusted') voiceUntrusted()
}

// ---- the bridge ---------------------------------------------------------------------------------------------

let started = false

/** main.tsx, before the first render: hello, theme, busy, menu - then each again on its change. Nothing without
 *  `window.marverApp`. */
export function startAppBridge(): void {
  const app = APP
  if (!app || started) return
  started = true
  /** a bridge call that throws (the app went away under the page) never breaks the page */
  const call = (fn: () => void) => { try { fn() } catch { /* the page goes on */ } }

  // what the app says, listened for before the page says anything
  call(() => app.onAppState((s) => onAppState(s)))
  call(() => app.onMenuClick((p) => runMenuItem(typeof p?.id === 'string' ? p.id : '')))
  // the one ground's presentation requests (0.27.2): answered only when the shell took the inset - a shell that did
  // not is placed below the strip and never asked (A3.8 #31)
  if (TOP) call(() => { answerPresents(app, call) })

  // 1. hello, first (A2.14 #9)
  call(() => app.hello(helloNow()))

  // 2. the theme, at boot and on its change
  let lastDark: boolean | null = null
  const sendTheme = () => { const dark = shellDark(); if (dark === lastDark) return; lastDark = dark; call(() => app.theme({ dark })) }
  sendTheme()
  useStore.subscribe((s, p) => { if (!!s.play !== !!p.play || s.viewTheme !== p.viewTheme) sendTheme() })

  // 3. busy: the unsaved reasons every browser registers, and the three only the app hears
  busyWhen('jam-session', () => !!useJamQueue.getState().session)
  busyWhen('microphone', () => useJamVoice.getState().live)
  busyWhen('agent', () => useStore.getState().working.length > 0)
  useJamQueue.subscribe((s, p) => { if (!!s.session !== !!p.session) workChanged() })
  useJamVoice.subscribe((s, p) => { if (s.live !== p.live) workChanged() })
  useStore.subscribe((s, p) => { if ((s.working.length > 0) !== (p.working.length > 0)) workChanged() })
  let lastBusy = ''
  let again: ReturnType<typeof setTimeout> | undefined
  const sendBusy = () => {
    const b = busyNow()
    const k = JSON.stringify(b)
    if (k !== lastBusy) { lastBusy = k; call(() => app.busy(b)) }
    // while busy, looked at again each second: a reason with no hook of its own going away (a field emptied by
    // sending its words, a field removed) is told within a second; at rest, no timer
    clearTimeout(again)
    again = b.busy ? setTimeout(sendBusy, 1000) : undefined
  }
  onWorkChange(sendBusy)
  sendBusy()   // the first mv:busy, at boot (v1.13 r2 #1)

  // 4. the menu, on any change of what it shows
  let lastMenu = ''
  let menuQueued = false
  const sendMenu = () => {
    menuQueued = false
    const items = menuNow()
    const k = JSON.stringify(items)
    if (k !== lastMenu) { lastMenu = k; call(() => app.menu(items)) }
  }
  const menuChanged = () => { if (menuQueued) return; menuQueued = true; queueMicrotask(sendMenu) }
  sendMenu()
  useStore.subscribe((s, p) => { if (s.laser !== p.laser || s.laserInspect !== p.laserInspect) menuChanged() })
  useComments.subscribe((s, p) => { if (s.commentMode !== p.commentMode || s.show !== p.show) menuChanged() })
  useNotes.subscribe((s, p) => { if (s.all !== p.all) menuChanged() })
  useJamQueue.subscribe((s, p) => { if (!!s.session !== !!p.session) menuChanged() })
  useJamCapture.subscribe((s, p) => { if (!!s.current !== !!p.current) menuChanged() })
  useJamUi.subscribe((s, p) => { if (s.laneKeys !== p.laneKeys) menuChanged() })
  // Hide UI is a class on the body (Toolbar.tsx): its one source of truth
  new MutationObserver(menuChanged).observe(document.body, { attributes: true, attributeFilter: ['class'] })
}

// dev-only inspection hook for tests (never installed in published builds)
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as unknown as { __mvApp: unknown }).__mvApp = { active: !!APP, busy: busyNow, menu: menuNow, asks: asksBeforeLeaving, leaveNow, page: PAGE_ID }
}
