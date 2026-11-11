/** The app-owned files of ~/.marver (src/main/readme.ts; spec 28 A2.12): each says its version and is whole, or is written again. */
import { describe, expect, it } from 'vitest'
import { isWhole, renderOwned, renderReadme, renderSchemas, wholeVersion } from '../../src/main/readme.ts'

describe('README.md', () => {
  it('starts with its version and the sha256 of every byte after the first line', () => {
    const md = renderReadme('0.1.0')
    expect(md).toMatch(/^<!-- marver-app 0\.1\.0 sha256:[0-9a-f]{64} -->\n# ~\/\.marver/)
    expect(wholeVersion('README.md', md)).toBe('0.1.0')
  })

  it('is not whole when cut short under its first line, or edited', () => {
    const md = renderReadme('0.1.0')
    expect(isWhole('README.md', md.slice(0, md.indexOf('\n') + 40))).toBe(false)
    expect(isWhole('README.md', md.replace('Rules for agents', 'Rules'))).toBe(false)
    expect(isWhole('README.md', '')).toBe(false)
  })

  it('spec 33 C6: autoUpdate is used from app 1.2.1, its own version over its milestone\'s', () => {
    const row = renderReadme('1.2.1').split('\n').find((l) => l.startsWith('| `autoUpdate`'))
    expect(row).toMatch(/^\| `autoUpdate` \| true or false \| `true` \| 1\.2\.1 \| Check for updates every few hours/)
  })
  it('lists update.json among the app\'s state files (A5.1 #18, #23)', () => {
    const state = renderReadme('1.0.0').split('\n').find((l) => l.startsWith('| `state/`'))
    expect(state).toContain('`update.json`')
  })

  it('another version is whole, and says so (a dev build keeps it; a release build writes its own)', () => {
    expect(wholeVersion('README.md', renderReadme('0.0.9'))).toBe('0.0.9')
    expect(renderReadme('0.0.9')).not.toBe(renderReadme('0.1.0'))
  })
})

describe('schemas', () => {
  it('carry their version and hash in $comment, and are whole through it', () => {
    for (const [name, text] of renderSchemas('0.1.0')) {
      expect(name).toMatch(/^schemas\/(config|theme)\.schema\.json$/)
      expect(JSON.parse(text).$comment).toMatch(/^marver-app 0\.1\.0 sha256:[0-9a-f]{64}$/)
      expect(wholeVersion(name, text)).toBe('0.1.0')
      expect(isWhole(name, text.replace('"integer"', '"number"').replace('"enum"', '"enumx"'))).toBe(false)
      expect(isWhole(name, text.slice(0, 80))).toBe(false)
    }
  })

  it('every owned file, by path', () => {
    expect(renderOwned('0.1.0').map(([p]) => p)).toEqual(['README.md', 'schemas/config.schema.json', 'schemas/theme.schema.json'])
  })
})
