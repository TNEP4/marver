/**
 * The tab's own page (spec 28 A2.11, A2.13, A2.14 #19, #21, v1.13 r2 #3, v1.14 r3 #3, #4; frame mac-app/09). Served
 * as marver-app://tabpage/, one view per tab, over that tab's canvas view. It draws the one `tabpage` snapshot main
 * sends - the state as a union, timestamps only - and runs its own timers from `since`: words only after 400 ms for
 * a start or a crash's reload (a quick one shows only ground and dots), "Still starting" after 15 s. Its buttons
 * send `tabpage:action { rev, action }` with the snapshot's own `rev`; main refuses an old one, and the tab is the
 * view's own in main's map, never named here. Neutral words: a canvas is named only once main says it proved itself.
 * A send has no answer, so no button says "Copied". A new snapshot redraws the page but keeps focus on the same
 * action (A2.13 moves focus only when the focused view goes away): a probe's update never sends VoiceOver back to
 * the heading.
 */
import type { TabPageAction, TabPageView } from '../../src/shared/channels.ts'
import { clock, cmdButton, fill, h, icon, logo, pageApi, setLook, shown } from '../../src/pages/dom.ts'

const api = pageApi('tabpage')
const content = document.getElementById('content') as HTMLElement

const QUIET_MS = 400
const STILL_MS = 15_000

let view: TabPageView | null = null
let timer: ReturnType<typeof setTimeout> | undefined

const REASONS: Record<string, string> = {
  oom: 'Out of memory', 'memory-eviction': 'Out of memory', killed: 'Killed', crashed: 'Crashed',
  'abnormal-exit': 'Ended abnormally', 'launch-failed': 'Couldn\'t start', 'integrity-failure': 'Failed a code check',
}
const reasonWords = (r?: string) => (r ? REASONS[r] ?? r.charAt(0).toUpperCase() + r.slice(1) : null)
const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`)
const RETAINED = 'The page you had is still open. Try Again reloads it.'

/** `localhost:4806` for a bound origin (the people link's words: frame 09's "was localhost:4806"). */
function local(origin?: string): string | null {
  if (!origin) return null
  try { const u = new URL(origin); return u.port ? `localhost:${u.port}` : u.host } catch { return null }
}

function button(label: string, action: TabPageAction, primary = false): HTMLButtonElement {
  const rev = view!.rev
  const b = h('button', { class: `btn${primary ? ' primary' : ''}`, type: 'button', 'data-act': action }, label)
  b.addEventListener('click', () => { api?.action(rev, action) })
  return b
}

interface Parts { mark: Node; title: string; spin?: boolean; body?: (Node | string)[]; line?: string; cmd?: string; actions?: HTMLElement[]; meta?: string }

function parts(v: TabPageView, now: number): Parts | null {
  const age = now - v.since
  const mark = (tone?: 'grey' | 'dim') => logo(v, 44, tone)
  switch (v.page) {
    case 'starting': {
      if (age < QUIET_MS) return null
      const still = age >= STILL_MS && v.phase === 'starting'
      return {
        mark: mark(), spin: true, title: `${v.phase === 'opening' ? 'Opening' : 'Starting'} ${v.name}`,
        body: still ? ['Still starting - the terminal running ', h('code', {}, 'marver dev'), ' says why.'] : ['The tab opens it as soon as it is ready.'],
        meta: v.folder,
      }
    }
    case 'stopped': {
      const was = local(v.origin)
      return {
        mark: mark('grey'), title: `${v.name} stopped`,
        body: [v.retained ? RETAINED : 'Start it again in its folder and this tab comes back by itself.'],
        line: v.retained ? v.probe.state === 'proved' ? `${v.name} answers again` : v.probe.state === 'answers' ? 'The address answers again' : undefined : undefined,
        cmd: v.command,
        actions: [...(v.retained ? [button('Try Again', 'retry', true)] : []), button('Reveal in Finder', 'reveal'), button('Close Tab', 'close')],
        meta: `Stopped at ${clock(v.since)}${was ? ` · was ${was}` : ''}`,
      }
    }
    case 'unverified':
      return {
        mark: icon('warning', 40, 'warn'), title: 'Not a Marver canvas',
        body: ['Something else answers on this port: a canvas that stopped without cleaning up, or another program, or the canvas failed to render - its terminal says why. The app shows nothing it serves.', ...(v.retained ? [' ', RETAINED] : [])],
        // it already says something answers: no line until the tab's own canvas proves itself (v1.14 r3 #4)
        line: v.retained && v.probe.state === 'proved' ? `${v.name} answers again` : undefined,
        actions: [button('Try Again', 'retry'), button('Close Tab', 'close')],
        meta: [v.folder && `Registered by ${v.folder}`, v.host ?? local(v.origin)].filter(Boolean).join(' · '),
      }
    case 'unreachable':
      return {
        mark: mark(), title: `Can't reach ${v.name}`,
        body: [v.reason ?? 'Its address doesn\'t answer.', ...(v.retained ? [' ', RETAINED] : [])],
        line: v.retained ? v.probe.state === 'proved' ? `${v.name} answers again` : v.probe.state === 'answers' ? 'The address answers again' : undefined : undefined,
        actions: [button(v.retained ? 'Try Again' : 'Try Now', 'retry'), button('Close Tab', 'close')],
        meta: v.retained ? undefined : 'Trying again every few seconds',
      }
    case 'crashed': {
      if (!v.latched) return age < QUIET_MS ? null : { mark: mark('dim'), spin: true, title: 'Reloading after a crash' }
      const reason = reasonWords(v.reason)
      return {
        mark: mark('dim'), title: `${possessive(v.name)} page keeps crashing`,
        body: ['The canvas itself is fine. Reload brings back its board and camera; the details hold versions and this Mac, never your files.'],
        actions: [button('Reload', 'reload', true), button('Copy Details', 'copy-details')],
        meta: [reason, v.crashes ? `${v.crashes} crashes since ${clock(v.since)}` : null].filter(Boolean).join(' · '),
      }
    }
  }
}

