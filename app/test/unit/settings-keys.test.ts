/** The key table (src/shared/settings-keys.ts; spec 28 A2.7, A2.14 #23, v1.12 r1 #7): one source for the validator, the schemas, the README and Settings. */
import { describe, expect, it } from 'vitest'
import { check, defaults, judgeObject, KEYS, keySpec, schemaOf, shownKeys, type KeySpec } from '../../src/shared/settings-keys.ts'
import { renderReadme } from '../../src/main/readme.ts'

const spec = (f: 'config' | 'theme', k: string) => keySpec(f, k) as KeySpec

describe('check()', () => {
  it('takes a boolean for a boolean key and nothing else', () => {
    expect(check(spec('config', 'restoreTabs'), true)).toBeNull()
    expect(check(spec('config', 'restoreTabs'), false)).toBeNull()
    for (const v of ['yes', 1, 0, null, undefined, 'true']) expect(check(spec('config', 'restoreTabs'), v)).toBe('must be true or false')
  })

  it('takes a whole number from 1 to 90 for keepPerfDays', () => {
    const s = spec('config', 'keepPerfDays')
    for (const v of [1, 14, 90]) expect(check(s, v)).toBeNull()
    for (const v of [0, 91, 1.5, '14', true, -3, Number.NaN]) expect(check(s, v)).toBe('must be a whole number from 1 to 90')
  })

  it('takes each mode and says which three otherwise', () => {
    const s = spec('theme', 'mode')
    for (const v of ['system', 'light', 'dark']) expect(check(s, v)).toBeNull()
    for (const v of ['midnight', 'Dark', '', 1]) expect(check(s, v)).toBe('must be "system", "light" or "dark"')
  })
})

describe('the table', () => {
  it('holds every v1 key of the spec, and only those', () => {
    expect(Object.keys(KEYS.config).sort()).toEqual(['dockBadge', 'keepPerfDays', 'notifications', 'recorder', 'restoreTabs', 'unloadUnderPressure'])
    expect(Object.keys(KEYS.theme)).toEqual(['mode'])
  })

  it('defaults: restoreTabs on, mode system, notifications absent until chosen (A2.14 #23, A4.2)', () => {
    expect(defaults('config')).toEqual({ restoreTabs: true, unloadUnderPressure: true, recorder: true, keepPerfDays: 14, dockBadge: true })
    expect(defaults('config')).not.toHaveProperty('notifications')
    expect(defaults('theme')).toEqual({ mode: 'system' })
  })

  it('app 0.1 shows the keys of its milestone alone: Reopen tabs and Appearance (unloading A3, notices A4)', () => {
    expect(shownKeys('a2')).toEqual(['config.restoreTabs', 'theme.mode'])
    expect(shownKeys('a3')).toEqual(['config.restoreTabs', 'config.unloadUnderPressure', 'config.recorder', 'config.keepPerfDays', 'theme.mode'])
    expect(shownKeys('a4')).toHaveLength(7)
  })

  it('a key name that is a prototype property is not a key', () => {
    expect(keySpec('config', 'toString')).toBeUndefined()
    expect(keySpec('config', '__proto__')).toBeUndefined()
  })
})

describe('judgeObject()', () => {
  it('applies every v1 key from 0.1 on, unshown ones included', () => {
    expect(judgeObject('config', { restoreTabs: false, recorder: false, keepPerfDays: 30, notifications: true, dockBadge: false, unloadUnderPressure: false }))
      .toEqual({ ok: true, values: { restoreTabs: false, recorder: false, keepPerfDays: 30, notifications: true, dockBadge: false, unloadUnderPressure: false } })
  })

  it('takes $schema beside the keys and keeps it out of the values (v1.12 r1 #7)', () => {
    expect(judgeObject('config', { $schema: './schemas/config.schema.json', restoreTabs: false })).toEqual({ ok: true, values: { restoreTabs: false } })
  })

  it('refuses a $schema that is not a string, or is 2 KB or more', () => {
    expect(judgeObject('config', { $schema: 3 })).toMatchObject({ ok: false, problems: [{ key: '$schema' }] })
    expect(judgeObject('config', { $schema: 'x'.repeat(2048) })).toMatchObject({ ok: false, problems: [{ key: '$schema' }] })
  })

  it('an unknown key keeps the whole file from applying, named (A2.14 #23)', () => {
    expect(judgeObject('config', { restoreTab: true, restoreTabs: true })).toEqual({
      ok: false, problems: [{ key: 'restoreTab', message: 'restoreTab is not a config.json key' }],
    })
    expect(judgeObject('theme', { restoreTabs: true })).toMatchObject({ ok: false, problems: [{ message: 'restoreTabs is not a theme.json key' }] })
  })

  it('names every bad value, and applies nothing of the file', () => {
    const j = judgeObject('config', { restoreTabs: 'yes', unloadUnderPressure: false, keepPerfDays: 0 })
    expect(j).toEqual({ ok: false, problems: [
      { key: 'restoreTabs', message: 'restoreTabs must be true or false' },
      { key: 'keepPerfDays', message: 'keepPerfDays must be a whole number from 1 to 90' },
    ] })
  })

  it('must be one JSON object', () => {
    for (const o of [[], null, 'x', 3, [{ restoreTabs: true }]]) expect(judgeObject('config', o)).toEqual({ ok: false, problems: [{ message: 'must be one JSON object' }] })
  })
})

describe('the schemas and the README come from the table', () => {
  it('each schema lists every key and $schema, and nothing else is allowed', () => {
    for (const f of ['config', 'theme'] as const) {
      const s = schemaOf(f) as { additionalProperties: boolean; properties: Record<string, { type: string }> }
      expect(s.additionalProperties).toBe(false)
      expect(Object.keys(s.properties).sort()).toEqual(['$schema', ...Object.keys(KEYS[f])].sort())
      expect(s.properties.$schema.type).toBe('string')
    }
    const c = schemaOf('config') as { properties: Record<string, Record<string, unknown>> }
    expect(c.properties.keepPerfDays).toMatchObject({ type: 'integer', minimum: 1, maximum: 90, default: 14 })
    expect((schemaOf('theme') as { properties: Record<string, Record<string, unknown>> }).properties.mode).toMatchObject({ enum: ['system', 'light', 'dark'], default: 'system' })
  })

  it('the README has a row for every key of each file', () => {
    const md = renderReadme('0.1.0')
    for (const f of ['config', 'theme'] as const) {
      const section = md.split(`## ${f}.json`)[1].split('\n## ')[0]
      for (const k of Object.keys(KEYS[f])) expect(section).toContain(`| \`${k}\` |`)
    }
    expect(md).toContain('state/status.json')
    expect(md).toContain('npx marver ls --json')
  })
})
