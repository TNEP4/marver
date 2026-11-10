/**
 * Home v2's model (app/pages/home/model.ts; spec 32 D6, D8.1, D10), pure: each row of D6's table, its precedence, the
 * Needs you and Agent working lines, the order inside a column, one card per tab, the menus by what a card is now,
 * the empty state and the view preference.
 */
import { describe, expect, it } from 'vitest'
import type { RecentView, SharedLink, TabMarks, TabView } from '../../src/shared/channels.ts'
import { columnOf, homeModel, lineText, menuRows, viewOf, workLine, workTime, deepFolder, type CardModel } from '../../pages/home/model.ts'

const NOW = 1_800_000_000_000
const home: TabView = { id: 'h', kind: 'home', name: 'Home', state: 'live', verified: true, open: true }
const tab = (id: string, over: Partial<TabView> = {}): TabView =>
  ({ id, kind: 'local', name: `Canvas ${id}`, state: 'live', verified: true, open: true, link: 'http://localhost:4806/', ...over })
const marks = (o: Partial<TabMarks> = {}): TabMarks => ({ needs: 0, unseen: 0, working: false, session: false, ...o })
const line = (t: TabView) => { const l = columnOf(t, NOW); return { col: l.col, text: lineText(l), dot: l.dot ?? null, num: l.num ?? null } }
const ago = (t: number) => `${Math.round((NOW - t) / 3_600_000)} hours ago`
const model = (tabs: TabView[], recent: RecentView[] = [], shared: SharedLink[] = []) => homeModel({ snap: { rev: 1, active: 'h', tabs: [home, ...tabs] }, recent, shared, now: NOW, ago })
const ids = (cs: CardModel[]) => cs.map((c) => c.id)

