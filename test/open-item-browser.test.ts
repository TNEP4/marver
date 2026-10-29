import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { appendEvents, type CommentEvent } from '../src/server/comments.ts'
import { liveId } from '../src/server/app-live.ts'
import type { OpenItem } from '../src/shared/app-api.ts'

/**
 * A notice's click in the shell (spec 28 A4.6 #29, #30; r1 #1-#3, r2 #1, #2, r3, r4 #1; the opening cases of #52), against
 * a REAL `marver dev` and a REAL Chrome whose page gets a fake `window.marverApp` with `onOpen` before any script runs.
 * The threads are real comment logs on the server; the Jam queue is the page's own script - its `jam/queue` read answers
 * a view the case writes from the queue's transitions, and its `jam/card` and `jam/run` actions are recorded and moved
 * on by the case (the server runs no Jam here, so nothing pushes over that view). Each kind `handled`, with its surface
 * drawn and its controls usable; stale clicks opening the target as it stands; `missing` opening the board; `busy` with a
 * capture recording or words unsent, nothing moved; `dropped` for a later click, a hidden tab, a failed read; Play left
 * first. Skips without Chrome.
 */

const FRAME = (t: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>${t}</h1></main>\n`
let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
const tabs: string[] = []

beforeAll(async () => {
  root = fixtureRoot('mv-open-', {
    'design/config.ts': 'export default { jam: false }\n',
    'design/scenes/demo/one.tsx': FRAME('One'),
    'design/scenes/demo/two.tsx': FRAME('Two'),
    'design/scenes/demo/three.tsx': FRAME('Three'),
    'design/scenes/demo/four.tsx': FRAME('Four'),
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 },
      { key: 'n-two', frame: 'demo/two', x: 600, y: 0, w: 390, h: 844 },
    ] }),
    'design/boards/other.json': JSON.stringify({ version: 1, name: 'other', order: 1, auto: false, nodes: [{ key: 'n-three', frame: 'demo/three', x: 0, y: 0, w: 390, h: 844 }] }),
    // demo/four is on no board: a thread on it has no card to draw in
    'design/boards/side.json': JSON.stringify({ version: 1, name: 'side', order: 2, auto: false, nodes: [] }),
  })
  dev = await startDev(root)
  browser = await Browser.launch()
}, 120_000)
afterEach(async () => { for (const s of tabs.splice(0)) await browser?.closeTab(s).catch(() => {}) })
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

/** The fake bridge with `onOpen`, and the page's own Jam queue: a view the case sets, its actions recorded. */
const FAKE = (o: { onOpen: boolean }) => `(() => {
  const realFetch = window.fetch.bind(window)
  const q = window.__q = { view: { agent: 'claude', cards: [] }, n: 0, fail: false, commentsFail: false, hold: null, release: null, acts: [], posts: [], onAct: null }
  q.gate = () => { q.hold = new Promise((r) => { q.release = () => { q.hold = null; r(); return 1 } }); return 1 }
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
  window.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input)
    const path = url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0]
    const method = (init && init.method) || 'GET'
    if (path === '/__mv/api/jam/queue') { if (q.hold) await q.hold; return q.fail ? json({ error: 'no queue' }, 500) : json({ ...q.view, seq: { boot: 'page', n: ++q.n } }) }
    if (path === '/__mv/api/jam/card' || path === '/__mv/api/jam/run') {
      const body = JSON.parse(init.body); const kind = path.slice('/__mv/api/jam/'.length)
      q.acts.push([kind, body]); if (q.onAct) q.onAct(kind, body)
      return json({ ok: true })
    }
    if (path.startsWith('/__mv/api/comments/') && method === 'GET') { if (q.hold) await q.hold; if (q.commentsFail) return json({ error: 'no' }, 500) }
    if (path.startsWith('/__mv/api/comments/') && method === 'POST') q.posts.push(JSON.parse(init.body))
    return realFetch(input, init)
  }
  const appState = new Set(); let opener = null
  const api = { v: 1, topInset: 0, hello() {}, theme() {}, busy() {}, menu() {},
    onAppState: (fn) => { appState.add(fn); return () => appState.delete(fn) },
    onMenuClick: () => () => {} }
  if (${o.onOpen}) api.onOpen = (fn) => { opener = fn; return () => { opener = null } }
  window.marverApp = Object.freeze(api)
  const pending = []
  window.__fake = {
    /** main's mv:open: the shell's answer */
    open: (item) => opener ? Promise.resolve(opener(item)) : Promise.resolve('no-opener'),
    /** one left running: its answer later, by its index */
    start: (item) => pending.push(opener(item)) - 1,
    result: (i) => pending[i],
    state: (s) => { for (const fn of appState) fn(s); return appState.size },
    opener: () => !!opener,
  }
})()`

/** A tab of its own, the fake installed, the canvas loaded on `hash` and its board shown. */
async function open(hash = '#/b/main', o: { onOpen?: boolean; view?: object; fail?: boolean } = {}) {
  const s = await browser!.tab({ width: 1400, height: 900 })
  tabs.push(s)
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE({ onOpen: o.onOpen !== false }) }, s)
  if (o.view || o.fail) await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__q.view = ${JSON.stringify(o.view ?? { agent: 'claude', cards: [] })}; window.__q.fail = ${!!o.fail}` }, s)
  await browser!.go(s, 'about:blank')
  await browser!.go(s, `${dev!.origin}/${hash}`)
  await browser!.until(s, `!!window.__mvStore && __mvStore.getState().nodes.length > 0 && __mvStore.getState().nodes.every((n) => n.status === 'ready') && !!window.__mvOpen && !!window.__mvJamQueue`, 30_000)
  await browser!.send('Page.bringToFront', {}, s)
  await browser!.eval(s, `window.__mvJamVoice?.getState().setChoice('no'), 1`)
  return {
    s,
    ev: (js: string) => browser!.eval(s, js),
    until: (js: string, ms = 10_000) => browser!.until(s, js, ms),
    open: (item: OpenItem): Promise<string> => browser!.eval(s, `__fake.open(${JSON.stringify(item)})`),
    has: (sel: string): Promise<boolean> => browser!.eval(s, `!!document.querySelector(${JSON.stringify(sel)})`),
    /** words typed into the field `sel` as a person types them (trusted input events) */
    type: async (sel: string, text: string) => {
      await browser!.eval(s, `document.querySelector(${JSON.stringify(sel)}).focus(), 1`)
      await browser!.send('Input.insertText', { text }, s)
    },
    click: (sel: string) => browser!.eval(s, `document.querySelector(${JSON.stringify(sel)}).click(), 1`),
    board: (): Promise<string> => browser!.eval(s, `__mvStore.getState().board`),
    /** the page's scripted Jam queue: the cards the next read answers */
    view: (cards: object[], extra: object = {}) => browser!.eval(s, `window.__q.view = ${JSON.stringify({ agent: 'claude', cards, ...extra })}, 1`),
    push: (cards: object[]) => browser!.eval(s, `__mvJamQueue.getState().apply(${JSON.stringify({ agent: 'claude', cards, seq: { boot: 'case', n: Date.now() } })}), 1`),
  }
}
const skip = (ctx: { skip: () => void }) => { if (!browser) ctx.skip() }