function render(): void {
  if (timer) { clearTimeout(timer); timer = undefined }
  if (!view) return
  const v = view
  const now = Date.now()
  setLook(v.dark)
  const p = parts(v, now)
  const hadFocus = content.contains(document.activeElement)
  // focus is kept by action across a redraw: the same button in the new page, if it has one
  const focusedAct = hadFocus ? (document.activeElement as HTMLElement | null)?.dataset?.act : undefined
  if (!p) fill(content)
  else {
    const rev = v.rev
    let cmd: HTMLButtonElement | null = null
    if (p.cmd) {
      cmd = cmdButton(p.cmd, `Copy the start command for ${v.name}`, () => { api?.action(rev, 'copy-start'); return false })
      cmd.dataset.act = 'copy-start'
    }
    fill(content,
      h('div', { class: 'tp-mark', 'aria-hidden': 'true' }, p.mark),
      h('h1', { class: 'tp-title', id: 'tp-title' }, p.spin ? h('i', { class: 'spin', 'aria-hidden': 'true' }) : null, p.title),
      p.body ? h('p', { class: 'tp-body' }, ...p.body) : null,
      p.line ? h('p', { class: 'tp-line' }, p.line) : null,
      cmd,
      p.actions?.length ? h('div', { class: 'tp-act' }, ...p.actions) : null,
      p.meta ? h('p', { class: 'tp-meta' }, p.meta) : null)
  }
  document.title = p?.title ?? v.name
  if (focusedAct) (content.querySelector(`[data-act="${CSS.escape(focusedAct)}"]`) as HTMLElement | null)?.focus()
  if (hadFocus && !content.contains(document.activeElement)) content.focus()
  // the page's own timers, from `since`: never a rev bump from main for time passing (A2.14 #19)
  const age = now - v.since
  const next = (v.page === 'starting' || (v.page === 'crashed' && !v.latched)) && age < QUIET_MS ? QUIET_MS - age
    : v.page === 'starting' && v.phase === 'starting' && age < STILL_MS ? STILL_MS - age : null
  if (next !== null) timer = setTimeout(render, next + 5)
}

if (api) {
  api.onTabpage((v) => { view = v; render(); shown() })
  api.onPageFocus((f) => { if (f.target === 'heading') content.focus() })
  api.ready()
} else {
  setLook(undefined)
  shown()
}
