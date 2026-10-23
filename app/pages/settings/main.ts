/**
 * Settings, a view of the files (spec 28 A2.7, A2.12, A2.13; frame mac-app/06). Served as marver-app://settings/.
 * On load and on every `status` push it asks `settings:get` and draws: each key this build shows (settings-keys.ts,
 * the same table main validates with), under its file's heading, a switch, a menu or a number field, the key's name
 * under its label. A change is one `settings:set`; refused, the control goes back to what is in force and the row
 * says why. A file that does not apply says so, with each problem and the file's text beside it. "Show the Files"
 * opens the folder. System Settings links (notices) come with A4.2.
 */
import type { SettingsFileView, SettingsSetResult, SettingsView } from '../../src/shared/channels.ts'
import { keySpec, type FileName, type KeySpec } from '../../src/shared/settings-keys.ts'
import { fill, h, pageApi, say, setLook, shown } from '../../src/pages/dom.ts'

const api = pageApi('settings')
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const filesEl = $('files')
const sideEl = $('side')
const noteEl = $('note')
const live = $('live')

let view: SettingsView | null = null
/** a row's last refusal, kept across redraws until that key is set again */
const errors = new Map<string, string>()
/** values sent and not yet answered: the control shows them meanwhile */
const pending = new Map<string, unknown>()
const NAMES: Record<FileName, string> = { config: 'config.json', theme: 'theme.json' }

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

async function change(file: FileName, key: string, value: boolean | number | string): Promise<void> {
  if (!api) return
  const id = `${file}.${key}`
  pending.set(id, value)
  errors.delete(id)
  render()
  const r = await api.set({ file, key, value })
  pending.delete(id)
  if (!r.ok) { errors.set(id, why(r, file)); say(live, errors.get(id)!) }
  await load()
}

function control(file: FileName, key: string, spec: KeySpec, f: SettingsFileView, labelId: string): HTMLElement {
  const id = `${file}.${key}`
  const value = pending.has(id) ? pending.get(id) : f.values[key]
  switch (spec.type) {
    case 'boolean': {
      const on = value === true
      return h('button', {
        class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-labelledby': labelId, 'data-ctl': id,
        onclick: () => void change(file, key, !on),
      })
    }
    case 'enum': {
      const sel = h('select', { 'aria-labelledby': labelId, 'data-ctl': id, onchange: (e) => void change(file, key, (e.target as HTMLSelectElement).value) },
        ...spec.values.map((v) => h('option', { value: v }, spec.names[v] ?? v)))
      sel.value = String(value ?? spec.def)
      return sel
    }
    case 'integer': {
      const inp = h('input', {
        type: 'number', min: spec.min, max: spec.max, step: 1, 'aria-labelledby': labelId, 'data-ctl': id,
        onchange: (e) => {
          const n = Number((e.target as HTMLInputElement).value)
          void change(file, key, Number.isInteger(n) ? n : Number.NaN)
        },
      })
      inp.value = String(value ?? spec.def)
      return inp
    }
  }
}

function hintOf(key: string, spec: KeySpec): string {
  if (spec.type === 'enum') return `${key} - ${spec.values.slice(0, -1).join(', ')} or ${spec.values[spec.values.length - 1]}`
  return spec.note ? `${key} - ${spec.note}` : key
}

function section(file: FileName, keys: string[]): HTMLElement | null {
  if (!view || !keys.length) return null
  const f = view[file]
  const hid = `h-${file}`
  return h('section', { 'aria-labelledby': hid },
    h('h2', { class: 'h2', id: hid }, `${view.dir}/${NAMES[file]}`),
    f.ok ? null : h('div', { class: 'problem' },
      h('p', {}, h('b', {}, `${NAMES[file]} did not apply`), ' · using the last good one'),
      h('ul', {}, ...(f.problems ?? []).map((p) => h('li', {}, p.message)))),
    ...keys.map((key) => {
      const spec = keySpec(file, key)
      if (!spec) return null
      const labelId = `l-${file}-${key}`
      const id = `${file}.${key}`
      return h('div', { class: 'row-wrap' },
        h('div', { class: 'row' },
          h('div', { class: 'row-txt' }, h('span', { id: labelId }, spec.label), h('small', { class: 'hint' }, hintOf(key, spec))),
          control(file, key, spec, f, labelId)),
        h('p', { class: 'row-err' }, errors.get(id) ?? ''))
    }))
}

function sideFor(file: FileName): HTMLElement | null {
  const f = view?.[file]
  if (!view || !f || f.ok) return null
  return h('div', { class: 'file' },
    h('small', {}, `${view.dir}/${NAMES[file]}`),
    f.text !== undefined ? h('pre', {}, f.text) : h('p', { class: 'hint' }, f.problems?.[0]?.message ?? ''))
}

function render(): void {
  if (!view) return
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.ctl
  const by = (file: FileName) => view!.shown.filter((s) => s.startsWith(`${file}.`)).map((s) => s.slice(file.length + 1))
  fill(filesEl, section('config', by('config')), section('theme', by('theme')))
  const sides = [sideFor('config'), sideFor('theme')].filter(Boolean) as HTMLElement[]
  sideEl.hidden = !sides.length   // no empty landmark
  fill(sideEl, ...sides, sides.length
    ? h('p', { class: 'hint' }, 'The app kept the last good file and wrote the problem to ', h('code', {}, `${view.dir}/state/status.json`), ', where an agent checks its edit.')
    : null)
  const st = view.status
  const note = !st.writable ? `${view.dir} can't be written · nothing is kept`
    : st.write ? `Couldn't save ${st.write.file}: ${WORDS[st.write.code] ?? st.write.code}` : ''
  noteEl.hidden = !note
  noteEl.textContent = note
  if (focused) (filesEl.querySelector(`[data-ctl="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus()
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

setLook(undefined)
shown()
if (api) {
  api.onStatus(() => void load())
  api.ready()
  void load()
}