// ---- the threads, real comment logs --------------------------------------------------------------------------

let t0 = Date.now() - 3600_000
let seq = 0
const uid = (p: string) => `${p}-${++seq}-${Math.random().toString(36).slice(2, 7)}`
const OWNER = { name: 'Nic' }
/** A thread on `board`, Marver's last word asking: its thread id, the create event's id and the asking message's id. */
function asking(board: string, o: { frame?: string; node?: string; capture?: string; body?: string; question?: string; then?: 'answered' | 'resolved' } = {}) {
  const thread = uid('t'), create = uid('e'), msg = uid('r')
  const evs: CommentEvent[] = [
    { id: create, ts: ++t0, type: 'create', commentId: thread, board, ...(o.frame ? { frame: o.frame, nodeKey: o.node ?? o.frame } : {}), author: OWNER, body: o.body ?? 'make it blue', ...(o.capture ? { capture: o.capture } : {}) },
    { id: uid('e'), ts: ++t0, type: 'reply', commentId: msg, parentId: thread, board, agent: true, asks: true, body: o.question ?? 'Which blue?' },
  ]
  if (o.then === 'answered') evs.push({ id: uid('e'), ts: ++t0, type: 'reply', commentId: uid('r'), parentId: thread, board, author: OWNER, body: 'the light one' })
  if (o.then === 'resolved') evs.push({ id: uid('e'), ts: ++t0, type: 'resolve', commentId: thread, board })
  appendEvents(join(root, 'design', 'comments'), board, evs)
  return { thread, create, msg }
}
/** A thread you started on a frame, nothing from Marver yet - a tag's: its thread and its create event. */
function tagged(board: string, o: { frame?: string; node?: string; resolved?: boolean } = {}) {
  const thread = uid('t'), create = uid('e')
  appendEvents(join(root, 'design', 'comments'), board, [
    { id: create, ts: ++t0, type: 'create', commentId: thread, board, ...(o.frame ? { frame: o.frame, nodeKey: o.node ?? o.frame } : {}), author: OWNER, body: '@marver make it blue' },
    ...(o.resolved ? [{ id: uid('e'), ts: ++t0, type: 'resolve' as const, commentId: thread, board }] : []),
  ])
  return { thread, create }
}
const askItem = (board: string, t: { thread: string; msg: string }, cards?: string[]): OpenItem => ({ id: liveId('ask', board, t.thread, t.msg), kind: 'ask', board, thread: t.thread, msg: t.msg, ...(cards ? { cards } : {}) })

