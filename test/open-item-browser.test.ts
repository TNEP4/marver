import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { appendEvents, type CommentEvent } from '../src/server/comments.ts'
import { liveId } from '../src/server/app-live.ts'
import { appProof } from '../src/server/proof.ts'
import { readConn, readOffers, upsertConn } from '../src/server/jam/conn.ts'
import { request } from '../src/server/jam/transport.ts'
import { LIVE_WIRE, type LiveEvent, type LiveItem, type OpenItem } from '../src/shared/app-api.ts'

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
    // a board locked to present: Play has no way out there (Play.tsx noDoor)
    'design/boards/deck.json': JSON.stringify({ version: 1, name: 'deck', order: 3, auto: false, nodes: [
      { key: 'n-d1', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 },
      { key: 'n-d2', frame: 'demo/two', x: 600, y: 0, w: 390, h: 844 },
    ] }),
    'design/publish.json': JSON.stringify({ boards: { deck: { open: 'present', lock: true } } }),
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
const FAKE = (o: { onOpen: boolean; realJam?: boolean }) => `(() => {
  const realFetch = window.fetch.bind(window)
  const q = window.__q = { view: { agent: 'claude', cards: [] }, n: 0, fail: false, commentsFail: false, hold: null, release: null, acts: [], posts: [], onAct: null }
  q.gate = () => { q.hold = new Promise((r) => { q.release = () => { q.hold = null; r(); return 1 } }); return 1 }
  // one board's load held open: its GET waits until released; asked once it came, done once its answer went back
  q.gateBoard = (name) => { const b = q.board = { name, asked: false, done: false }; b.held = new Promise((r) => { b.release = () => { b.held = null; r(); return 1 } }); return 1 }
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
  window.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input)
    const path = url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0]
    const method = (init && init.method) || 'GET'
    // a canvas with Jam on (realJam): its queue, its actions and its answers are the server's own
    if (${!o.realJam} && path === '/__mv/api/jam/queue') { if (q.hold) await q.hold; return q.fail ? json({ error: 'no queue' }, 500) : json({ ...q.view, seq: { boot: 'page', n: ++q.n } }) }
    if (${!o.realJam} && (path === '/__mv/api/jam/card' || path === '/__mv/api/jam/run')) {
      const body = JSON.parse(init.body); const kind = path.slice('/__mv/api/jam/'.length)
      q.acts.push([kind, body]); if (q.onAct) q.onAct(kind, body)
      return json({ ok: true })
    }
    if (path.startsWith('/__mv/api/comments/') && method === 'GET') { if (q.hold) await q.hold; if (q.commentsFail) return json({ error: 'no' }, 500) }
    if (q.board && path === '/__mv/api/boards/' + q.board.name && method === 'GET') { const b = q.board; b.asked = true; if (b.held) await b.held; const r = await realFetch(input, init); b.done = true; return r }
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
async function open(hash = '#/b/main', o: { onOpen?: boolean; view?: object; fail?: boolean; dev?: Dev } = {}) {
  const s = await browser!.tab({ width: 1400, height: 900 })
  tabs.push(s)
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE({ onOpen: o.onOpen !== false, realJam: !!o.dev }) }, s)
  if (o.view || o.fail) await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__q.view = ${JSON.stringify(o.view ?? { agent: 'claude', cards: [] })}; window.__q.fail = ${!!o.fail}` }, s)
  await browser!.go(s, 'about:blank')
  await browser!.go(s, `${(o.dev ?? dev)!.origin}/${hash}`)
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
/** What is at the middle of `sel` is `sel` itself: it is drawn on top, not under an overlay. */
const onTop = (sel: string) => `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return !!r && !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(${JSON.stringify(sel)}) })()`

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
    // its batch as the card's: only the counter differs
    expect(await p.open({ id: liveId('review', 'rv-2', 1), kind: 'review', board: 'main', cards: ['rv-2'], batch: 'b-rv2', occ: 1 })).toBe('stale')
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

// ---- a canvas with Jam on: the queue's real transitions ------------------------------------------------------

