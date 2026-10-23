/**
 * Home (spec 28 A2.7, A2.12, A2.13, A2.14 #3, #5, v1.13 r2 #6; frames mac-app/04, 10, 11, 14). Served as
 * marver-app://home/. It draws `tabs`, `recent` and `home:info`, and asks main for everything else by name: a card
 * activates its tab, a command button names which command (`home:action`), the link field sends what was typed
 * (`link:open`) and draws the answer. Home names which command or which recent canvas, never a path or a command's
 * text.
 *
 * - The title: "Welcome to Marver" on the very first launch (for the whole run), else "On this Mac".
 * - Running canvases: one card per local tab (a closed one too: Home lists it, A2.4), a button named for what it
 *   says ("TMS broker, localhost:4806, running").
 * - Nothing running: how to start one (and on the first launch, the two steps for a repo without Marver).
 * - Recently here: initials (A2.14 #5), the folder, when it last ran (refreshed each minute), its start command.
 * - The link field (`⌘L`): the line under it says where Return opens it, named from the tabs; Return asks main;
 *   `refused` keeps the link selected with its line; Esc goes back to the tab it came from, whatever it holds.
 * - No Shared canvases section in app 0.1 (A2.14 #3).
 */
import type { HomeInfo, LinkOpenAnswer, RecentView, TabsSnapshot, TabView } from '../../src/shared/channels.ts'
import { parseLink } from '../../src/shared/links.ts'
import { ago, cmdButton, fill, h, hostOf, icon, logo, pageApi, portOf, say, setLook, shown } from '../../src/pages/dom.ts'

const api = pageApi('home')
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const titleEl = $('title')
const input = $<HTMLInputElement>('link')
const hintEl = $('hint')
const backEl = $('back')
const bodyEl = $('body')
const footEl = $('foot')
const live = $('live')
$('field-ic').append(icon('link', 15))

let snap: TabsSnapshot | null = null
let recent: RecentView[] = []
let info: HomeInfo = { welcome: false, writable: true }
let back: string | undefined
/** the answer to the last Return, while the field still holds what was sent */
let answer: { why: Exclude<LinkOpenAnswer, { ok: true }>['why']; sent: string; port: number | null } | null = null

const STATE_WORDS: Record<TabView['state'], string> = {
  none: 'Running', live: 'Running', hidden: 'Running', starting: 'Starting', gone: 'Stopped',
  unverified: 'Not a Marver canvas', unreachable: 'Can\'t reach', crashed: 'Crashed',
}
const canvases = (): TabView[] => (snap?.tabs ?? []).filter((t) => t.kind === 'local')
const tabOnPort = (port: number) => canvases().find((t) => portOf(t.link) === port && t.state !== 'gone')
  ?? canvases().find((t) => portOf(t.link) === port)
