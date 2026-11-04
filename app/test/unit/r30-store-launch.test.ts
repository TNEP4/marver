/**
 * Spec 30 R7 #37: one `launch` line per launch, its fields from what the callers saw (fake ports, a fake clock): at the
 * first local canvas uncovered, or 30 s after ready with `why`. Times are ms from process start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppBody } from '../../../src/shared/app-perf.ts'
import { launchFirstCanvas, launchQuit, launchReady, launchRestored, launchWindowShown, launchWriter, processStart, resetLaunch } from '../../src/main/launch.ts'
import { T } from '../../src/main/timings.ts'

const START = 1_800_000_000_000
const lines: AppBody<'launch'>[] = []
const TABS = { restored: 2, local: 2, remote: 0, active: 'local' as const }
const CANVAS = { tab: 't1', ws: 'ab'.repeat(8), page: '90879e227f04', commit: 3, cause: 'doc' as const }
beforeEach(() => { vi.useFakeTimers({ now: START + 150 }); lines.length = 0; resetLaunch() })
afterEach(() => { vi.useRealTimers(); resetLaunch() })

describe('the launch line (#37)', () => {
  it('at the first local canvas uncovered: every time in ms from process start, the page that joins its boot load', () => {
    launchReady(START + 150, START)
    launchWriter((b) => lines.push(b))
    launchRestored(TABS, 12.4)
    launchWindowShown(START + 410)
    expect(lines).toEqual([])
    launchFirstCanvas(CANVAS, START + 1900)
    expect(lines).toEqual([{ readyMs: 150, windowShownMs: 410, firstCanvas: { tab: 't1', ws: CANVAS.ws, page: CANVAS.page, commit: 3, uncoveredMs: 1900, cause: 'doc' }, tabs: TABS, restoreTabs: 12 }])
  })

  it('one line per launch: a second canvas, a second show, the deadline and the quit add nothing', () => {
    launchReady(START + 150, START)
    launchWriter((b) => lines.push(b))
    launchRestored(TABS, 1)
    launchWindowShown(START + 300)
    launchWindowShown(START + 900)
    launchFirstCanvas(CANVAS, START + 500)
    launchFirstCanvas({ ...CANVAS, tab: 't2' }, START + 600)
    vi.advanceTimersByTime(T.launchLineMs + 1000)
    launchQuit()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.windowShownMs).toBe(300)
    expect(lines[0]!.firstCanvas!.tab).toBe('t1')
  })

  it('why: home - tabs came back, Home in front, and 30 s passed', () => {
    launchReady(START + 150, START)
    launchWriter((b) => lines.push(b))
    launchRestored({ restored: 2, local: 2, remote: 0, active: 'home' }, 3)
    vi.advanceTimersByTime(T.launchLineMs - 1)
    expect(lines).toEqual([])
    vi.advanceTimersByTime(1)
    expect(lines).toEqual([{ readyMs: 150, why: 'home', tabs: { restored: 2, local: 2, remote: 0, active: 'home' }, restoreTabs: 3 }])
  })

  it('why: settings in front is Home\'s case; none-restored - nothing came back; timeout - a canvas in front never uncovered', () => {
    const run = (tabs: AppBody<'launch'>['tabs']) => {
      resetLaunch(); lines.length = 0
      launchReady(START + 150, START)
      launchWriter((b) => lines.push(b))
      launchRestored(tabs, 0)
      vi.advanceTimersByTime(T.launchLineMs)
      return lines[0]!.why
    }
    expect(run({ restored: 1, local: 1, remote: 0, active: 'settings' })).toBe('home')
    expect(run({ restored: 0, local: 0, remote: 0, active: 'home' })).toBe('none-restored')
    expect(run({ restored: 1, local: 1, remote: 0, active: 'local' })).toBe('timeout')
    expect(run({ restored: 1, local: 0, remote: 1, active: 'remote' })).toBe('timeout')
  })

  it('a canvas that says no page in its hello (older than 0.27.2) has page null, never a guess', () => {
    launchReady(START + 150, START)
    launchWriter((b) => lines.push(b))
    launchFirstCanvas({ tab: 't1', cause: 'hello' }, START + 800)
    expect(lines[0]!.firstCanvas).toEqual({ tab: 't1', page: null, uncoveredMs: 800, cause: 'hello' })
  })

  it('a canvas uncovered before the recorder is up is written the moment it is', () => {
    launchReady(START + 150, START)
    launchFirstCanvas(CANVAS, START + 500)
    expect(lines).toEqual([])
    launchWriter((b) => lines.push(b))
    expect(lines).toHaveLength(1)
  })

  it('a quit before its moment writes what it has', () => {
    launchReady(START + 150, START)
    launchWriter((b) => lines.push(b))
    launchRestored(TABS, 1)
    launchQuit()
    expect(lines).toEqual([{ readyMs: 150, why: 'timeout', tabs: TABS, restoreTabs: 1 }])
  })

  it('the process start is the wall clock less its uptime', () => {
    expect(Math.abs(processStart() - (Date.now() - process.uptime() * 1000))).toBeLessThan(50)
  })
})