/** A stand-in `claude -p <goal>` (jam-browser.test.ts's): answers every member of the packet the goal names, after
 *  `delay` - or exits 1, as told by fake-agent.json in the canvas. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs')
const goal = process.argv[process.argv.indexOf('-p') + 1] || ''
const file = (/design\\/\\.local\\/jam\\/packets\\/[\\w-]+\\.json/.exec(goal) || [])[0]
let mode = {}; try { mode = JSON.parse(fs.readFileSync('fake-agent.json', 'utf8')) } catch {}
if (!file || mode.fail) process.exit(1)
const p = JSON.parse(fs.readFileSync(file, 'utf8'))
const F = '\`\`\`'
const out = p.members.map((m) => F + 'marver-reply ' + m.id + '\\nDone.\\n' + F).join('\\n')
setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', result: out }) + '\\n'), mode.delay || 0)
`
/** This canvas's slot file (the suite's own MARVER_HOME): its key, port, instance and workspace. */
const slotOf = (root: string) => {
  const dir = join(process.env.MARVER_HOME!, 'running')
  for (const f of readdirSync(dir)) {
    try { const r = JSON.parse(readFileSync(join(dir, f), 'utf8')); if (r.root === root && r.state === 'ready') return r } catch { /* mid-write */ }
  }
  throw new Error('no slot file')
}
/** What the canvas's live stream says now, read as the Mac app reads it (A4.6 #16): its first snapshot. */
async function liveNow(root: string): Promise<LiveEvent> {
  const slot = slotOf(root)
  const ac = new AbortController()
  const res = await fetch(`${slot.origin}${LIVE_WIRE.path}`, { signal: ac.signal, redirect: 'error', headers: { accept: LIVE_WIRE.type, 'x-mv-ws': slot.ws,
    'x-mv-nonce': randomBytes(24).toString('base64url'), 'x-mv-app': appProof(Buffer.from(slot.key, 'base64url'), slot.port) } })
  const reader = res.body!.getReader()
  let buf = ''
  try {
    for (;;) {
      const r = await reader.read()
      if (r.done) throw new Error(`the stream ended (${res.status})`)
      buf += new TextDecoder().decode(r.value)
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        if (block.startsWith('event: live\ndata: ')) return JSON.parse(block.slice('event: live\ndata: '.length))
      }
    }
  } finally { ac.abort() }
}
/** The first item the live stream names that satisfies `ok`, within `ms`. */
async function liveItem(root: string, ok: (i: LiveItem) => boolean, ms = 30_000): Promise<LiveItem> {
  const end = Date.now() + ms
  for (;;) {
    const hit = (await liveNow(root)).items.find(ok)
    if (hit) return hit
    if (Date.now() > end) throw new Error('no such item in the live stream')
    await new Promise((r) => setTimeout(r, 250))
  }
}
/** What main hands the shell for an item (A4.6 #29): OpenItem's fields alone. */
const asOpen = (i: LiveItem): OpenItem => {
  const { id, kind, board, thread, msg, cards, batch, gen, occ } = i
  return JSON.parse(JSON.stringify({ id, kind, board, thread, msg, cards, batch, gen, occ }))
}
const waitUntil = async (ok: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) }
}
/** A tag sent from the page as the owner sends one: its thread. */
const tagFrom = (p: Awaited<ReturnType<typeof open>>, frame: string, node: string, body: string): Promise<string> =>
  p.ev(`(async () => { const id = crypto.randomUUID(); await __mvComments.getState().send([{ id, ts: Date.now(), type: 'create', commentId: id, frame: ${JSON.stringify(frame)}, nodeKey: ${JSON.stringify(node)}, body: ${JSON.stringify(body)} }], 'main'); return id })()`)