// ---- the Jam cards, as the queue's view gives them ----------------------------------------------------------

const made = () => ++t0
const capture = (id: string, o: object = {}) => ({ id, kind: 'capture', board: 'main', frames: ['demo/one'], events: [], state: 'queued', rev: 1, made: made(), order: t0, at: Date.now(), title: `Capture ${id}`, ...o })
const comment = (id: string, thread: string, event: string, o: object = {}) => ({ id, kind: 'comment', board: 'main', thread, frames: ['demo/one'], events: [event], state: 'queued', rev: 1, made: made(), order: t0, at: Date.now(), ...o })
const stalled = (batch: string, gen: number, stalls: number, state = 'stalled') => ({ kind: 'session', agent: 'claude', batch, gen, state, stalls })

describe('each kind, handled - its surface drawn (A4.6 #30)', () => {
  it('an ask on another board: the board opens, comments read afresh, its thread card drawn', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('other', { frame: 'demo/three', node: 'n-three' })
    expect(await p.open(askItem('other', t))).toBe('handled')
    expect(await p.board()).toBe('other')
    expect(await p.has(`.cm-card[data-thread="${t.thread}"]`)).toBe(true)
  })

  it('comments hidden by Shift+C: turned on, the thread card mounted (r2 #2)', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('main', { frame: 'demo/two', node: 'n-two' })
    await p.ev(`__mvComments.getState().setShow(false), 1`)
    expect(await p.open(askItem('main', t))).toBe('handled')
    expect(await p.ev(`__mvComments.getState().show`)).toBe(true)
    expect(await p.has(`.cm-card[data-thread="${t.thread}"]`)).toBe(true)
  })

  it('an ask whose Jam card asks and whose thread no frame can show opens the capture panel\'s answer field (0.28\'s fallback)', async (ctx) => {
    skip(ctx)
    const t = asking('main', { capture: 'cap-a1', body: 'this badge' })
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [capture('cap-a1', { state: 'asks', thread: t.thread, frames: [] })] } })
    expect(await p.open(askItem('main', t, ['cap-a1']))).toBe('handled')
    expect(await p.ev(`JSON.stringify(__mvJamUi.getState().panel)`)).toBe(JSON.stringify({ kind: 'capture', id: 'cap-a1' }))
    expect(await p.has('[data-jam-readback] [data-jam-asks] textarea')).toBe(true)
  })

  it('a frameless ask whose capture card still works (an early question): the thread panel, its answer landing in the thread with @marver (r1 #3)', async (ctx) => {
    skip(ctx)
    const t = asking('main', { capture: 'cap-f1', body: 'on an empty board', question: 'A card or a list?' })
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [capture('cap-f1', { state: 'working', thread: t.thread, frames: [] })] } })
    expect(await p.open(askItem('main', t))).toBe('handled')
    const panel = `[data-jam-thread-panel="${t.thread}"]`
    expect(await p.has(`${panel} [data-jam-asks] .at`)).toBe(true)
    expect(await p.ev(`document.querySelector('${panel} [data-jam-thread-last]').textContent`)).toContain('A card or a list?')
    await p.type(`${panel} [data-jam-asks] textarea`, 'a card')
    await p.click(`${panel} .jm-send`)
    await p.until(`__q.posts.some((x) => x.events[0].parentId === ${JSON.stringify(t.thread)})`)
    expect(await p.ev(`__q.posts.find((x) => x.events[0].parentId === ${JSON.stringify(t.thread)}).events[0].body`)).toBe('@marver a card')
  })

  it('an ask whose frame has left its board: the thread panel with the answer field', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('main', { frame: 'demo/four', node: 'n-gone' })
    expect(await p.open(askItem('main', t))).toBe('handled')
    expect(await p.has(`[data-jam-thread-panel="${t.thread}"] [data-jam-asks] textarea`)).toBe(true)
  })

  it('a Marver question on a canvas with Jam off and no host: the thread panel, the answer as typed', async (ctx) => {
    skip(ctx)
    const t = asking('main', { frame: 'demo/four', question: 'Should it scroll?' })
    const p = await open('#/b/main', { fail: true })
    expect(await p.open(askItem('main', t))).toBe('handled')
    const panel = `[data-jam-thread-panel="${t.thread}"]`
    expect(await p.has(`${panel} [data-jam-asks] .at`)).toBe(false)
    await p.type(`${panel} [data-jam-asks] textarea`, 'no, it fits')
    await p.click(`${panel} .jm-send`)
    await p.until(`__q.posts.some((x) => x.events[0].parentId === ${JSON.stringify(t.thread)})`)
    expect(await p.ev(`__q.posts.find((x) => x.events[0].parentId === ${JSON.stringify(t.thread)}).events[0].body`)).toBe('no, it fits')
  })

  it('a review: its review panel; a card not yet in the page\'s queue is found by the fresh read', async (ctx) => {
    skip(ctx)
    const p = await open()
    await p.view([capture('rv-1', { state: 'review', batch: 'b-rv', att: 1 })])   // the server has it; the page not yet
    expect(await p.ev(`(__mvJamQueue.getState().cards ?? []).some((c) => c.id === 'rv-1')`)).toBe(false)
    expect(await p.open({ id: liveId('review', 'rv-1', 1), kind: 'review', board: 'main', cards: ['rv-1'], batch: 'b-rv', occ: 1 })).toBe('handled')
    expect(await p.ev(`JSON.stringify(__mvJamUi.getState().panel)`)).toBe(JSON.stringify({ kind: 'review', id: 'rv-1' }))
    expect(await p.has('[data-jam-focus]')).toBe(true)
  })

  it('a failed capture: its panel with Retry in the footer, and Retry acts', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [capture('fc-1', { state: 'failed', batch: 'b-f', fails: 1, att: 1, note: 'the agent could not finish' })] } })
    expect(await p.open({ id: liveId('failed', 'b-f', 1), kind: 'failed', board: 'main', cards: ['fc-1'], batch: 'b-f', occ: 1 })).toBe('handled')
    expect(await p.has('[data-jam-focus] [data-jam-run-act="retry"]')).toBe(true)
    await p.click('[data-jam-focus] [data-jam-run-act="retry"]')
    await p.until(`__q.acts.some(([k, b]) => k === 'card' && b.id === 'fc-1' && b.action === 'retry')`)
  })

  it('a failed comment card on a hosted thread: its thread card with the status popover open on Retry', async (ctx) => {
    skip(ctx)
    const t = tagged('main', { frame: 'demo/one', node: 'n-one' })
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [comment('cc-1', t.thread, t.create, { state: 'failed', batch: 'b-c', fails: 1, att: 1, note: 'the agent could not finish' })] } })
    expect(await p.open({ id: liveId('failed', 'b-c', 1), kind: 'failed', board: 'main', thread: t.thread, cards: ['cc-1'], batch: 'b-c', occ: 1 })).toBe('handled')
    const pop = `.cm-card[data-thread="${t.thread}"] .cm-tstat.on[data-jam-card="cc-1"]`
    expect(await p.has(pop)).toBe(true)
    await p.click(`${pop} .cm-tstat-act`)
    await p.until(`__q.acts.some(([k, b]) => k === 'card' && b.id === 'cc-1' && b.action === 'retry')`)
  })

  it('a stalled capture: its tile selected and the tile\'s menu open at it, with the three choices', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [capture('sc-1', { state: 'working', batch: 'b-s', runner: stalled('b-s', 3, 1) })] } })
    expect(await p.open({ id: liveId('stalled', 'b-s', 3, 1), kind: 'stalled', board: 'main', cards: ['sc-1'], batch: 'b-s', gen: 3, occ: 1 })).toBe('handled')
    expect(await p.has('.jm-lane .jm-card.focus[data-tile="sc-1"]')).toBe(true)
    expect(await p.ev(`[...document.querySelectorAll('.sh-ctxmenu[data-menu="tile:sc-1"] button')].map((b) => b.textContent)`))
      .toEqual(expect.arrayContaining(['Give it back to your session', 'Run it in the background', 'Drop it']))
  })
})

