/**
 * One Team ID across a bundle (spec 28 A2.8, scripts/team-id.mjs): what the build checks before it moves a bundle
 * into out/, and what the smoke and the test launchers check before they launch one.
 */
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertOneTeam, bundleOf, checkTeams, judgeTeams } from '../../scripts/team-id.mjs'

/** The dev build's Electron binary, as the launchers find it (its path only: nothing launches here). */
const ELECTRON_BIN = createRequire(join(resolve(import.meta.dirname, '..', '..'), 'package.json'))('electron') as string

const part = (p: string, team: string | null, signed = true) => ({ part: p, team, signed })

describe('the Team ID check', () => {
  it('passes a bundle whose parts all carry one Team ID, or all none', () => {
    expect(judgeTeams('A.app', [part('Contents/MacOS/Marver', 'PXV6WER853'), part('Contents/Frameworks/X.framework/Versions/A/X', 'PXV6WER853')]))
      .toMatchObject({ ok: true, team: 'PXV6WER853' })
    expect(judgeTeams('A.app', [part('Contents/MacOS/Marver', null), part('Contents/Frameworks/X.framework/Versions/A/X', null, false)]))
      .toMatchObject({ ok: true, team: null })
  })

  it('refuses a half-signed bundle, naming each Team ID and its parts', () => {
    // what osx-sign leaves part-way: the helpers signed with the Developer ID, the main binary still ad-hoc
    const v = judgeTeams('/x/Marver.app', [part('Contents/MacOS/Marver', null), part('Contents/Frameworks/Marver Helper.app/Contents/MacOS/Marver Helper', 'PXV6WER853')])
    expect(v.ok).toBe(false)
    expect(v.message).toMatch(/^refusing to launch \/x\/Marver\.app: its Mach-O parts carry 2 Team IDs/)
    expect(v.message).toContain('PXV6WER853: 1 part (Contents/Frameworks/Marver Helper.app/Contents/MacOS/Marver Helper)')
    expect(v.message).toContain('none (ad-hoc or unsigned): 1 part (Contents/MacOS/Marver)')
  })

  it('refuses a folder with no Mach-O part', () => {
    expect(judgeTeams('/x/Empty.app', []).ok).toBe(false)
  })

  it('finds the outermost bundle of a helper\'s binary', () => {
    expect(bundleOf('/a/Marver.app/Contents/Frameworks/Marver Helper.app/Contents/MacOS/Marver Helper')).toBe('/a/Marver.app')
    expect(bundleOf('/usr/bin/true')).toBeNull()
  })

  it('reads the dev build\'s Electron.app: every part, one Team ID (none: Electron\'s npm binary is ad-hoc)', () => {
    const app = bundleOf(ELECTRON_BIN)!
    const v = checkTeams(app)
    expect(v.ok).toBe(true)
    expect(v.parts.map((p: { part: string }) => p.part)).toEqual(expect.arrayContaining(['Contents/MacOS/Electron',
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)']))
    expect(assertOneTeam(ELECTRON_BIN)).toMatchObject({ ok: true })
  })
})