const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`)

/** True for a version before 0.27.1: no bridge, the degraded guard (A2.14 #15). */
function beforeBridge(v?: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '')
  if (!m) return false
  const [a, b, c] = m.slice(1).map(Number)
  return a === 0 && (b < 27 || (b === 27 && c < 1))
}

const copyFixed = (id: 'dev' | 'init' | 'update') => async () => (await api?.action({ action: 'copy', id }))?.ok ?? false

function card(t: TabView): HTMLElement {
  const host = hostOf(t.link)
  const word = STATE_WORDS[t.state]
  const label = [t.name, host, t.open === false ? `${word.toLowerCase()}, tab closed` : word.toLowerCase()].filter(Boolean).join(', ')
  const tone = t.state === 'gone' || t.state === 'unreachable' ? 'grey' : t.state === 'crashed' ? 'dim' : undefined
  const mark = t.state === 'unverified' ? h('span', { class: 'slot-warn', 'aria-hidden': 'true' }, icon('warning', 28)) : logo(t, 30, tone)
  return h('button', {
    class: `card is-${t.state}`, type: 'button', 'data-key': `tab:${t.id}`, 'aria-label': label,
    onclick: () => api?.activate(t.id),
  },
  h('span', { class: 'card-hd' }, mark, h('span', {}, t.name)),
  t.folder ? h('small', {}, t.folder) : null,
  host || t.version ? h('small', {}, [host, t.version && `Marver ${t.version}`].filter(Boolean).join(' · ')) : null,
  h('span', { class: 'state' }, t.state === 'starting' ? h('i', { class: 'spin', 'aria-hidden': 'true' }) : null, word, t.open === false ? ' · tab closed' : null),
  beforeBridge(t.version) ? h('span', { class: 'note' }, 'Update to Marver 0.27.1 for the full unsaved-work guard') : null)
}

function recentCard(r: RecentView): HTMLElement {
  return h('div', { class: 'card stopped', 'data-key': `recent:${r.id}` },
    h('span', { class: 'card-hd' }, logo(r, 30, 'grey'), h('span', {}, r.name)),
    h('small', {}, r.folder),
    h('small', { class: 'ran' }, `Ran ${ago(r.lastSeen)}`),
    cmdButton('npx marver dev', `Copy the start command for ${r.name}`, async () => (await api?.action({ action: 'copy-start', id: r.id }))?.ok ?? false))
}

function emptyCard(): HTMLElement[] {
  if (info.welcome) {
    return [
      h('div', { class: 'card welcome' },
        h('p', { class: 'lead' }, 'No canvas is running yet'),
        h('p', { class: 'soft' }, 'In a repo with Marver, start its canvas:'),
        cmdButton('npx marver dev', 'Copy npx marver dev', copyFixed('dev')),
        h('p', { class: 'soft' }, 'It appears here, with its own tab, a second after it starts.'),
        h('hr', { 'aria-hidden': 'true' }),
        h('p', { class: 'soft' }, 'A repo without Marver yet? Two steps first:'),
        cmdButton('npm i -D @marver-design/marver && npx marver init', 'Copy the two setup commands', copyFixed('init'))),
      h('div', { class: 'card ghost', 'aria-hidden': 'true' }),
      h('div', { class: 'card ghost', 'aria-hidden': 'true' }),
    ]
  }
  return [h('div', { class: 'card empty' },
    h('span', {}, h('b', {}, 'Nothing is running.'), ' ', h('span', { class: 'soft' }, 'Start a canvas in its repo; it appears here, with its own tab, a second later.')),
    cmdButton('npx marver dev', 'Copy npx marver dev', copyFixed('dev')))]
}

function renderBody(): void {
  const key = (document.activeElement as HTMLElement | null)?.dataset?.key
  const running = canvases()
  fill(bodyEl,
    info.welcome ? h('h2', { class: 'h2' }, 'On this Mac') : null,
    running.length ? h('div', { class: 'cards' }, ...running.map(card)) : h('div', { class: 'cards' }, ...emptyCard()),
    recent.length ? h('h2', { class: 'h2' }, 'Recently here') : null,
    recent.length ? h('div', { class: 'cards' }, ...recent.map(recentCard)) : null)
  if (key) (bodyEl.querySelector(`[data-key="${CSS.escape(key)}"]`) as HTMLElement | null)?.focus()
}

function renderFoot(): void {
  fill(footEl,
    h('div', { class: 'old hint' },
      'Canvases on Marver 0.26 or older don\'t appear here: update them with',
      cmdButton('npm i -D @marver-design/marver@latest', 'Copy the update command', copyFixed('update'))),
    h('div', { class: 'files' },
      info.writable
        ? h('span', { class: 'hint' }, 'Settings and notes for agents live in ', h('code', {}, '~/.marver/'))
        : h('span', { class: 'hint unwritable' }, '~/.marver can\'t be written · nothing is kept'),
      h('button', { class: 'quiet', type: 'button', onclick: () => void api?.action({ action: 'show-files' }) }, 'Show the Files')))
}

function renderTitle(): void {
  titleEl.textContent = info.welcome ? 'Welcome to Marver' : 'On this Mac'
}

// ---- the link field ----------------------------------------------------------------------------------------------

function hintFor(text: string): (Node | string)[] {
  if (answer && answer.sent === text) {
    const t = answer.port ? tabOnPort(answer.port) : undefined
    switch (answer.why) {
      case 'refused': return [`Not opened: ${t ? possessive(t.name) : 'the canvas\'s'} page stays as it was`]
      case 'nothing': return [`Nothing is running on localhost:${answer.port ?? ''}`]
      case 'not-canvas': return [`Something else answers on localhost:${answer.port ?? ''}: not a Marver canvas`]
      case 'later': return ['Shared canvases open in a later build']
      case 'bad': return ['Not a canvas link']
    }
  }
  if (!text.trim()) return []
  const p = parseLink(text)
  if (p.kind === 'bad') return ['Not a canvas link']
  if (p.kind === 'https') return ['Shared canvases open in a later build']
  const t = tabOnPort(p.port)
  if (!t) return [`Nothing is running on localhost:${p.port}`]
  return [h('kbd', { 'aria-hidden': 'true' }, '↩'), ' opens in ', logo(t, 14), h('b', {}, possessive(t.name)), ` tab${p.board ? ', on that board' : ''}`]
}

function renderHint(): void {
  const nodes = hintFor(input.value)
  fill(hintEl, ...nodes)
  hintEl.classList.toggle('refused', answer?.why === 'refused' && answer.sent === input.value)
  const b = back ? snap?.tabs.find((t) => t.id === back) : undefined
  fill(backEl, ...(b ? [h('kbd', { 'aria-hidden': 'true' }, 'esc'), ` back to ${b.kind === 'home' ? 'Home' : b.name}`] : []))
}

async function submit(): Promise<void> {
  const sent = input.value
  if (!sent.trim() || !api) return
  const p = parseLink(sent)
  const a = await api.openLink(sent)
  if (a.ok) {
    if (input.value === sent) input.value = ''
    answer = null
  } else {
    answer = { why: a.why, sent, port: p.kind === 'local' ? p.port : null }
    if (input.value === sent) input.select()
  }
  renderHint()
  if (!a.ok) say(live, hintEl.textContent ?? '')
}

input.addEventListener('input', () => renderHint())
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); void submit() }
  else if (e.key === 'Escape') {
    e.preventDefault()
    // back to the tab ⌘L came from, whatever the field holds; if that tab has closed, stay on Home
    if (back && snap?.tabs.some((t) => t.id === back)) api?.activate(back)
  }
})

// ---- what main sends ---------------------------------------------------------------------------------------------

setLook(undefined)
renderTitle()
renderBody()
renderFoot()
shown()
setInterval(() => {
  for (const el of bodyEl.querySelectorAll<HTMLElement>('.card.stopped')) {
    const r = recent.find((x) => `recent:${x.id}` === el.dataset.key)
    const ran = el.querySelector('.ran')
    if (r && ran) ran.textContent = `Ran ${ago(r.lastSeen)}`
  }
}, 60_000)

if (api) {
  api.onTabs((s) => { snap = s; renderBody(); renderHint() })
  api.onRecent((r) => { recent = Array.isArray(r) ? r : []; renderBody() })
  api.onHomeInfo((i) => { info = i; renderTitle(); renderBody(); renderFoot() })
  api.onHomeFocus((f) => {
    if (f.field !== 'link') return
    back = f.back
    input.focus()
    input.select()
    renderHint()
  })
  api.ready()
}