describe('a comment card\'s run controls show in its thread, through the queue\'s real transitions (A4.6 r3 #1, #52; code review r1 P2)', () => {
  // a REAL marver dev with Jam on, a stand-in `claude` on PATH for its spawned runs, and this process standing in for a
  // connected Claude Code session; the stall time short (MV_JAM_STALL_MS, the suite's build only). The item each case
  // clicks is the one the canvas's live stream names; every action goes to the server's own routes and is read back
  // from its journal.
  let jroot = '', bin = ''
  let jdev: Dev | null = null
  const journal = () => JSON.parse(readFileSync(join(jroot, 'design', '.local', 'jam-jobs.json'), 'utf8'))
  const BOARD = (nodes: object[]) => JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes })
  beforeAll(async () => {
    bin = realpathSync(mkdtempSync(join(tmpdir(), 'mv-open-bin-')))
    writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
    chmodSync(join(bin, 'claude'), 0o755)
    jroot = fixtureRoot('mv-open-jam-', {
      'design/config.ts': "export default { jam: { agent: 'claude', concurrency: 1 } }\n",
      'design/scenes/demo/one.tsx': FRAME('One'),
      'design/scenes/demo/two.tsx': FRAME('Two'),
      'design/boards/main.json': BOARD([{ key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 }, { key: 'n-two', frame: 'demo/two', x: 600, y: 0, w: 390, h: 844 }]),
      'fake-agent.json': JSON.stringify({ fail: true }),
    })
    jdev = await startDev(jroot, { env: { PATH: `${bin}:${process.env.PATH}`, MV_JAM_STALL_MS: '4000' } })
  }, 120_000)
  afterAll(async () => {
    await jdev?.stop()
    for (const d of [jroot, bin]) if (d) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('a failed comment card whose frame then left its board: handled - the thread panel with the answer field and the popover open on Retry; Retry requeues it', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/main', { dev: jdev! })
    const thread = await tagFrom(p, 'demo/two', 'n-two', '@marver make it blue')
    // the stand-in fails both attempts: the card fails with its run
    await p.until(`(__mvJamQueue.getState().cards ?? []).some((c) => c.thread === ${JSON.stringify(thread)} && c.state === 'failed')`, 60_000)
    // its frame leaves the board
    writeFileSync(join(jroot, 'design', 'boards', 'main.json'), BOARD([{ key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 }]))
    await p.until(`!__mvStore.getState().nodes.some((n) => n.key === 'n-two')`, 15_000)
    const item = await liveItem(jroot, (i) => i.kind === 'failed' && i.thread === thread)
    const card = item.cards![0]
    expect([typeof item.batch, item.occ]).toEqual(['string', 1])
    expect(await p.open(asOpen(item))).toBe('handled')
    const panel = `[data-jam-thread-panel="${thread}"]`
    expect(await p.has(`${panel} [data-jam-asks] textarea`)).toBe(true)
    const pop = `${panel} .cm-tstat.on[data-jam-card="${card}"]`
    expect(await p.has(pop)).toBe(true)
    // Retry, as the popover sends it: the server's own route, the queue's own requeue - the failed run kept in `ran`
    writeFileSync(join(jroot, 'fake-agent.json'), JSON.stringify({ delay: 1500 }))
    await p.click(`${pop} .cm-tstat-act`)
    const mine = () => journal().cards.find((c: { id: string }) => c.id === card)
    await waitUntil(() => mine().state !== 'failed' && (mine().ran ?? []).includes(item.batch), 15_000)
    expect((await liveNow(jroot)).items.some((i) => i.kind === 'failed' && i.thread === thread)).toBe(false)
  }, 150_000)

  it('resolved, then stalled: handled - the thread panel Resolved with no answer field, the popover open with the three choices; Give it back takes', async (ctx) => {
    skip(ctx)
    writeFileSync(join(jroot, 'fake-agent.json'), JSON.stringify({}))
    const p = await open('#/b/main', { dev: jdev! })
    // a Jam session on, as its Start sends it, and a Claude Code session connected - this process
    const conn = upsertConn(jroot, 'claude', randomUUID(), { pid: process.pid, cwd: jroot }, Date.now(), true)
    expect(await p.ev(`(async () => { const c = /(?:^|;\\s*)mv_c=([\\w-]+)/.exec(document.cookie)?.[1] ?? ''; return (await fetch('/__mv/api/jam/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': c }, body: JSON.stringify({ action: 'start', id: 'ses-' + Date.now() + '-standin' }) })).status })()`)).toBe(200)
    const thread = await tagFrom(p, 'demo/one', 'n-one', '@marver make it say Hello')
    // offered to the session, which takes it
    await waitUntil(() => (readOffers(jroot, conn.id)?.n ?? 0) === 1, 30_000)
    expect(typeof (await request(jroot, readConn(jroot, conn.id) ?? conn, 'next', {}, 20_000)).handle).toBe('string')
    // the thread resolved while the run works (the card keeps working, queue.ts:145), then the run goes quiet: stalled
    await p.ev(`__mvComments.getState().send([{ id: crypto.randomUUID(), ts: Date.now(), type: 'resolve', commentId: ${JSON.stringify(thread)} }], 'main').then(() => 1)`)
    await p.until(`!!__mvComments.getState().threads.find((t) => t.id === ${JSON.stringify(thread)})?.resolved`)
    expect(journal().cards.find((c: { thread?: string }) => c.thread === thread).state).toBe('working')
    const item = await liveItem(jroot, (i) => i.kind === 'stalled' && i.thread === thread)
    const card = item.cards![0]
    expect(item.occ).toBe(1)
    expect(await p.open(asOpen(item))).toBe('handled')
    const panel = `[data-jam-thread-panel="${thread}"]`
    expect([await p.has(`${panel}[data-resolved]`), await p.has(`${panel} [data-jam-asks]`)]).toEqual([true, false])
    const pop = `${panel} .cm-tstat.on[data-jam-card="${card}"]`
    expect(await p.ev(`[...document.querySelectorAll('${pop} [data-jam-run-act]')].map((b) => b.dataset.jamRunAct)`)).toEqual(['again', 'background', 'drop'])
    // Give it back, as the popover sends it: the run's own action through the daemon - the same claim, no longer stalled
    await p.ev(`(() => { window.__runner = []; __mvJamQueue.subscribe((s) => { const r = s.cards?.find((c) => c.id === ${JSON.stringify(card)})?.runner?.state; if (r !== __runner.at(-1)) __runner.push(r) }); return 1 })()`)
    await p.click(`${pop} [data-jam-run-act="again"]`)
    const claim = () => journal().batches.find((b: { batchId: string }) => b.batchId === item.batch)?.claim
    await waitUntil(() => claim()?.resumed === true && !claim().stalled && claim().gen === item.gen, 10_000)
    await p.until(`__runner.includes('claimed')`, 10_000)
  }, 150_000)
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

  it('Play on a frame of another board: left with no way back to that frame - a reply typed once the thread opened is kept, and the board (code review r2 P1)', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('main', { frame: 'demo/two', node: 'n-two' })
    // Play over `main` on a frame only `other` holds: Esc's way back would read the boards and switch to `other`
    await p.ev(`__mvStore.getState().setPlay({ at: 'demo/three', device: 'mobile', theme: 'light' }), 1`)
    await p.until(`!!document.querySelector('.sh-play-stage')`)
    await p.ev(`__q.gateBoard('other')`)
    expect(await p.open(askItem('main', t))).toBe('handled')
    expect(await p.ev(`__mvStore.getState().play`)).toBe(null)
    const field = `.cm-card[data-thread="${t.thread}"] textarea`
    await p.until(`!!document.querySelector('${field}')`)
    await p.type(field, 'and a darker border')
    // what a way back would have asked for lands now, if anything asked
    await p.ev(`__q.board.release()`)
    await new Promise((r) => setTimeout(r, 800))
    expect([await p.board(), await p.ev(`__mvComments.getState().active`), await p.ev(`document.querySelector('${field}')?.value`), await p.ev(`__q.board.asked`)])
      .toEqual(['main', t.thread, 'and a darker border', false])
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

describe('a board locked to its mode: Play cannot be left, so what opens shows over it (A4.6 r4 #1)', () => {
  it('a hosted thread on another frame than the one playing: handled - Play kept on its frame, the thread panel on top with its answer field', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/deck')
    const t = asking('deck', { frame: 'demo/two', node: 'n-d2' })
    await p.ev(`__mvStore.getState().select('n-d1'), 1`)
    await browser!.press(p.s, 'p')
    await p.until(`__mvStore.getState().play?.at === 'demo/one' && !!document.querySelector('.sh-play-stage')`)
    expect(await p.open(askItem('deck', t))).toBe('handled')
    expect(await p.ev(`__mvStore.getState().play?.at`)).toBe('demo/one')
    const panel = `[data-jam-thread-panel="${t.thread}"]`
    expect([await p.has(`${panel} [data-jam-asks] textarea`), await p.ev(onTop(panel))]).toEqual([true, true])
  })

  it('a stalled capture: handled - Play kept, its lane opened over the stage, the tile\'s menu on top and usable', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/deck', { view: { agent: 'claude', cards: [capture('sc-l', { board: 'deck', state: 'working', batch: 'b-l', runner: stalled('b-l', 8, 1) })] } })
    await p.ev(`__mvStore.getState().select('n-d1'), 1`)
    await browser!.press(p.s, 'p')
    await p.until(`!!__mvStore.getState().play && !!document.querySelector('.sh-play-stage')`)
    expect(await p.has('.jm-lane [data-tile="sc-l"]')).toBe(false)   // folded
    expect(await p.open({ id: liveId('stalled', 'b-l', 8, 1), kind: 'stalled', board: 'deck', cards: ['sc-l'], batch: 'b-l', gen: 8, occ: 1 })).toBe('handled')
    expect(!!(await p.ev(`__mvStore.getState().play`))).toBe(true)
    const menu = '.sh-ctxmenu[data-menu="tile:sc-l"]'
    expect([await p.has('.jm-lane .jm-card.focus[data-tile="sc-l"]'), await p.ev(onTop(menu))]).toEqual([true, true])
    await p.ev(`[...document.querySelectorAll('${menu} button')].find((b) => b.textContent === 'Give it back to your session').click(), 1`)
    await p.until(`__q.acts.some(([k, b]) => k === 'run' && b.batch === 'b-l' && b.gen === 8 && b.action === 'again')`)
  })
})

