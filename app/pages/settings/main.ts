/**
 * Settings, a view of the files (spec 28 A2.7, A2.12, A2.13), in Home's glass (spec 33 A; design scenes settings-v2/).
 * Served as marver-app://settings/. On load and on every `status` push it asks `settings:get` and draws a centred
 * column of groups - Updates, Appearance, Tabs, Notices, Performance - each a glass card of rows from one table
 * (`ROWS`), a row only for a key this build shows (`view.shown`). A change is one `settings:set`; the control shows
 * the value sent until main answers; refused, it goes back to what is in force and the row says why. A file that does
 * not apply gets a card at the top with its problems and its text. "Show the files" opens the folder.
 *
 * Notices (A4.6 #25, #27): macOS decides whether notices show, so the row always says so and offers Open System
 * Settings; after a notice that failed to post it says "macOS couldn't post Marver's last notice". The Dock badge row
 * shows only once notices are on.
 *
 * Updates (spec 33 C): the updater's state as main reads it (`view.update`, update-model.ts `updateRow`); the button
 * sends the row's token back, and main acts only while it holds. "Last checked" is rewritten each minute in place.
 * D switches light and dark (dom.ts `themeKey`).
 */
import type { SettingsFileView, SettingsSetResult, SettingsView, UpdateRow } from '../../src/shared/channels.ts'
import { BLOCKED_TITLE } from '../../src/shared/channels.ts'
import { keySpec, type FileName } from '../../src/shared/settings-keys.ts'
import { ago, fill, h, icon, pageApi, say, setLook, shown, themeKey, type IconName } from '../../src/pages/dom.ts'
import { openMenu, type MenuHandle, type MenuRow } from '../../src/pages/menu.ts'

const api = pageApi('settings')
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const groupsEl = $('groups')
const badEl = $('bad')
const noteEl = $('note')
const live = $('live')

let view: SettingsView | null = null
/** a row's last refusal, kept across redraws until that key is set again */
const errors = new Map<string, string>()
/** values sent and not yet answered: the control shows them meanwhile */
const pending = new Map<string, unknown>()
const NAMES: Record<FileName, string> = { config: 'config.json', theme: 'theme.json' }
const KEEP = [7, 14, 30, 90]