describe('the occurrence: a stale click opens the target as it stands; a gone one its board (A4.6 #30, r1 #1, r3 #2)', () => {
  it('a question answered between post and click: stale, its thread card drawn', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('main', { frame: 'demo/one', node: 'n-one', then: 'answered' })
    expect(await p.open(askItem('main', t))).toBe('stale')
    expect(await p.has(`.cm-card[data-thread="${t.thread}"]`)).toBe(true)
  })

  it('a question resolved between post and click: stale, the thread panel read-only - Resolved, no answer field - comments left hidden (r2 #2)', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('main', { frame: 'demo/one', node: 'n-one', then: 'resolved' })
    await p.ev(`__mvComments.getState().setShow(false), 1`)
    expect(await p.open(askItem('main', t))).toBe('stale')
    const panel = `[data-jam-thread-panel="${t.thread}"]`
    expect([await p.has(`${panel}[data-resolved] [data-jam-thread-resolved]`), await p.has(`${panel} [data-jam-asks]`), await p.ev(`__mvComments.getState().show`)]).toEqual([true, false, false])
  })

  it('a review after More work (att 2), a repeat redelivery (failures 2) and a repeat stall (stalls 2): each stale', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [
      capture('rv-2', { state: 'review', batch: 'b-rv2', att: 2 }),
      capture('fc-2', { state: 'failed', batch: 'b-f2', fails: 2, att: 2 }),
      capture('sc-2', { state: 'working', batch: 'b-s2', runner: stalled('b-s2', 5, 2) }),
    ] } })
    expect(await p.open({ id: liveId('review', 'rv-2', 1), kind: 'review', board: 'main', cards: ['rv-2'], batch: 'b-rv', occ: 1 })).toBe('stale')
    expect(await p.open({ id: liveId('failed', 'b-f2', 1), kind: 'failed', board: 'main', cards: ['fc-2'], batch: 'b-f2', occ: 1 })).toBe('stale')
    expect(await p.open({ id: liveId('stalled', 'b-s2', 5, 1), kind: 'stalled', board: 'main', cards: ['sc-2'], batch: 'b-s2', gen: 5, occ: 1 })).toBe('stale')
    // as it stands: the stalled capture's panel, never its menu
    expect([await p.ev(`__mvJamUi.getState().panel?.id`), await p.has('.sh-ctxmenu')]).toEqual(['sc-2', false])
  })

  it('a run given back (claimed again): stale', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [capture('sc-3', { state: 'working', batch: 'b-s3', runner: stalled('b-s3', 2, 1, 'claimed') })] } })
    expect(await p.open({ id: liveId('stalled', 'b-s3', 2, 1), kind: 'stalled', board: 'main', cards: ['sc-3'], batch: 'b-s3', gen: 2, occ: 1 })).toBe('stale')
  })

  it('a failed comment card resolved since (it turned done): stale, the thread panel Resolved with no answer field and no status (r3 #2)', async (ctx) => {
    skip(ctx)
    const t = tagged('main', { frame: 'demo/one', node: 'n-one', resolved: true })
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [comment('cc-3', t.thread, t.create, { state: 'done', note: 'resolved', batch: 'b-c3', fails: 1, att: 1 })] } })
    expect(await p.open({ id: liveId('failed', 'b-c3', 1), kind: 'failed', board: 'main', thread: t.thread, cards: ['cc-3'], batch: 'b-c3', occ: 1 })).toBe('stale')
    const panel = `[data-jam-thread-panel="${t.thread}"]`
    expect([await p.has(`${panel}[data-resolved]`), await p.has(`${panel} [data-jam-asks]`), await p.has(`${panel} .cm-tstat`)]).toEqual([true, false, false])
  })

  it('a comment card the view no longer holds (past its 60 s) while its thread stands: stale, never missing - its thread opens', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = tagged('main', { frame: 'demo/two', node: 'n-two' })
    expect(await p.open({ id: liveId('failed', 'b-gone', 1), kind: 'failed', board: 'main', thread: t.thread, cards: ['cc-gone'], batch: 'b-gone', occ: 1 })).toBe('stale')
    expect(await p.has(`.cm-card[data-thread="${t.thread}"]`)).toBe(true)
  })

  it('a thread gone: missing, and only its board opens', async (ctx) => {
    skip(ctx)
    const p = await open()
    expect(await p.open({ id: liveId('ask', 'other', 'nope', 'nope'), kind: 'ask', board: 'other', thread: 'nope', msg: 'nope' })).toBe('missing')
    await p.until(`__mvStore.getState().board === 'other'`)
    expect(await p.has('.cm-card, [data-jam-thread-panel]')).toBe(false)
    // a board that is gone too: nothing opens
    expect(await p.open({ id: liveId('ask', 'gone', 'x', 'y'), kind: 'ask', board: 'gone', thread: 'x', msg: 'y' })).toBe('missing')
    expect(await p.board()).toBe('other')
  })
})

