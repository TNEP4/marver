/**
 * The keys of `~/.marver/config.json` and `theme.json` (spec 28 A2.7, A2.14 #23, v1.12 r1 #7): one table for the
 * validator, the JSON Schemas, the README's key tables and Settings' rows, so none can drift from the others.
 *
 * Every v1 key is accepted from app 0.1 on (a file written for 1.0 applies in 0.1); Settings shows a key only from
 * the milestone that builds it (`since <= STAGE`). `$schema` is not a key: the validator takes it before the table
 * (a string under 2 KB), so any other unknown key still keeps the file from applying. No Electron or file-system
 * imports: Settings' page and main both read it.
 */

export type Stage = 'a2' | 'a3' | 'a4' | 'a5'
export const STAGES: readonly Stage[] = ['a2', 'a3', 'a4', 'a5']
/** The milestone this build is: Settings shows the keys with `since <= STAGE`. */
export const STAGE: Stage = 'a2'
/** The app version that brings each milestone, for the README's tables. */
export const STAGE_VERSION: Record<Stage, string> = { a2: '0.1', a3: '0.2', a4: '0.3', a5: '1.0' }

interface Base { since: Stage; label: string; does: string; note?: string }
export type KeySpec =
  | Base & { type: 'boolean'; def: boolean | null }
  | Base & { type: 'integer'; min: number; max: number; def: number; unit?: string }
  | Base & { type: 'enum'; values: readonly string[]; def: string; names: Record<string, string> }

export type FileName = 'config' | 'theme'

export const KEYS = {
  config: {
    restoreTabs: {
      type: 'boolean', def: true, since: 'a2', label: 'Reopen tabs at launch',
      does: 'At launch, reopen the tabs you had, each on the board it showed. Off: start on Home; every running canvas still gets its tab.',
    },
    unloadUnderPressure: {
      type: 'boolean', def: true, since: 'a3', label: 'Unload hidden tabs when memory runs short', note: 'never a busy one',
      does: 'When macOS runs short of memory, unload the least recently shown hidden tab - never one with unsaved work. It reopens where it was when shown.',
    },
    recorder: {
      type: 'boolean', def: true, since: 'a3', label: 'Performance recorder',
      does: 'Keep a performance record of each canvas tab in perf/, for `npx marver perf`.',
    },
    keepPerfDays: {
      type: 'integer', min: 1, max: 90, def: 14, unit: 'days', since: 'a3', label: 'Keep performance files',
      does: 'How many days performance files are kept before they are removed.',
    },
    notifications: {
      type: 'boolean', def: null, since: 'a4', label: 'Notices',
      does: 'Post a macOS notice when a canvas needs you. Absent until you choose; the app offers it once.',
    },
    dockBadge: {
      type: 'boolean', def: true, since: 'a4', label: 'Dock badge',
      does: 'Count what needs you on the Dock icon. Shown once notices are on.',
    },
  },
  theme: {
    mode: {
      type: 'enum', values: ['system', 'light', 'dark'], def: 'system', since: 'a2', label: 'Appearance',
      names: { system: 'System', light: 'Light', dark: 'Dark' },
      does: 'The app\'s own appearance: Home, Settings and the strip over them. It also sets the colour scheme that frames following the system see; each canvas keeps its own theme.',
    },
  },
} as const satisfies Record<FileName, Record<string, KeySpec>>

export type ConfigKey = keyof typeof KEYS.config
export type ThemeKey = keyof typeof KEYS.theme

/** The longest `$schema` the validator takes (v1.12 r1 #7). */
export const SCHEMA_MAX = 2048
/** The biggest settings file the app reads. */
export const FILE_MAX = 64 * 1024

export const keySpec = (file: FileName, key: string): KeySpec | undefined =>
  Object.hasOwn(KEYS[file], key) ? (KEYS[file] as Record<string, KeySpec>)[key] : undefined

/** True when a key's milestone is built: Settings shows it and `settings:set` takes it. */
export const shownIn = (stage: Stage, spec: KeySpec): boolean => STAGES.indexOf(spec.since) <= STAGES.indexOf(stage)

