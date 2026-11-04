import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanPageRecord } from '../src/server/perf.ts'
import { CMD_BOUNDS, encodeCmds, WRITER_HEADERS } from '../src/shared/perf-records.ts'
import type { canvasCtl } from '../src/client/shell/canvas/ctl.ts'
import type { Answered, LoadPhase, perfSeams } from '../src/client/shell/recorder-seams.ts'

/**
 * Spec 30 #48-#51's engine, unit by unit (`commands.ts`), with the page's records caught at `perfSeams.record`: the
 * lifecycle a command declares; outcomes bound to their signals; a deadline's `unobserved` and a `late` completion; a
 * load's way mapped to #49's outcomes; a board write's answer through `x-mv-cmds`; the rate bound; relays. The browser
 * cases (test/r30-commands-browser.test.ts) drive real input at the same engine.
 */

type Rec = Record<string, any>
let records: Rec[] = []
let C: typeof import('../src/client/shell/commands.ts')
const seen = (name?: string) => records.filter((r) => r.kind === 'cmd' && (!name || r.cmd === name))
const fake = { rafs: [] as FrameRequestCallback[] }
const frame = () => { const q = fake.rafs; fake.rafs = []; for (const fn of q) fn(performance.now()) }
const frames = (n: number) => { for (let i = 0; i < n; i++) frame() }
const turn = async () => { await Promise.resolve(); await Promise.resolve() }

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  records = []
  fake.rafs = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fake.rafs.push(fn); return fake.rafs.length })
  vi.stubGlobal('document', { getElementById: () => null })
  vi.stubGlobal('sessionStorage', (() => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } })())
  vi.stubGlobal('window', {})
  const seams = await import('../src/client/shell/recorder-seams.ts')
  seams.perfSeams.on = true
  seams.perfSeams.record = (kind, body) => { records.push({ kind, ...body }) }
  C = await import('../src/client/shell/commands.ts')
  C.startCommands()
  seamsNow = seams.perfSeams
  ctlNow = (await import('../src/client/shell/canvas/ctl.ts')).canvasCtl
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
let seamsNow: typeof perfSeams
let ctlNow: typeof canvasCtl
const load = (p: LoadPhase) => seamsNow.load.emit(p)
const answered = (a: Partial<Answered> & { url: string }) => seamsNow.answered.emit({ init: {}, headers: undefined, status: 200, ms: 1, ...a })
const KEY = { via: 'key', in: 'shell', keys: 'c' } as const
const CLICK = { via: 'click', in: 'shell' } as const

describe('the lifecycle a command declares (#48)', () => {
  it('a start at the input, an end after its signal, one id and the ms from the input', async () => {
    const h = C.cmd('copy-path', KEY)
    expect(h.id).toMatch(/^[0-9a-f]{12}$/)
    await turn()
    expect(seen()).toEqual([{ kind: 'cmd', phase: 'start', id: h.id, cmd: 'copy-path', via: 'key', in: 'shell', keys: 'c' }])
    vi.advanceTimersByTime(250)
    h.done()
    expect(seen()[1]).toMatchObject({ phase: 'end', id: h.id, cmd: 'copy-path', outcome: 'done' })
    expect(seen()[1].ms).toBeGreaterThanOrEqual(250)
    expect(seen()[1].via, 'the end carries only the result').toBeUndefined()
  })
  it('a `once` name writes one record, with its input and its result', async () => {
    C.cmd('mention-pick', { via: 'key', in: 'shell', keys: 'Enter' }).done()
    await turn()
    expect(seen()).toHaveLength(1)
    expect(seen()[0]).toMatchObject({ phase: 'once', cmd: 'mention-pick', via: 'key', keys: 'Enter', outcome: 'done' })
  })
  it('a noop decided in its input\'s own turn is one `once`; decided later, it ends the start', async () => {
    C.cmd('copy-path', KEY).noop('no-selection')
    await turn()
    expect(seen()).toHaveLength(1)
    expect(seen()[0]).toMatchObject({ phase: 'once', cmd: 'copy-path', outcome: 'noop', why: 'no-selection', keys: 'c' })
    records = []
    const h = C.cmd('tidy', KEY)
    await turn()
    h.noop('nothing-moved')
    expect(seen().map((r) => r.phase)).toEqual(['start', 'end'])
  })
  it('a same-turn failure still writes a start, then its end', async () => {
    C.cmd('goto', CLICK).fail('no-target')
    await turn()
    expect(seen().map((r) => [r.phase, r.outcome])).toEqual([['start', undefined], ['end', 'failed']])
  })
  it('the first end wins; later calls write nothing', async () => {
    const h = C.cmd('copy-path', KEY)
    await turn()
    h.done(); h.fail('clipboard-blocked'); h.noop('x'); h.cancel(); h.unobserved('y')
    expect(seen().filter((r) => r.phase === 'end')).toHaveLength(1)
  })
  it('nothing records before the recorder starts, nor while it is off', async () => {
    seamsNow.on = false
    const h = C.cmd('panel', CLICK)
    expect(h.id).toBe('')
    h.done()
    await turn()
    expect(seen()).toEqual([])
  })
})