describe('a thread in the legacy all-scenes log opens on the board shown (A4.6 r1 #3)', () => {
  it('its frame on this board: handled, its thread card drawn, the board kept', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('all-scenes', { frame: 'demo/two', node: 'n-two' })
    expect(await p.open(askItem('all-scenes', t))).toBe('handled')
    expect([await p.board(), await p.has(`.cm-card[data-thread="${t.thread}"]`)]).toEqual(['main', true])
  })

  it('its frame on no board here: handled, the thread panel with its answer field, the board kept', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('all-scenes', { frame: 'demo/four', node: 'n-gone' })
    expect(await p.open(askItem('all-scenes', t))).toBe('handled')
    expect([await p.board(), await p.has(`[data-jam-thread-panel="${t.thread}"] [data-jam-asks] textarea`)]).toEqual(['main', true])
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

describe('a board change under the request: it commits only while the request lives (A4.6 #30; code review r1 P1)', () => {
  /** the held board's answer went back, and the time it takes a load to commit after it has passed */
  const loaded = async (p: Awaited<ReturnType<typeof open>>) => { await p.until(`__q.board.done`); await new Promise((r) => setTimeout(r, 400)) }

  it('words typed into an empty draft while the other board loads: busy, the board, the draft and its words kept', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('other', { frame: 'demo/three', node: 'n-three' })
    // a draft pin with nothing typed yet: the click goes ahead
    await p.ev(`__mvComments.getState().setDraft({ nodeKey: 'n-one', frame: 'demo/one', anchor: null }), 1`)
    await p.until(`!!document.querySelector('.cm-draft textarea')`)
    await p.ev(`__q.gateBoard('other')`)
    const i = await p.ev(`__fake.start(${JSON.stringify(askItem('other', t))})`)
    await p.until(`__q.board.asked`)
    await p.type('.cm-draft textarea', 'this needs more room')
    await p.ev(`__q.board.release()`)
    expect(await p.ev(`__fake.result(${i})`)).toBe('busy')
    await loaded(p)
    expect([await p.board(), !!(await p.ev(`__mvComments.getState().draft`)), await p.ev(`document.querySelector('.cm-draft textarea')?.value`)]).toEqual(['main', true, 'this needs more room'])
  }, 30_000)

  it('the tab hidden while the other board loads: dropped, the board kept', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('other', { frame: 'demo/three', node: 'n-three' })
    await p.ev(`__q.gateBoard('other')`)
    const i = await p.ev(`__fake.start(${JSON.stringify(askItem('other', t))})`)
    await p.until(`__q.board.asked`)
    expect(await p.ev(`__fake.state('hidden')`)).toBeGreaterThan(0)
    await p.ev(`__q.board.release()`)
    expect(await p.ev(`__fake.result(${i})`)).toBe('dropped')
    await loaded(p)
    expect(await p.board()).toBe('main')
  }, 30_000)

  it('the other board\'s load held past the request\'s 10 s: dropped at the deadline, and nothing lands once it comes (code review r2 P2)', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('other', { frame: 'demo/three', node: 'n-three' })
    await p.ev(`__q.gateBoard('other')`)
    const i = await p.ev(`(window.__t0 = performance.now(), __fake.start(${JSON.stringify(askItem('other', t))}))`)
    await p.until(`__q.board.asked`)
    // its answer while the load is still held, within a moment of the deadline
    expect(await p.ev(`Promise.race([__fake.result(${i}).then((r) => [r, Math.round((performance.now() - __t0) / 1000)]), new Promise((r) => setTimeout(() => r(['still waiting']), 12_000))])`)).toEqual(['dropped', 10])
    await p.ev(`__q.board.release()`)
    await loaded(p)
    expect(await p.board()).toBe('main')
  }, 40_000)

  it('a newer notice for this board while the first one\'s board loads: the first dropped, the second handled, the board kept', async (ctx) => {
    skip(ctx)
    const p = await open()
    const a = asking('other', { frame: 'demo/three', node: 'n-three' })
    const b = asking('main', { frame: 'demo/two', node: 'n-two' })
    await p.ev(`__q.gateBoard('other')`)
    const first = await p.ev(`__fake.start(${JSON.stringify(askItem('other', a))})`)
    await p.until(`__q.board.asked`)
    const second = await p.ev(`__fake.start(${JSON.stringify(askItem('main', b))})`)
    expect(await p.ev(`__fake.result(${second})`)).toBe('handled')
    await p.ev(`__q.board.release()`)
    expect(await p.ev(`__fake.result(${first})`)).toBe('dropped')
    await loaded(p)
    expect([await p.board(), await p.has(`.cm-card[data-thread="${b.thread}"]`)]).toEqual(['main', true])
  }, 30_000)
})