type Group = 'Updates' | 'Appearance' | 'Tabs' | 'Notices' | 'Performance'
const GROUPS: Group[] = ['Updates', 'Appearance', 'Tabs', 'Notices', 'Performance']
/** The rows (spec 33 A3): group, file, key, label, desc. */
const ROWS: [Group, FileName, string, string, string][] = [
  ['Updates', 'config', 'autoUpdate', 'Download updates automatically', 'Marver checks every few hours and gets an update ready; it asks before restarting'],
  ['Appearance', 'theme', 'mode', 'Theme', 'Canvases keep their own · switch with'],
  ['Tabs', 'config', 'restoreTabs', 'Reopen tabs at launch', 'The canvases you had open come back'],
  ['Tabs', 'config', 'unloadUnderPressure', 'Unload hidden tabs when memory runs short', 'Never one that is busy; it reloads when you come back'],
  ['Notices', 'config', 'notifications', 'Notices', 'When a canvas needs you: a question, a review, a run that failed'],
  ['Notices', 'config', 'dockBadge', 'Dock badge', 'The number of canvases that need you'],
  ['Performance', 'config', 'recorder', 'Performance recorder', 'What loads slowly, what flashes white - for you and your agent'],
  ['Performance', 'config', 'keepPerfDays', 'Keep performance files', 'Older days are deleted whole'],
]
const MODES: [string, string, IconName][] = [['system', 'System', 'screen'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']]

const WORDS: Record<string, string> = {
  ENOSPC: 'the disk is full', EDQUOT: 'the disk quota is full', EACCES: 'no permission', EPERM: 'no permission', EROFS: 'the disk is read-only',
}
function why(r: Exclude<SettingsSetResult, { ok: true }>, file: FileName): string {
  switch (r.why) {
    case 'unwritable': return `${view?.dir ?? '~/.marver'} can't be written`
    case 'write-failed': return `Couldn't save ${NAMES[file]}: ${WORDS[r.code ?? ''] ?? r.code ?? 'the write failed'}`
    case 'unknown-key': return 'This build doesn\'t take that setting'
    case 'bad-value': return 'That value isn\'t one this setting takes'
  }
}

async function change(file: FileName, key: string, value: boolean | number | string, via?: 'key'): Promise<void> {
  if (!api) return
  const id = `${file}.${key}`
  pending.set(id, value)
  errors.delete(id)
  render()
  let r: SettingsSetResult
  // an answer that never came (main refused the call, or went away) is a failed write: the control goes back
  try { r = await api.set({ file, key, value, ...(via ? { via } : {}) }) } catch { r = { ok: false, why: 'write-failed' } } finally { pending.delete(id) }
  if (!r.ok) { errors.set(id, why(r, file)); say(live, errors.get(id)!) }
  await load()
}

const valueOf = (file: FileName, key: string, f: SettingsFileView): unknown => {
  const id = `${file}.${key}`
  return pending.has(id) ? pending.get(id) : f.values[key]
}

// ---- the controls (spec 33 A4) --------------------------------------------------------------------------------

function toggle(file: FileName, key: string, on: boolean, labelId: string): HTMLElement {
  return h('button', {
    class: 'st-sw', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': labelId, 'data-ctl': `${file}.${key}`,
    onclick: () => void change(file, key, !on),
  }, h('i'))
}

/** System, Light, Dark: a radio group - a click, or the arrows (they move and choose, one tab stop: the chosen one). */
function segmented(mode: string, labelId: string): HTMLElement {
  const pick = (m: string) => { if (mode !== m) void change('theme', 'mode', m) }
  return h('div', {
    class: 'st-seg', role: 'radiogroup', 'aria-labelledby': labelId,
    onkeydown: (e) => {
      const k = (e as KeyboardEvent).key
      const step = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 0
      if (!step) return
      e.preventDefault()
      const i = MODES.findIndex(([m]) => m === mode)
      const next = MODES[(i + step + MODES.length) % MODES.length][0]
      document.querySelector<HTMLElement>(`[data-ctl="theme.mode.${next}"]`)?.focus()
      pick(next)
    },
  }, ...MODES.map(([m, label, ic]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(mode === m), tabindex: mode === m ? '0' : '-1', 'data-ctl': `theme.mode.${m}`,
    onclick: () => pick(m),
  }, icon(ic, 14), label)))
}

let menu: MenuHandle | null = null
/** the days button as drawn now (a redraw replaces it while its menu stays open) */
const daysBtn = () => document.querySelector<HTMLElement>('.st-select-btn')
function closeMenu(): void { menu?.close(); menu = null; daysBtn()?.setAttribute('aria-expanded', 'false') }

/** The days select (A4): a pill that opens the shared Marver menu under it, right-aligned; a value off the list is listed. */
const daysRows = (days: number): MenuRow[] =>
  (KEEP.includes(days) ? KEEP : [...KEEP, days].sort((a, b) => a - b)).map((d) => ({ kind: 'item', id: String(d), label: `${d} days`, enabled: true, checked: d === days }))

function select(days: number, labelId: string): HTMLElement {
  // a redraw while the menu is open (an agent changed the file) checks the value now in force
  menu?.update(daysRows(days))
  const btn = h('button', {
    class: 'st-select-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': String(!!menu), 'aria-labelledby': `${labelId} keep-now`,
    'data-ctl': 'config.keepPerfDays',
  }, h('span', { id: 'keep-now' }, `${days} days`), icon('caret', 12))
  btn.addEventListener('click', () => {
    if (menu) { closeMenu(); return }
    const r = btn.getBoundingClientRect()
    const done = (focus: boolean) => { menu = null; const b = daysBtn(); b?.setAttribute('aria-expanded', 'false'); if (focus) b?.focus() }
    menu = openMenu(document.body, {
      rows: daysRows(days),
      at: { x: r.right, y: r.bottom + 6, origin: 'top right' }, top: 44, opener: btn, focusFirst: btn.matches(':focus-visible'),
      // compared with the value in force at the pick, never the one at the open
      onPick: (id) => { done(true); if (Number(id) !== view?.config.values.keepPerfDays) void change('config', 'keepPerfDays', Number(id)) },
      onClose: (how) => done(how !== 'outside'),
    })
    btn.setAttribute('aria-expanded', 'true')
  })
  return btn
}

// ---- the rows ------------------------------------------------------------------------------------------------

function row(file: FileName, key: string, label: string, desc: string): HTMLElement | null {
  if (!view) return null
  const f = view[file]
  const spec = keySpec(file, key)
  if (!spec) return null
  const id = `${file}.${key}`
  const labelId = `l-${file}-${key}`
  const v = valueOf(file, key, f)
  const err = errors.get(id)
  const ctl = key === 'mode' ? segmented(String(v ?? spec.def), labelId)
    : key === 'keepPerfDays' ? select(Number(v ?? spec.def), labelId)
      : toggle(file, key, v === true, labelId)
  const words = err ?? desc
  const tail = key === 'mode' ? (err ? null : h('kbd', {}, 'D')) : h('code', {}, key)
  return h('div', { class: 'st-row' },
    h('div', { class: 'st-txt' }, h('div', { class: 'st-label', id: labelId }, label),
      h('div', { class: `st-desc${err ? ' err' : ''}` }, `${words}${key === 'mode' && !err ? ' ' : ''}`, tail)),
    h('div', { class: 'st-ctl' }, ctl))
}

/** Under the Notices switch: that macOS decides, a notice that failed to post, if one did, and Open System Settings, always. */
function noticesMore(): HTMLElement {
  const failed = view?.notices.outcome === 'failed'
  return h('div', { class: 'st-row sub' },
    h('div', { class: 'st-txt' },
      h('div', { class: 'st-desc', id: 'notices-macos' }, 'macOS decides whether notices show. With Marver set to Don\'t Allow, or a Focus that silences it, they don\'t appear, and Marver can\'t tell.'),
      failed ? h('div', { class: 'st-desc err', id: 'notices-failed' }, 'macOS couldn\'t post Marver\'s last notice') : null),
    h('div', { class: 'st-ctl' }, h('button', { class: 'st-btn ghost', type: 'button', id: 'notice-settings', onclick: () => api?.action({ action: 'open-notification-settings' }) }, 'Open System Settings')))
}

// ---- Updates (spec 33 C3) --------------------------------------------------------------------------------------

/** the state line's mark and words, the button's label, and the small line under it */
function upWords(u: UpdateRow): { mark?: IconName | 'spin'; tone?: string; text?: string; button?: string; primary?: boolean; small?: string } {
  const last = u.checkedAt !== null ? `Last checked ${ago(u.checkedAt)}` : undefined
  switch (u.show) {
    case 'off': return { text: 'This build doesn\'t update itself' }
    case 'blocked': return { mark: 'warning', tone: 'err', text: BLOCKED_TITLE[u.why!], button: 'Learn more' }
    case 'restarting': return { mark: 'spin', text: `Restarting to install Marver ${u.next}`, button: 'Restarting…' }
    case 'ready': return { mark: 'arrow-down', tone: 'new', text: `Marver ${u.next} is ready to install`, button: 'Restart to update', primary: true, small: 'Your canvases keep running' }
    case 'waiting': return { mark: 'arrow-down', tone: 'new', text: `Marver ${u.next} waits for ${u.tab}`, button: 'Try again', primary: true, small: 'It has unsaved work' }
    case 'checking': return { mark: 'spin', text: 'Checking for updates…', button: 'Checking…', small: last }
    case 'downloading': return { mark: 'spin', text: 'Downloading the update…', button: 'Downloading…' }
    case 'failed': return { mark: 'warning', tone: 'err', text: `Marver ${u.next} couldn't be installed`, button: 'Download', small: 'Install it again from the disk image' }
    case 'error': return { mark: 'warning', tone: 'err', text: 'Couldn\'t check - you\'re offline, or GitHub didn\'t answer', button: 'Try again' }
    case 'current': return { mark: 'check-bold', tone: 'ok', text: 'Marver is up to date', button: 'Check for updates', small: last }
    case 'idle': return { button: 'Check for updates', small: 'Not checked yet' }
  }
}

function updates(u: UpdateRow): HTMLElement[] {
  const w = upWords(u)
  const mark = w.mark === 'spin' ? h('i', { class: 'st-spin', 'aria-hidden': 'true' }) : w.mark ? icon(w.mark, 13) : null
  const token = u.token
  const button = w.button ? h('button', {
    class: `st-btn${w.primary ? ' primary' : ''}`, type: 'button', id: 'update-btn', disabled: !token,
    onclick: () => { if (token) api?.action({ action: 'update', token }) },
  }, w.button) : null
  const small = w.small ? h('small', { id: 'checked', ...(w.small.startsWith('Last checked') ? { 'data-at': String(u.checkedAt) } : {}) }, w.small) : null
  const out = [h('div', { class: 'st-row st-up' },
    h('img', { class: 'st-appicon', src: 'app-mark.png', alt: '', draggable: 'false' }),
    h('div', { class: 'st-txt' },
      h('div', { class: 'st-app' }, 'Marver ', h('span', { class: 'st-ver' }, u.version)),
      w.text ? h('div', { class: `st-state${w.tone ? ` ${w.tone}` : ''}`, id: 'update-state' }, mark, w.text) : null,
      u.show === 'downloading' ? h('div', { class: 'st-bar', role: 'progressbar', 'aria-label': 'Downloading the update' }, h('i')) : null),
    button || small ? h('div', { class: 'st-act' }, button, small) : null)]
  if ((u.show === 'ready' || u.show === 'waiting') && u.next) {
    out.push(h('div', { class: 'st-row sub st-notes' },
      h('div', { class: 'st-txt' }, h('div', { class: 'st-label' }, `What's new in ${u.next}`),
        u.notes?.length ? h('ul', {}, ...u.notes.map((n) => h('li', {}, n))) : null),
      h('div', { class: 'st-ctl' }, h('button', { class: 'st-btn ghost', type: 'button', id: 'release-notes', onclick: () => api?.action({ action: 'release-notes' }) }, 'Release notes'))))
  }
  return out
}

/** Every minute: only "Last checked" is rewritten (spec 33 A5) - an open menu and the focus stay. */
setInterval(() => {
  const el = document.querySelector<HTMLElement>('#checked[data-at]')
  if (el) el.textContent = `Last checked ${ago(Number(el.dataset.at))}`
}, 60_000)

// ---- a file that does not apply, the page --------------------------------------------------------------------

function badCard(file: FileName): HTMLElement | null {
  const f = view?.[file]
  if (!view || !f || f.ok) return null
  return h('section', { class: 'st-bad', 'aria-label': `${NAMES[file]} did not apply` },
    h('p', { class: 'st-bad-h' }, h('b', {}, `${NAMES[file]} did not apply`), ' · using the last good one'),
    h('ul', {}, ...(f.problems ?? []).map((p) => h('li', {}, p.message))),
    f.text !== undefined ? h('pre', {}, f.text) : h('p', {}, f.problems?.[0]?.message ?? ''),
    h('p', {}, 'The app kept the last good file and wrote the problem to ', h('code', {}, view.statusFile), ', where an agent checks its edit.'))
}

function render(): void {
  if (!view) return
  const v = view
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.ctl ?? (document.activeElement?.id || undefined)
  const shownKeys = new Set(v.shown)
  const groups = GROUPS.map((g) => {
    const rows: (HTMLElement | null)[] = g === 'Updates' ? updates(v.update) : []
    for (const [group, file, key, label, desc] of ROWS) {
      if (group !== g || !shownKeys.has(`${file}.${key}`)) continue
      // the badge needs the same permission as notices (A4.6 #21): its row only once they are on
      if (key === 'dockBadge' && v.config.values.notifications !== true) continue
      rows.push(row(file, key, label, desc))
      if (key === 'notifications') rows.push(noticesMore())
    }
    if (!rows.some(Boolean)) return null
    const hid = `g-${g.toLowerCase()}`
    return h('section', { class: 'st-group', 'aria-labelledby': hid }, h('h3', { id: hid }, g), h('div', { class: 'st-card' }, ...rows))
  })
  fill(groupsEl, ...groups)
  fill(badEl, badCard('config'), badCard('theme'))
  for (const el of document.querySelectorAll('code.dir')) el.textContent = `${v.dir}/`
  const st = v.status
  const note = !st.writable ? `${v.dir} can't be written · nothing is kept`
    : st.write ? `Couldn't save ${st.write.file}: ${WORDS[st.write.code] ?? st.write.code}` : ''
  noteEl.hidden = !note
  noteEl.textContent = note
  if (focused && !menu?.open) (document.querySelector<HTMLElement>(`[data-ctl="${CSS.escape(focused)}"]`) ?? document.getElementById(focused))?.focus()
}

let loading: Promise<void> | null = null
let again = false
/** settings:get, one at a time; a push while one is in flight asks once more after it. */
function load(): Promise<void> {
  if (!api) return Promise.resolve()
  if (loading) { again = true; return loading }
  loading = (async () => {
    do {
      again = false
      try { view = await api.get() } catch { /* main went away: keep what is drawn */ }
      render()
    } while (again)
  })().finally(() => { loading = null })
  return loading
}

$('reveal').addEventListener('click', () => api?.reveal())
// D: light or dark, the opposite of what shows (spec 33 D)
document.addEventListener('keydown', (e) => {
  const mode = themeKey(e)
  if (!mode) return
  e.preventDefault()
  void change('theme', 'mode', mode, 'key')
})
// a window blur closes the days menu, as Home's menus close (menu.ts has no blur rule)
window.addEventListener('blur', () => closeMenu())
// a resize moves its button: the menu closes rather than stay where the button was
window.addEventListener('resize', () => closeMenu())

setLook(undefined)
shown()
if (api) {
  api.onStatus(() => void load())
  api.ready()
  void load()
}