describe('signals (#49)', () => {
  it('2 rAF: the end comes two animation frames later, never before', async () => {
    C.cmd('panel', CLICK)
    await turn()
    frame()
    expect(seen().map((r) => r.phase)).toEqual(['start'])
    frame()
    expect(seen().map((r) => [r.phase, r.outcome])).toEqual([['start', undefined], ['end', 'done']])
  })
  it('a page that draws nothing: 2 rAF never comes and the deadline says so', async () => {
    C.cmd('panel', CLICK)
    await turn()
    vi.advanceTimersByTime(10_000)
    expect(seen().at(-1)).toMatchObject({ phase: 'end', outcome: 'unobserved', why: 'deadline' })
  })
  it('a completion after the deadline is a second end with `late`; a cancel after it is not written', async () => {
    const h = C.cmd('copy-image', KEY)
    await turn()
    vi.advanceTimersByTime(60_000)
    h.done()
    expect(seen().filter((r) => r.phase === 'end').map((r) => [r.outcome, r.late])).toEqual([['unobserved', undefined], ['done', true]])
    const g = C.cmd('copy-path', KEY)
    await turn()
    vi.advanceTimersByTime(10_000)
    g.cancel()
    expect(seen('copy-path').filter((r) => r.phase === 'end').map((r) => r.outcome)).toEqual(['unobserved'])
  })
  it('I with a 20 s render is done, never unobserved: its deadline is a minute', async () => {
    const h = C.cmd('copy-image', KEY)
    await turn()
    vi.advanceTimersByTime(20_000)
    h.done()
    expect(seen().filter((r) => r.phase === 'end')).toEqual([expect.objectContaining({ outcome: 'done' })])
  })
  it('the camera: done once it flew and came to rest; or rested for 250 ms', async () => {
    const busy = vi.fn(() => true)
    ctlNow.cameraBusy = busy
    C.cmd('fit-all', KEY)
    await turn()
    frames(3)
    expect(seen().map((r) => r.phase)).toEqual(['start'])
    busy.mockReturnValue(false)
    frames(1)
    expect(seen().at(-1)).toMatchObject({ phase: 'end', outcome: 'done' })
    records = []
    C.cmd('zoom-100', KEY)
    await turn()
    frames(3)
    expect(seen().map((r) => r.phase)).toEqual(['start'])
    vi.advanceTimersByTime(300)
    frames(1)
    expect(seen().at(-1)).toMatchObject({ phase: 'end', outcome: 'done' })
  })
  it('a stage screen: its own `at` ends it; a stage error fails only the commands that list it', async () => {
    const h = C.cmd('play-next', KEY)
    C.endOnStage(h, 'scene/b')
    await turn()
    seamsNow.stageMessage.emit({ type: 'sh:stage-shown', at: 'scene/a' })
    expect(seen('play-next').map((r) => r.phase)).toEqual(['start'])
    seamsNow.stageMessage.emit({ type: 'sh:stage-shown', at: 'scene/b' })
    expect(seen('play-next').at(-1)).toMatchObject({ phase: 'end', outcome: 'done' })
    C.cmd('play', KEY)
    await turn()
    seamsNow.stageMessage.emit({ type: 'sh:stage-error', message: 'boom' })
    expect(seen('play').at(-1)).toMatchObject({ phase: 'end', outcome: 'failed', why: 'stage-error' })
  })
  it('a frame reload: its node\'s next `sh:ready` is done, its `sh:error` fails, another node\'s says nothing', async () => {
    const h = C.cmd('frame-reload', CLICK)
    C.endOnReady(h, 'n1')
    await turn()
    seamsNow.frameMessage.emit('n2', { type: 'sh:ready' })
    expect(seen().map((r) => r.phase)).toEqual(['start'])
    seamsNow.frameMessage.emit('n1', { type: 'sh:error' })
    expect(seen().at(-1)).toMatchObject({ outcome: 'failed', why: 'error' })
  })
  it('`shell-reload`: the next page writes the end with the id it kept', async () => {
    C.shellReload(C.cmd('shell-reload', CLICK))
    const was = seen()[0].id
    expect(seen()[0]).toMatchObject({ phase: 'start', cmd: 'shell-reload' })
    records = []
    vi.resetModules()
    const seams = await import('../src/client/shell/recorder-seams.ts')
    seams.perfSeams.on = true
    seams.perfSeams.record = (kind, body) => { records.push({ kind, ...body }) }
    ;(await import('../src/client/shell/commands.ts')).startCommands()
    expect(seen()).toEqual([expect.objectContaining({ phase: 'end', id: was, cmd: 'shell-reload', outcome: 'done' })])
  })
})