describe('a comment card\'s run controls show in its thread, never a tile (A4.6 r3 #1)', () => {
  it('resolved, then stalled: handled - the thread panel Resolved with no answer field, the popover open with the three choices; Give it back takes', async (ctx) => {
    skip(ctx)
    const t = tagged('main', { frame: 'demo/one', node: 'n-one', resolved: true })
    const card = comment('rc-1', t.thread, t.create, { state: 'working', batch: 'b-r', runner: stalled('b-r', 4, 1) })
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [card] } })
    expect(await p.open({ id: liveId('stalled', 'b-r', 4, 1), kind: 'stalled', board: 'main', thread: t.thread, cards: ['rc-1'], batch: 'b-r', gen: 4, occ: 1 })).toBe('handled')
    const panel = `[data-jam-thread-panel="${t.thread}"]`
    expect([await p.has(`${panel}[data-resolved]`), await p.has(`${panel} [data-jam-asks]`)]).toEqual([true, false])
    const pop = `${panel} .cm-tstat.on[data-jam-card="rc-1"]`
    expect(await p.ev(`[...document.querySelectorAll('${pop} [data-jam-run-act]')].map((b) => b.dataset.jamRunAct)`)).toEqual(['again', 'background', 'drop'])
    // Give it back: the run's own action, at its generation; the queue moves on and the run is no longer stalled
    await p.ev(`__q.onAct = (k, b) => { if (k === 'run' && b.action === 'again') __q.view = { agent: 'claude', cards: [${JSON.stringify({ ...card, runner: stalled('b-r', 4, 1, 'claimed') })}] } }, 1`)
    await p.click(`${pop} [data-jam-run-act="again"]`)
    await p.until(`__q.acts.some(([k, b]) => k === 'run' && b.batch === 'b-r' && b.gen === 4 && b.action === 'again')`)
    await p.until(`__mvJamQueue.getState().cards.find((c) => c.id === 'rc-1').runner.state === 'claimed'`)
  })

  it('a failed comment card whose frame left its board: handled - the thread panel with the answer field and the popover open on Retry; Retry requeues it', async (ctx) => {
    skip(ctx)
    const t = tagged('main', { frame: 'demo/four', node: 'n-gone' })
    const card = comment('cc-2', t.thread, t.create, { frames: ['demo/four'], state: 'failed', batch: 'b-c2', fails: 1, att: 1, note: 'the agent could not finish' })
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [card] } })
    expect(await p.open({ id: liveId('failed', 'b-c2', 1), kind: 'failed', board: 'main', thread: t.thread, cards: ['cc-2'], batch: 'b-c2', occ: 1 })).toBe('handled')
    const panel = `[data-jam-thread-panel="${t.thread}"]`
    expect(await p.has(`${panel} [data-jam-asks] textarea`)).toBe(true)
    await p.ev(`__q.onAct = (k, b) => { if (k === 'card' && b.action === 'retry') __q.view = { agent: 'claude', cards: [${JSON.stringify({ ...card, state: 'queued', rev: 2 })}] } }, 1`)
    await p.click(`${panel} .cm-tstat.on[data-jam-card="cc-2"] .cm-tstat-act`)
    await p.until(`__q.acts.some(([k, b]) => k === 'card' && b.id === 'cc-2' && b.action === 'retry')`)
    await p.until(`document.querySelector('${panel} .cm-tstat[data-jam-card="cc-2"]')?.dataset.jamState === 'queued'`)
  })
})