/** Every key this build shows, as `<file>.<key>`, in table order. */
export function shownKeys(stage: Stage = STAGE): string[] {
  const out: string[] = []
  for (const file of ['config', 'theme'] as const) {
    for (const [key, spec] of Object.entries(KEYS[file]) as [string, KeySpec][]) if (shownIn(stage, spec)) out.push(`${file}.${key}`)
  }
  return out
}

const quoteList = (vs: readonly string[]) =>
  vs.length === 1 ? `"${vs[0]}"` : `${vs.slice(0, -1).map((v) => `"${v}"`).join(', ')} or "${vs[vs.length - 1]}"`

/** The ~40-line check (A2.7): null when the value is good, else what it must be. */
export function check(spec: KeySpec, v: unknown): string | null {
  switch (spec.type) {
    case 'boolean':
      return typeof v === 'boolean' ? null : 'must be true or false'
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v) && v >= spec.min && v <= spec.max
        ? null : `must be a whole number from ${spec.min} to ${spec.max}`
    case 'enum':
      return typeof v === 'string' && spec.values.includes(v) ? null : `must be ${quoteList(spec.values)}`
  }
}

/** The defaults, as effective values (a boolean whose default is "absent" stays absent). */
export function defaults(file: FileName): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(KEYS[file]) as [string, KeySpec][]) if (spec.def !== null) out[key] = spec.def
  return out
}

export interface Problem { key?: string; message: string }

/**
 * A settings file's parsed object, judged whole (A2.7): every problem, or the values it sets. Pure. The caller
 * parses (and strips a BOM); this sees only what JSON.parse returned.
 */
export function judgeObject(file: FileName, o: unknown): { ok: true; values: Record<string, unknown> } | { ok: false; problems: Problem[] } {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return { ok: false, problems: [{ message: 'must be one JSON object' }] }
  const problems: Problem[] = []
  const values: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (k === '$schema') {
      if (typeof v !== 'string' || v.length >= SCHEMA_MAX) problems.push({ key: k, message: `$schema must be a string under ${SCHEMA_MAX / 1024} KB` })
      continue
    }
    const spec = keySpec(file, k)
    if (!spec) { problems.push({ key: k, message: `${k} is not a ${file}.json key` }); continue }
    const bad = check(spec, v)
    if (bad) problems.push({ key: k, message: `${k} ${bad}` })
    else values[k] = v
  }
  return problems.length ? { ok: false, problems } : { ok: true, values }
}

/** One key's JSON Schema property. */
function schemaProp(spec: KeySpec): Record<string, unknown> {
  const description = spec.does
  switch (spec.type) {
    case 'boolean': return { type: 'boolean', ...(spec.def !== null ? { default: spec.def } : {}), description }
    case 'integer': return { type: 'integer', minimum: spec.min, maximum: spec.max, default: spec.def, description }
    case 'enum': return { type: 'string', enum: [...spec.values], default: spec.def, description }
  }
}

/** The JSON Schema of one file (draft 2020-12, for editors' hints): every v1 key, `$schema` allowed, nothing else. */
export function schemaOf(file: FileName): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    $schema: { type: 'string', maxLength: SCHEMA_MAX - 1, description: 'This file\'s schema; the app writes it and ignores it.' },
  }
  for (const [key, spec] of Object.entries(KEYS[file]) as [string, KeySpec][]) properties[key] = schemaProp(spec)
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${file}.schema.json`,
    title: `~/.marver/${file}.json`,
    description: `The Marver app's ${file === 'config' ? 'settings' : 'appearance'}. Every key is optional: an absent file is the defaults. A file with a wrong value or an unknown key does not apply as a whole; state/status.json says why.`,
    type: 'object',
    additionalProperties: false,
    properties,
  }
}

/** How a key's type reads in the README. */
export function typeWords(spec: KeySpec): string {
  switch (spec.type) {
    case 'boolean': return 'true or false'
    case 'integer': return `whole number, ${spec.min}-${spec.max}${spec.unit ? ` ${spec.unit}` : ''}`
    case 'enum': return spec.values.map((v) => `\`"${v}"\``).join(', ')
  }
}

/** How a key's default reads in the README. */
export function defaultWords(spec: KeySpec): string {
  if (spec.def === null) return 'absent'
  return spec.type === 'enum' ? `\`"${spec.def}"\`` : `\`${String(spec.def)}\``
}