describe('the mode and theme records end their commands (signals\' `by`, #23, #25)', () => {
  const asSignals = () => { seamsNow.transition = () => 'cafecafecafe' }
  it('C waits for its own mode: another mode\'s record does not end it', async () => {
    asSignals()
    const h = C.cmd('comments', KEY)
    await turn()
    seamsNow.record('mode', { mode: 'laser', phase: 'exit', t: 't', by: h.id })
    expect(seen('comments').map((r) => r.phase)).toEqual(['start'])
    seamsNow.record('mode', { mode: 'comments', phase: 'enter', t: 't', by: h.id, outcome: 'done', shownMs: 12 })
    expect(seen('comments').at(-1)).toMatchObject({ phase: 'end', outcome: 'done' })
  })
  it('a timed-out or superseded mode says so: unobserved, cancelled', async () => {
    asSignals()
    const a = C.cmd('laser', KEY)
    await turn()
    seamsNow.record('mode', { mode: 'laser', phase: 'enter', by: a.id, outcome: 'timeout' })
    expect(seen('laser').at(-1)).toMatchObject({ outcome: 'unobserved', why: 'timeout' })
    const b = C.cmd('inspect', KEY)
    await turn()
    seamsNow.record('mode', { mode: 'inspect', phase: 'enter', by: b.id, outcome: 'superseded' })
    expect(seen('inspect').at(-1)).toMatchObject({ outcome: 'cancelled', why: 'superseded' })
  })
  it('without a `by`, only the one command that could be waiting takes it', async () => {
    asSignals()
    C.cmd('theme', KEY); C.cmd('theme', KEY)
    await turn()
    seamsNow.record('theme', { t: 't', outcome: 'done' })
    expect(seen('theme').filter((r) => r.phase === 'end')).toEqual([])
  })
  it('the theme record\'s outcome ends `theme`', async () => {
    asSignals()
    const h = C.cmd('theme', KEY)
    await turn()
    seamsNow.record('theme', { t: 't', by: h.id, outcome: 'done', frames: 3 })
    expect(seen('theme').at(-1)).toMatchObject({ phase: 'end', outcome: 'done' })
  })
  it('with the signals stream on, a mode command does not end at 2 rAF: without it, it does', async () => {
    C.cmd('comments', KEY)
    await turn()
    frames(2)
    expect(seen('comments').at(-1)).toMatchObject({ phase: 'end', outcome: 'done' })
    records = []
    asSignals()
    C.cmd('comments', KEY)
    await turn()
    frames(2)
    expect(seen('comments').map((r) => r.phase)).toEqual(['start'])
  })
  it('laser-comment has no mode record: with no document posted it is done at 2 rAF; else at the last document\'s ack', async () => {
    asSignals()
    const none = C.cmd('laser-comment', KEY)
    await turn()
    frames(2)
    expect(seen('laser-comment').at(-1)).toMatchObject({ id: none.id, phase: 'end', outcome: 'done' })
    // a page whose signals stream mints: the wrapper goes on at start, around the stream's own
    records = []
    vi.resetModules()
    const seams = await import('../src/client/shell/recorder-seams.ts')
    const fresh = await import('../src/client/shell/commands.ts')
    seams.perfSeams.on = true
    seams.perfSeams.record = (kind, body) => { records.push({ kind, ...body }) }
    seams.perfSeams.transition = () => 'tttttttttttt'
    fresh.startCommands()
    fresh.cmd('laser-comment', KEY)
    seams.perfSeams.transition('mode')
    seams.perfSeams.transition('mode')   // two documents posted
    await turn()
    frames(2)
    expect(seen('laser-comment').map((r) => r.phase)).toEqual(['start'])
    seams.perfSeams.frameMessage.emit('n1', { type: 'sh:mode-applied', t: 'tttttttttttt', boot: 'b1' })
    seams.perfSeams.frameMessage.emit('n1', { type: 'sh:mode-applied', t: 'other', boot: 'b9' })
    expect(seen('laser-comment').map((r) => r.phase)).toEqual(['start'])
    seams.perfSeams.frameMessage.emit('n2', { type: 'sh:mode-applied', t: 'tttttttttttt', boot: 'b2' })
    expect(seen('laser-comment').at(-1)).toMatchObject({ phase: 'end', outcome: 'done' })
  })
})