describe('Play is left first when what opens is on the canvas (A4.6 r4 #1)', () => {
  it('a stalled capture clicked while Play folds the lane: Play left, its tile\'s menu open and usable', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [capture('sc-p', { state: 'working', batch: 'b-p', runner: stalled('b-p', 7, 1) })] } })
    await p.ev(`__mvStore.getState().select('n-one'), 1`)
    await browser!.press(p.s, 'p')
    await p.until(`!!__mvStore.getState().play && !!document.querySelector('.sh-play-stage')`)
    expect(await p.has('.jm-lane [data-tile="sc-p"]')).toBe(false)   // folded
    expect(await p.open({ id: liveId('stalled', 'b-p', 7, 1), kind: 'stalled', board: 'main', cards: ['sc-p'], batch: 'b-p', gen: 7, occ: 1 })).toBe('handled')
    expect(await p.ev(`__mvStore.getState().play`)).toBe(null)
    const item = `[...document.querySelectorAll('.sh-ctxmenu[data-menu="tile:sc-p"] button')].find((b) => b.textContent === 'Give it back to your session')`
    await p.ev(`${item}.click(), 1`)
    await p.until(`__q.acts.some(([k, b]) => k === 'run' && b.batch === 'b-p' && b.gen === 7 && b.action === 'again')`)
  })

  it('a hosted thread on another frame than the one playing: Play left, its card drawn on the canvas', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('main', { frame: 'demo/two', node: 'n-two' })
    await p.ev(`__mvStore.getState().select('n-one'), 1`)
    await browser!.press(p.s, 'p')
    await p.until(`!!__mvStore.getState().play`)
    expect(await p.open(askItem('main', t))).toBe('handled')
    expect(await p.ev(`__mvStore.getState().play`)).toBe(null)
    expect(await p.has(`.cm-card[data-thread="${t.thread}"]`)).toBe(true)
  })

  it('the same with words unsent: busy, Play kept, the words kept', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('main', { frame: 'demo/two', node: 'n-two' })
    await p.ev(`__mvStore.getState().select('n-one'), 1`)
    await browser!.press(p.s, 'p')
    await p.until(`!!__mvStore.getState().play`)
    // a field of the page holding words: the shell's own text field, as any of its fields
    await p.ev(`(() => { const f = document.createElement('textarea'); f.id = 'mv-words'; document.querySelector('.sh-app').appendChild(f); return 1 })()`)
    await p.type('#mv-words', 'half a thought')
    expect(await p.open(askItem('main', t))).toBe('busy')
    expect([!!(await p.ev(`__mvStore.getState().play`)), await p.ev(`document.querySelector('#mv-words').value`)]).toEqual([true, 'half a thought'])
  })
})