describe('a request\'s queued camera moves end with it (A4.6 #30; code review r1 P2)', () => {
  /** every fit the camera is asked for from now on, with what it was asked to fit */
  const fits = `(() => { window.__fits = []; const c = __mvJamCanvas; for (const k of ['fitNode', 'fitNodes']) { const f = c[k]; c[k] = (...a) => { __fits.push(JSON.stringify([k, ...a])); return f(...a) } } return 1 })()`
  const settle = () => new Promise((r) => setTimeout(r, 400))

  it('a hosted thread: the request ends as its thread is made active - its 80 ms fit never lands', async (ctx) => {
    skip(ctx)
    const p = await open()
    const t = asking('main', { frame: 'demo/two', node: 'n-two' })
    await p.ev(fits)
    await p.ev(`(() => { const off = __mvComments.subscribe((s) => { if (s.active === ${JSON.stringify(t.thread)}) { off(); __fake.state('hidden') } }); return 1 })()`)
    expect(await p.open(askItem('main', t))).toBe('dropped')
    await settle()
    expect(await p.ev(`__fits.filter((f) => f.includes('n-two'))`)).toEqual([])
  })

  it('a review: the request ends as its panel opens - its frames\' fit, two frames later, never lands', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [capture('rv-cam', { state: 'review', batch: 'b-cam', att: 1 })] } })
    await p.ev(fits)
    await p.ev(`(() => { const off = __mvJamUi.subscribe((s) => { if (s.panel?.id === 'rv-cam') { off(); __fake.state('hidden') } }); return 1 })()`)
    expect(await p.open({ id: liveId('review', 'rv-cam', 1), kind: 'review', board: 'main', cards: ['rv-cam'], batch: 'b-cam', occ: 1 })).toBe('dropped')
    await settle()
    expect(await p.ev(`__fits.filter((f) => f.includes('n-one'))`)).toEqual([])
  })

  it('a later notice: the first one\'s queued fit never lands after the second opens', async (ctx) => {
    skip(ctx)
    const p = await open('#/b/main', { view: { agent: 'claude', cards: [capture('rv-two', { state: 'review', batch: 'b-two', att: 1, frames: ['demo/one'] })] } })
    const t = asking('main', { frame: 'demo/two', node: 'n-two' })
    await p.ev(fits)
    // the second notice comes the moment the first's thread is made active, before its camera moves
    const second = { id: liveId('review', 'rv-two', 1), kind: 'review', board: 'main', cards: ['rv-two'], batch: 'b-two', occ: 1 }
    await p.ev(`(() => { const off = __mvComments.subscribe((s) => { if (s.active === ${JSON.stringify(t.thread)}) { off(); window.__second = __fake.start(${JSON.stringify(second)}) } }); return 1 })()`)
    expect(await p.open(askItem('main', t))).toBe('dropped')
    expect(await p.ev(`__fake.result(__second)`)).toBe('handled')
    await settle()
    const asked = await p.ev(`__fits`) as string[]
    expect([asked.some((f) => f.includes('n-one')), asked.some((f) => f.includes('n-two'))]).toEqual([true, false])
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