describe('a load\'s way (#49)', () => {
  const open = async () => {
    const h = C.cmd('board-open', { ...CLICK, board: 'two' })
    await turn()
    load({ phase: 'request', load: 'L1', board: 'two', cause: 'switch' })
    return h
  }
  const ends = () => seen('board-open').filter((r) => r.phase === 'end')
  it('board-open: visible and visibleReady in its steps, done at settled', async () => {
    await open()
    load({ phase: 'visible', load: 'L1', nodes: 3 })
    vi.advanceTimersByTime(40)
    load({ phase: 'visible-ready', load: 'L1' })
    load({ phase: 'settled', load: 'L1' })
    expect(ends()).toHaveLength(1)
    expect(ends()[0]).toMatchObject({ outcome: 'done' })
    expect(ends()[0].steps.map((s: Rec) => s.name)).toEqual(['visible', 'visible-ready'])
  })
  it('another load\'s phases say nothing of it', async () => {
    await open()
    load({ phase: 'settled', load: 'OTHER' })
    expect(ends()).toEqual([])
  })
  it.each([
    ['hidden', 'unobserved', 'hidden'], ['timeout', 'unobserved', 'timeout'],
    ['switch', 'cancelled', 'switch'], ['reload', 'cancelled', 'reload'], ['superseded', 'cancelled', 'superseded'], ['edited', 'cancelled', 'edited'],
    ['unsaved', 'failed', 'save-blocked'], ['error', 'failed', 'load-error'],
  ] as const)('a cut `%s` ends it %s %s', async (reason, outcome, why) => {
    await open()
    load({ phase: 'cut', load: 'L1', reason })
    expect(ends()).toEqual([expect.objectContaining({ outcome, why })])
  })
  it('hidden: a late commit is a step and leaves it unobserved; only an observed settle writes a `late` done', async () => {
    await open()
    load({ phase: 'cut', load: 'L1', reason: 'hidden', request: true })
    expect(ends().map((r) => r.outcome)).toEqual(['unobserved'])
    load({ phase: 'commit', load: 'L1', late: true })
    expect(ends()).toHaveLength(1)
    load({ phase: 'settled', load: 'L1' })
    expect(ends().map((r) => [r.outcome, r.late])).toEqual([['unobserved', undefined], ['done', true]])
    expect(ends()[1].steps.map((s: Rec) => s.name)).toEqual(['commit-late'])
  })
  it('a goto\'s end is the target board\'s `visible`', async () => {
    const h = C.cmd('goto', CLICK)
    C.endOnLoad(h, 'two', 'visible')
    await turn()
    load({ phase: 'request', load: 'L2', board: 'two', cause: 'switch' })
    load({ phase: 'visible', load: 'L2', nodes: 1 })
    expect(seen('goto').at(-1)).toMatchObject({ phase: 'end', outcome: 'done' })
  })
})