describe('nothing moves while words wait or a capture records (A4.6 r2 #1)', () => {
  it('a comment draft with words on board A and a notice for an ask on board B: busy, still on A, the draft and its words kept', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('other', { frame: 'demo/three', node: 'n-three' })
    await p.ev(`__mvComments.getState().setDraft({ nodeKey: 'n-one', frame: 'demo/one', anchor: null }), 1`)
    await p.until(`!!document.querySelector('.cm-draft textarea')`)
    await p.type('.cm-draft textarea', 'this needs more room')
    expect(await p.open(askItem('other', t))).toBe('busy')
    expect([await p.board(), !!(await p.ev(`__mvComments.getState().draft`)), await p.ev(`document.querySelector('.cm-draft textarea').value`)]).toEqual(['main', true, 'this needs more room'])
  })

  it('a reply typed and not sent in thread X, a notice for thread Y on the same board: busy, X\'s card and its words kept', async (ctx) => {
    skip(ctx)
    const p = await open()
    const x = asking('main', { frame: 'demo/one', node: 'n-one' })
    const y = asking('main', { frame: 'demo/two', node: 'n-two' })
    await p.until(`__mvComments.getState().threads.some((t) => t.id === ${JSON.stringify(x.thread)})`)
    await p.ev(`__mvComments.getState().setActive(${JSON.stringify(x.thread)}), __mvStore.getState().select('n-one'), 1`)
    await p.until(`!!document.querySelector('.cm-card[data-thread="${x.thread}"] textarea')`)
    await p.type(`.cm-card[data-thread="${x.thread}"] textarea`, 'and the border')
    expect(await p.open(askItem('main', y))).toBe('busy')
    expect([await p.ev(`__mvComments.getState().active`), await p.ev(`document.querySelector('.cm-card[data-thread="${x.thread}"] textarea').value`)]).toEqual([x.thread, 'and the border'])
  })

  it('words typed while the reads are held open: busy at the next step, nothing moved after them, the words kept', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('other', { frame: 'demo/three', node: 'n-three' })
    await p.ev(`(() => { const f = document.createElement('textarea'); f.id = 'mv-words'; document.querySelector('.sh-app').appendChild(f); return 1 })()`)
    await p.ev(`__q.gate()`)
    const i = await p.ev(`__fake.start(${JSON.stringify(askItem('other', t))})`)
    await p.type('#mv-words', 'wait')
    await p.ev(`__q.release()`)
    expect(await p.ev(`__fake.result(${i})`)).toBe('busy')
    expect([await p.board(), await p.ev(`document.querySelector('#mv-words').value`)]).toEqual(['main', 'wait'])
  })

  it('a More work draft with its panel closed, and a draft pin with nothing typed on another board: each handled (the empty pin gone with the board change)', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [capture('rv-m', { state: 'review', batch: 'b-m', att: 1 })] } })
    await p.until(`(__mvJamQueue.getState().cards ?? []).some((c) => c.id === 'rv-m')`)
    await p.ev(`__mvJamUi.getState().open({ kind: 'review', id: 'rv-m' }), __mvJamUi.getState().setMoreOpen(true), 1`)
    await p.until(`!!document.querySelector('[data-jam-focus] textarea')`)
    await p.type('[data-jam-focus] textarea', 'tighter spacing')
    await p.ev(`__mvJamUi.getState().close(), 1`)
    await p.until(`!document.querySelector('[data-jam-focus]')`)
    const a = asking('other', { frame: 'demo/three', node: 'n-three' })
    await p.ev(`__mvComments.getState().setDraft({ nodeKey: 'n-two', frame: 'demo/two', anchor: null }), 1`)
    await p.until(`!!document.querySelector('.cm-draft textarea')`)
    expect(await p.open(askItem('other', a))).toBe('handled')
    expect([await p.board(), await p.ev(`__mvComments.getState().draft`)]).toEqual(['other', null])
    // the More work words are still the panel's when it opens again
    await p.ev(`__mvJamUi.getState().open({ kind: 'review', id: 'rv-m' }), 1`)
    await p.until(`document.querySelector('[data-jam-focus] textarea')?.value === 'tighter spacing'`)
  })

  it('a capture recording - at the start, or started during the reads: busy, nothing moved', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('other', { frame: 'demo/three', node: 'n-three' })
    await p.ev(`__mvJamCapture.getState().start(), 1`)
    await p.until(`!!__mvJamCapture.getState().current`)
    expect(await p.open(askItem('other', t))).toBe('busy')
    expect(await p.board()).toBe('main')
    await p.ev(`__mvJamCapture.getState().drop(), 1`)
    await p.until(`!__mvJamCapture.getState().current`)
    await p.ev(`__q.gate()`)
    const i = await p.ev(`__fake.start(${JSON.stringify(askItem('other', t))})`)
    await p.ev(`__mvJamCapture.getState().start(), 1`)
    await p.until(`!!__mvJamCapture.getState().current`)
    await p.ev(`__q.release()`)
    expect(await p.ev(`__fake.result(${i})`)).toBe('busy')
    expect([await p.board(), await p.has('.cm-card')]).toEqual(['main', false])
    await p.ev(`__mvJamCapture.getState().drop(), 1`)
  })
})