describe('D6: each card\'s column and line', () => {
  it('a local tab, row by row', () => {
    expect(line(tab('a', { marks: marks({ needs: 2, kinds: { ask: 2, review: 0, failed: 0, stalled: 0 }, top: { kind: 'ask', board: 'Vault feed' } }) }))).toEqual({ col: 'ask', text: '2 questions on Vault feed', dot: null, num: { n: 2, tone: 'ask' } })
    expect(line(tab('a', { marks: marks({ needs: 1, kinds: { ask: 1, review: 0, failed: 0, stalled: 0 }, top: { kind: 'ask', board: 'Main' } }) })).text).toBe('1 question on Main')
    expect(line(tab('a', { marks: marks({ working: true, work: { board: 'Onboarding', since: NOW - 4 * 60_000 } }) }))).toEqual({ col: 'work', text: 'Agent working on Onboarding · 4 min', dot: 'work', num: null })
    expect(line(tab('a', { marks: marks({ unseen: 4 }) }))).toEqual({ col: 'review', text: '4 new frames to look at', dot: null, num: { n: 4, tone: 'new' } })
    expect(line(tab('a', { marks: marks({ unseen: 1 }) })).text).toBe('1 new frame to look at')
    expect(line(tab('a'))).toEqual({ col: 'live', text: 'Running', dot: 'live', num: null })
    expect(line(tab('a', { state: 'hidden' }))).toMatchObject({ col: 'live', text: 'Running' })
    expect(line(tab('a', { state: 'none' }))).toMatchObject({ col: 'live', text: 'Running' })
    expect(line(tab('a', { state: 'starting' }))).toMatchObject({ col: 'live', text: 'Starting…', dot: 'live' })
    expect(line(tab('a', { state: 'hidden', hung: true }))).toMatchObject({ col: 'live', text: 'Not responding' })
    expect(line(tab('a', { state: 'unreachable' })).text).toBe('Can\'t reach')
    expect(line(tab('a', { state: 'crashed' })).text).toBe('Crashed')
    expect(line(tab('a', { state: 'unloaded' })).text).toBe('Unloaded')
    expect(line(tab('a', { state: 'unverified' }))).toEqual({ col: 'live', text: 'Not a Marver canvas', dot: null, num: null })
    expect(line(tab('a', { state: 'gone' }))).toEqual({ col: 'off', text: 'Stopped', dot: 'off', num: null })
  })

  it('a closed tab still running adds " · tab closed" to a plain state word only', () => {
    expect(line(tab('a', { open: false })).text).toBe('Running · tab closed')
    expect(line(tab('a', { open: false, state: 'starting' })).text).toBe('Starting… · tab closed')
    expect(line(tab('a', { open: false, marks: marks({ unseen: 2 }) })).text).toBe('2 new frames to look at')
  })

  it('Needs you\'s kind from the counts: an ask count with no items still reads Needs you, with no board; asks on two boards "2 questions"', () => {
    expect(line(tab('a', { marks: marks({ needs: 3, kinds: { ask: 3, review: 0, failed: 0, stalled: 0 }, top: { kind: 'ask' } }) }))).toMatchObject({ col: 'ask', text: '3 questions' })
    expect(line(tab('a', { marks: marks({ needs: 2, kinds: { ask: 2, review: 0, failed: 0, stalled: 0 }, top: { kind: 'ask' } }) })).text).toBe('2 questions')
    expect(line(tab('a', { marks: marks({ needs: 1, top: { kind: 'failed', board: 'Checkout' } }) })).text).toBe('Agent run failed on Checkout')
    expect(line(tab('a', { marks: marks({ needs: 1, top: { kind: 'stalled' } }) })).text).toBe('Agent stalled')
    expect(line(tab('a', { marks: marks({ needs: 1, top: { kind: 'review', board: 'Main' } }) }))).toMatchObject({ col: 'ask', text: 'Agent run to review on Main', dot: 'ask' })
  })

  it('precedence: a state that blocks the canvas beats its marks; stale marks count for nothing', () => {
    const asking = marks({ needs: 1, kinds: { ask: 1, review: 0, failed: 0, stalled: 0 }, top: { kind: 'ask' }, working: true, unseen: 3 })
    expect(line(tab('a', { state: 'hidden', hung: true, marks: asking }))).toMatchObject({ col: 'live', text: 'Not responding' })
    expect(line(tab('a', { state: 'crashed', marks: asking })).text).toBe('Crashed')
    expect(line(tab('a', { state: 'unverified', marks: asking })).col).toBe('live')
    expect(line(tab('a', { marks: { ...asking, stale: true } }))).toMatchObject({ col: 'live', text: 'Running' })
    expect(line(tab('a', { marks: marks({ working: true, unseen: 2 }) })).col).toBe('work')
  })

  it('an unacknowledged stop with no held snapshot reads Needs you "Stopped unexpectedly"; without one, Not running "Stopped"', () => {
    expect(line(tab('a', { state: 'gone', marks: marks({ needs: 1, stopped: true, top: { kind: 'stopped' } }) }))).toEqual({ col: 'ask', text: 'Stopped unexpectedly', dot: 'ask', num: null })
    expect(line(tab('a', { state: 'gone' })).col).toBe('off')
  })

  it('work: minutes (at least 1), hours from 60, no board, and a 0.29-0.31 canvas with no work at all', () => {
    expect(workTime(NOW - 10_000, NOW)).toBe('1 min')
    expect(workTime(NOW - 59 * 60_000, NOW)).toBe('59 min')
    expect(workTime(NOW - 60 * 60_000, NOW)).toBe('1 h')
    expect(workTime(NOW - 150 * 60_000, NOW)).toBe('2 h')
    expect(workLine({ since: NOW - 3 * 60_000 }, NOW)).toBe('Agent working · 3 min')
    expect(workLine(undefined, NOW)).toBe('Agent working')
    // the 60 s timer moves the minutes: the same view read a minute later
    const t = tab('a', { marks: marks({ working: true, work: { board: 'X', since: NOW - 2 * 60_000 } }) })
    expect(lineText(columnOf(t, NOW))).toBe('Agent working on X · 2 min')
    expect(lineText(columnOf(t, NOW + 60_000))).toBe('Agent working on X · 3 min')
  })

  it('recents, remote tabs and past shared links', () => {
    const m = model([
      { id: 'r1', kind: 'remote', name: 'pilot', state: 'live', verified: true, open: true, link: 'https://pilot.example.com/' },
      { id: 'r2', kind: 'remote', name: 'deck', state: 'crashed', verified: true, open: true, link: 'https://deck.example.com/' },
      { id: 'r3', kind: 'remote', name: 'new', state: 'starting', verified: true, open: true, link: 'https://new.example.com/' },
    ], [
      { id: 'r_1', name: 'Newsletter', folder: '~/n', lastSeen: NOW - 19 * 3_600_000 },
      { id: 'r_2', name: 'Linked', folder: '~/l', lastSeen: 0 },
    ], [{ url: 'https://pilot.example.com/x', host: 'pilot.example.com', lastSeen: NOW - 1, id: 's_a', name: 'Pilot site' }, { url: 'https://old.example.com/', host: 'old.example.com', lastSeen: NOW - 2 * 3_600_000, id: 's_b' }])
    const by = (id: string) => m.byId.get(id)!
    expect([lineText(by('r_1').line), by('r_1').col, by('r_1').off]).toEqual(['Ran 19 hours ago', 'off', true])
    expect(lineText(by('r_2').line)).toBe('Not running')
    expect(lineText(by('r1').line)).toBe('Open')
    expect(by('r1').name).toBe('Pilot site')   // its site's name (spec 31 E3)
    expect(lineText(by('r2').line)).toBe('Crashed')
    expect(lineText(by('r3').line)).toBe('Opening…')
    expect(by('r1').line.dot).toBeUndefined()
    expect(m.byId.has('s_a')).toBe(false)       // hidden while its origin's tab is open
    expect([lineText(by('s_b').line), by('s_b').off, by('s_b').url]).toEqual(['Opened 2 hours ago', true, 'https://old.example.com/'])
    expect(ids(m.shared)).toEqual(['r1', 'r2', 'r3', 's_b'])
  })

  it('one card per tab: two tabs of one workspace on two ports are two cards of the same name; an unverified one is named by its host', () => {
    const m = model([tab('p1', { name: 'TMS', link: 'http://localhost:4806/' }), tab('p2', { name: 'TMS', link: 'http://localhost:4807/' }), tab('u', { state: 'unverified', link: 'http://localhost:4808/' })])
    expect(m.running.map((c) => [c.id, c.name])).toEqual([['p1', 'TMS'], ['p2', 'TMS'], ['u', 'localhost:4808']])
    expect(m.byId.get('u')!.warn).toBe(true)
  })
})