describe('board writes (#18, #49)', () => {
  const moved = async (board = 'main') => {
    const h = C.cmd('frame-move', { via: 'drag', in: 'shell' })
    C.endOnSave(h, board)
    await turn()
    return h
  }
  const ends = () => seen('frame-move').filter((r) => r.phase === 'end').map((r) => [r.outcome, r.why])
  it('a save carries every command since the last, at most 8 ids and their count; once', async () => {
    const hs = []
    for (let i = 0; i < 10; i++) hs.push(await moved())
    const w = C.cmdsForWrite('main', 'boards/main')
    expect(w.n).toBe(10)
    expect(w.ids).toEqual(hs.slice(0, CMD_BOUNDS.writeIds).map((h) => h.id))
    expect(C.cmdsForWrite('main', 'boards/main')).toEqual({ ids: [], n: 0 })
  })
  it('another write carries the command behind it, never the save\'s', async () => {
    await moved()
    const h = C.cmd('board-status', CLICK)
    expect(C.cmdsForWrite('main', 'boards/status').ids).toEqual([h.id])
    expect(C.cmdsForWrite('main', 'boards/main').n, 'the save carries the move, not the status change').toBe(1)
  })
  it('a command that ends elsewhere is still named by the save that carries it', async () => {
    const h = C.cmd('tidy', KEY)
    C.foldsIntoSave(h)
    expect(C.cmdsForWrite('main', 'boards/main')).toEqual({ ids: [h.id], n: 1 })
    expect(C.cmdsForWrite('main', 'boards/main')).toEqual({ ids: [], n: 0 })
  })
  it('the save\'s answer ends what its header carries: done, 409 save-conflict, else save-failed', async () => {
    for (const [status, want] of [[200, ['done', undefined]], [409, ['failed', 'save-conflict']], [500, ['failed', 'save-failed']], [0, ['failed', 'save-failed']], ['timeout', ['failed', 'save-failed']]] as const) {
      records = []
      const h = await moved()
      answered({ url: '/__mv/api/boards/main', init: { method: 'PUT' }, status, headers: { [WRITER_HEADERS.cmds]: encodeCmds({ ids: [h.id], n: 1 }) } })
      expect(ends(), String(status)).toEqual([want])
    }
  })
  it('a save its header does not name leaves a command waiting', async () => {
    const h = await moved()
    const other = C.cmd('frame-resize', { via: 'drag', in: 'shell' })
    C.endOnSave(other, 'main')
    await turn()
    answered({ url: '/__mv/api/boards/main', init: { method: 'PUT' }, headers: { [WRITER_HEADERS.cmds]: encodeCmds({ ids: [other.id], n: 1 }) } })
    expect(ends()).toEqual([])
    expect(h.id).not.toBe(other.id)
  })
  it('a page whose writes name nothing: the board\'s save ends those waiting before it was sent, no other', async () => {
    await moved()
    vi.advanceTimersByTime(50)
    answered({ url: '/__mv/api/boards/main', init: { method: 'PUT' }, ms: 10 })
    expect(ends()).toEqual([['done', undefined]])
    records = []
    await moved()   // after the request below was sent
    answered({ url: '/__mv/api/boards/main', init: { method: 'PUT' }, ms: 10_000 })
    expect(ends()).toEqual([])
    answered({ url: '/__mv/api/boards/other', init: { method: 'PUT' }, ms: 0 })
    answered({ url: '/__mv/api/boards/main', init: { method: 'GET' }, ms: 0 })
    expect(ends()).toEqual([])
  })
  it('`endOnAnswer`: the answer to that path, ok or `failed` with the code', async () => {
    const h = C.cmd('mark-seen', CLICK)
    C.endOnAnswer(h, 'marks/seen')
    await turn()
    answered({ url: '/__mv/api/other', ms: 0 })
    expect(seen('mark-seen').map((r) => r.phase)).toEqual(['start'])
    answered({ url: '/__mv/api/marks/seen', ms: 0, status: 500 })
    expect(seen('mark-seen').at(-1)).toMatchObject({ phase: 'end', outcome: 'failed', why: 'api' })
  })
})