describe('one request at a time, and only a read that succeeds counts (A4.6 r1 #2)', () => {
  it('two overlapping clicks: only the second moves anything, the first dropped', async (ctx) => {
    skip(ctx)
    const p = await open()
    const a = asking('other', { frame: 'demo/three', node: 'n-three' })
    const b = asking('main', { frame: 'demo/two', node: 'n-two' })
    await p.ev(`__q.gate()`)
    const first = await p.ev(`__fake.start(${JSON.stringify(askItem('other', a))})`)
    const second = await p.ev(`__fake.start(${JSON.stringify(askItem('main', b))})`)
    await p.ev(`__q.release()`)
    expect([await p.ev(`__fake.result(${first})`), await p.ev(`__fake.result(${second})`)]).toEqual(['dropped', 'handled'])
    expect(await p.board()).toBe('main')
    expect(await p.has(`.cm-card[data-thread="${b.thread}"]`)).toBe(true)
  })

  it('the tab hidden during the reads: dropped, nothing moved', async (ctx) => {
    skip(ctx)
    const p = await open()
    const a = asking('other', { frame: 'demo/three', node: 'n-three' })
    await p.ev(`__q.gate()`)
    const i = await p.ev(`__fake.start(${JSON.stringify(askItem('other', a))})`)
    expect(await p.ev(`__fake.state('hidden')`)).toBeGreaterThan(0)
    await p.ev(`__q.release()`)
    expect(await p.ev(`__fake.result(${i})`)).toBe('dropped')
    expect(await p.board()).toBe('main')
  })

  it('a failed queue read and a failed comments read: dropped, the old views kept, nothing moved', async (ctx) => {
    skip(ctx)
    const t = asking('main', { frame: 'demo/one', node: 'n-one' })
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [capture('rv-q', { state: 'review', batch: 'b-q', att: 1 })] } })
    await p.until(`(__mvJamQueue.getState().cards ?? []).some((c) => c.id === 'rv-q')`)
    await p.ev(`__q.fail = true, 1`)
    expect(await p.open({ id: liveId('review', 'rv-q', 1), kind: 'review', board: 'main', cards: ['rv-q'], batch: 'b-q', occ: 1 })).toBe('dropped')
    expect([await p.ev(`__mvJamQueue.getState().cards.map((c) => c.id)`), await p.ev(`__mvJamUi.getState().panel`)]).toEqual([['rv-q'], null])
    await p.ev(`__q.fail = false, __q.commentsFail = true, 1`)
    const threads = await p.ev(`__mvComments.getState().threads.length`)
    expect(await p.open(askItem('main', t))).toBe('dropped')
    expect([await p.ev(`__mvComments.getState().threads.length`), await p.ev(`__mvComments.getState().active`)]).toEqual([threads, null])
  })

  it('a draft pin on the item\'s board is kept through the refresh', async (ctx) => {
    skip(ctx)
    const p = await open()
    await p.ev(`__mvComments.getState().setDraft({ nodeKey: 'n-two', frame: 'demo/two', anchor: null }), 1`)
    expect(await p.ev(`__mvComments.getState().refresh('main')`)).toBe(true)
    expect(await p.ev(`__mvComments.getState().draft?.nodeKey`)).toBe('n-two')
    // and through a click that resolves to nothing on this board
    expect(await p.open({ id: liveId('ask', 'main', 'nope', 'nope'), kind: 'ask', board: 'main', thread: 'nope', msg: 'nope' })).toBe('missing')
    expect(await p.ev(`__mvComments.getState().draft?.nodeKey`)).toBe('n-two')
  })
})

describe('a shell in an app without onOpen (A4.6 #3)', () => {
  it('boots as before: no opener is asked for, nothing listens', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/main', { onOpen: false })
    expect(await p.ev(`__fake.opener()`)).toBe(false)
    expect(await p.open(askItem('main', { thread: 'x', msg: 'y' }))).toBe('no-opener')
  })
})