describe('D6.3: order', () => {
  it('column priority, then strip order; Not running: the linked recent, then gone tabs, then recents newest first', () => {
    const m = model([
      tab('live1'), tab('rev', { marks: marks({ unseen: 1 }) }), tab('gone1', { state: 'gone' }), tab('ask', { marks: marks({ needs: 1, top: { kind: 'stalled' } }) }), tab('work', { marks: marks({ working: true }) }), tab('live2'),
    ], [{ id: 'r_link', name: 'L', folder: '~', lastSeen: 0, linked: true }, { id: 'r_new', name: 'N', folder: '~', lastSeen: NOW - 1 }, { id: 'r_old', name: 'O', folder: '~', lastSeen: NOW - 9 }])
    expect(ids(m.running)).toEqual(['ask', 'work', 'rev', 'live1', 'live2'])
    expect(ids(m.notRunning)).toEqual(['r_link', 'gone1', 'r_new', 'r_old'])
    expect(ids(m.columns.ask)).toEqual(['ask'])
    expect(ids(m.columns.live)).toEqual(['live1', 'live2'])
  })
})

describe('D8.1: a card\'s menu, from the card as it is now', () => {
  const rows = (c: CardModel) => menuRows(c).map((r) => (r.kind === 'item' ? `${r.id}:${r.label}:${r.icon}` : r.kind))
  it('running local, with and without an update; unverified; not running (recent, gone tab); shared', () => {
    const m = model([tab('a', { update: '0.32.0' }), tab('b'), tab('u', { state: 'unverified' }), tab('g', { state: 'gone', update: '0.32.0' }),
      { id: 'r1', kind: 'remote', name: 'pilot', state: 'live', verified: true, open: true, link: 'https://pilot.example.com/' }],
    [{ id: 'r_1', name: 'N', folder: '~', lastSeen: 1 }], [{ url: 'https://old.example.com/', host: 'old.example.com', lastSeen: 1, id: 's_b' }])
    expect(rows(m.byId.get('a')!)).toEqual(['open:Open:arrow-right', 'copy-update:Update to 0.32.0:arrow-up', 'sep', 'copy-link:Copy link:link', 'copy-path:Copy path:signpost', 'reveal:Reveal in Finder:folder-open'])
    expect(menuRows(m.byId.get('a')!).find((r) => r.kind === 'item' && r.id === 'copy-update')).toMatchObject({ update: true })
    expect(rows(m.byId.get('b')!)).toEqual(['open:Open:arrow-right', 'sep', 'copy-link:Copy link:link', 'copy-path:Copy path:signpost', 'reveal:Reveal in Finder:folder-open'])
    expect(rows(m.byId.get('u')!)).toEqual(['open:Open:arrow-right'])
    const stopped = ['copy-start:Copy start command:copy', 'sep', 'copy-link:Copy link:link', 'copy-path:Copy path:signpost', 'reveal:Reveal in Finder:folder-open']
    expect(rows(m.byId.get('g')!)).toEqual(stopped)
    expect(rows(m.byId.get('r_1')!)).toEqual(stopped)
    expect(rows(m.byId.get('r1')!)).toEqual(['open:Open:arrow-right', 'sep', 'copy-link:Copy link:link'])
    expect(rows(m.byId.get('s_b')!)).toEqual(['open:Open:arrow-right', 'sep', 'copy-link:Copy link:link'])
  })

  it('D8.2: running and shared cards open on a click; a not-running card opens its menu', () => {
    const m = model([tab('a'), tab('g', { state: 'gone' })], [{ id: 'r_1', name: 'N', folder: '~', lastSeen: 1 }], [{ url: 'https://old.example.com/', host: 'old.example.com', lastSeen: 1, id: 's_b' }])
    expect(['a', 'g', 'r_1', 's_b'].map((id) => m.byId.get(id)!.opens)).toEqual([true, false, false, true])
  })
})

describe('D10, D8.5, D3', () => {
  it('the empty state: no local canvas tab, no recent and no shared canvas, open or past', () => {
    expect(model([]).empty).toBe(true)
    expect(model([{ id: 's', kind: 'settings', name: 'Settings', state: 'live', verified: true, open: true }]).empty).toBe(true)
    expect(model([tab('g', { state: 'gone' })]).empty).toBe(false)
    expect(model([], [{ id: 'r_1', name: 'N', folder: '~', lastSeen: 1 }]).empty).toBe(false)
    expect(model([], [], [{ url: 'https://old.example.com/', host: 'old.example.com', lastSeen: 1, id: 's_b' }]).empty).toBe(false)
  })
  it('the view: Board unless Grid was kept', () => {
    expect([viewOf(null), viewOf('grid'), viewOf('board'), viewOf('cards')]).toEqual(['board', 'grid', 'board', 'board'])
  })
  it('a deep link\'s folder: the last segment of its ws', () => {
    expect([deepFolder('/Users/nic/abs'), deepFolder('/abs/'), deepFolder('/')]).toEqual(['abs', 'abs', '/'])
  })
})