describe('provenance (#50, #51)', () => {
  it('a relayed menu item: the key handler says `key`; it is recorded once, `relay`, with the menu it came from', async () => {
    C.relayed('tab-menu', () => { C.cmd('comments', { via: 'key', in: 'shell', keys: 'c' }) })
    await turn()
    expect(seen('comments')[0]).toMatchObject({ via: 'relay', in: 'tab-menu', keys: 'c' })
    records = []
    C.cmd('comments', { via: 'key', in: 'shell', keys: 'c' })
    await turn()
    expect(seen('comments')[0]).toMatchObject({ via: 'key', in: 'shell' })
  })
  it('`keys` only for a key or a relay; a click carries none', async () => {
    C.cmd('panel', { via: 'click', in: 'shell', keys: 'x' })
    await turn()
    expect(seen('panel')[0].keys).toBeUndefined()
  })
  it('`keysOf` writes the combination as descriptor() does', () => {
    expect(C.keysOf({ key: 'P', shiftKey: true })).toBe('Shift+p')
    expect(C.keysOf({ key: '\\', metaKey: true })).toBe('Meta+\\')
    expect(C.keysOf({ key: '¬', altKey: true }, 'l')).toBe('Alt+l')
    expect(C.keysOf({ key: ')', shiftKey: true }, '0')).toBe('Shift+0')
    expect(C.keysOf({ key: 'Escape' })).toBe('Escape')
    expect(C.keysOf({ key: ' ' })).toBe('Space')
    expect(C.keysOf({ key: 'a', ctrlKey: true, metaKey: true, altKey: true, shiftKey: true })).toBe('Ctrl+Meta+Alt+Shift+a')
  })
  it('`by`: the command names the rest of its task, and an effect later in its chain through withCmd', async () => {
    const h = C.cmd('panel', CLICK)
    expect(C.currentCmd()).toBe(h.id)
    await turn()
    expect(C.currentCmd(), 'React\'s commit of the change runs in this task').toBe(h.id)
    vi.advanceTimersByTime(1)
    expect(C.currentCmd()).toBeUndefined()
    expect(C.withCmd(h.id, () => C.currentCmd())).toBe(h.id)
    expect(C.currentCmd()).toBeUndefined()
  })
})

describe('bounds (#48)', () => {
  it('starts: a burst of 20, then 10 a second; what is refused is counted once', async () => {
    const ids: string[] = []
    for (let i = 0; i < 30; i++) { const h = C.cmd('copy-path', KEY); if (h.id) ids.push(h.id) }
    expect(ids).toHaveLength(CMD_BOUNDS.burst)
    await turn()
    expect(records.filter((r) => r.kind === 'dropped')).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(records.filter((r) => r.kind === 'dropped')).toEqual([{ kind: 'dropped', n: 10, reason: 'cmd' }])
    expect(C.cmd('copy-path', KEY).id, 'a second later the bucket refilled').toBeTruthy()
  })
})

describe('the server\'s cleaner keeps what a command says, nothing else (#4)', () => {
  const env = { v: 1, ws: 'a'.repeat(16), page: 'b'.repeat(12), load: '-', seq: 1, ts: Date.now(), kind: 'cmd' }
  const id = 'c'.repeat(12)
  it('start, end and once survive it whole', () => {
    expect(cleanPageRecord({ ...env, phase: 'start', id, cmd: 'copy-path', via: 'key', keys: 'Shift+p', in: 'shell', board: 'main', frames: 2, frame: 'app/home' }))
      .toMatchObject({ phase: 'start', id, cmd: 'copy-path', via: 'key', keys: 'Shift+p', in: 'shell', board: 'main', frames: 2, frame: 'app/home' })
    expect(cleanPageRecord({ ...env, phase: 'end', id, cmd: 'board-open', outcome: 'unobserved', why: 'hidden', ms: 12, steps: [{ name: 'visible', ms: 3 }], late: true }))
      .toMatchObject({ phase: 'end', outcome: 'unobserved', why: 'hidden', ms: 12, steps: [{ name: 'visible', ms: 3 }], late: true })
    expect(cleanPageRecord({ ...env, phase: 'once', id, cmd: 'mention-pick', via: 'key', keys: 'Enter', in: 'shell', outcome: 'done', ms: 0 }))
      .toMatchObject({ phase: 'once', outcome: 'done' })
  })
  it('a named key, a control key and a symbol pass; a word does not', () => {
    for (const keys of ['Escape', 'ArrowRight', 'Meta+\\', 'Meta+/', 'Ctrl+Tab', 'Alt+l', 'Shift+0', 'Space', '[']) {
      expect(cleanPageRecord({ ...env, phase: 'start', id, cmd: 'x', via: 'key', in: 'shell', keys })?.keys, keys).toBe(keys)
    }
    expect(cleanPageRecord({ ...env, phase: 'start', id, cmd: 'x', via: 'key', in: 'shell', keys: 'hello world' })?.keys).toBeUndefined()
    expect(cleanPageRecord({ ...env, phase: 'start', id, cmd: 'x', via: 'key', in: 'shell', keys: 'password' })?.keys).toBeUndefined()
  })
  it('a field it does not know, or free text where an identifier goes, never reaches the file', () => {
    const SENTINEL = 'SENTINEL secret words'
    const r = cleanPageRecord({ ...env, phase: 'once', id, cmd: 'comment-send', via: 'click', in: 'shell', outcome: 'failed', why: SENTINEL, arg: SENTINEL, text: SENTINEL, value: SENTINEL, board: SENTINEL, frame: SENTINEL, ms: 1, steps: [{ name: SENTINEL, ms: 1 }] })
    expect(r).toBeTruthy()
    expect(JSON.stringify(r)).not.toContain('SENTINEL')
  })
  it('without its identity, a record is dropped', () => {
    expect(cleanPageRecord({ ...env, phase: 'start', cmd: 'x', via: 'key', in: 'shell' })).toBeNull()
    expect(cleanPageRecord({ ...env, phase: 'start', id, cmd: 'Not A Name', via: 'key', in: 'shell' })).toBeNull()
    expect(cleanPageRecord({ ...env, phase: 'start', id, cmd: 'x', via: 'nope', in: 'shell' })).toBeNull()
    expect(cleanPageRecord({ ...env, phase: 'end', id, cmd: 'x', outcome: 'nope', ms: 1 })).toBeNull()
  })
})
