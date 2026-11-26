import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { commentsCommand, commentTarget } from '../src/cli/comments.ts'
import { marksCommand } from '../src/cli/marks.ts'
import { drawCommand, parseDrawArgs } from '../src/cli/draw.ts'
import { appendEvents, readLog, replay } from '../src/server/comments.ts'
import * as transport from '../src/server/jam/transport.ts'
import * as jamCli from '../src/cli/jam.ts'
import { bindIdentity, saveCollab } from '../src/server/sync.ts'
import { emptyDoc, wholeElement, serializeDrawFile } from '../src/server/draw/file.ts'
import { recordOwn } from '../src/server/own.ts'
import { record } from '../src/server/jam/ledger.ts'
const frame = 'checkout/flow', file = 'design/scenes/checkout/flow.excalidraw'
let root: string
const logs = () => readLog(join(root, 'design/comments'), 'flow')
const out = () => vi.spyOn(console, 'log').mockImplementation(() => {})
const anchor = (id = 'box-cart') => ({ el: { draw: { id, type: 'rectangle', label: 'forged words' }, semantics: { quote: 'forged words' } } })
function seed(id: string, author: string, agent = false, a: unknown = anchor()) {
  appendEvents(join(root, 'design/comments'), 'flow', [{ id: `e-${id}`, type: 'create', ts: Date.now(), board: 'flow', frame, commentId: id, author: { email: author, name: author.split('@')[0] }, agent, anchor: a, body: 'Please align this' }])
  if (author === 'nic@test.dev' && !agent) recordOwn(root, 'flow', [id])
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mv-draw-comment-cli-'))
  for (const p of ['design/scenes/checkout', 'design/boards', 'design/.local']) mkdirSync(join(root, p), { recursive: true })
  writeFileSync(join(root, 'design/.local/profile.json'), JSON.stringify({ name: 'Nic', email: 'nic@test.dev' }))
  writeFileSync(join(root, 'design/boards/flow.json'), JSON.stringify({ version: 1, nodes: [{ key: 'draw', frame }] }))
  writeFileSync(join(root, 'design/scenes/checkout/screen.tsx'), 'export default () => <h1>Account</h1>')
  const doc = emptyDoc({ epoch: 'test' })
  for (const id of ['box-cart', 'checkout:submit', 'x'.repeat(65), '001']) doc.elements.set(id, wholeElement({ id, type: 'rectangle', boundElements: [{ id: 'label', type: 'text' }] }, 'owner', 1))
  doc.elements.set('label', wholeElement({ id: 'label', type: 'text', text: 'Account sweep' }, 'owner', 1))
  writeFileSync(join(root, file), serializeDrawFile(doc))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('drawing comments CLI', () => {
  it('rejects screen flags on drawings, drawing flags on screens, ambiguous targets and invalid ids', () => {
    for (const opts of [{ on: 'Account' }, { at: 'box-cart' }, { element: 'box-cart', nth: 1 }, { paper: '1,2', viewport: 'mobile' }, { element: 'box-cart', theme: 'dark' }]) expect(() => commentTarget(root, frame, opts)).toThrow('--element')
    for (const opts of [{ element: 'box-cart' }, { paper: '1,2' }]) expect(() => commentTarget(root, 'checkout/screen', opts)).toThrow('screen')
    for (const opts of [{ element: 'box-cart', paper: '1,2' }, { element: '' }, { element: 'x'.repeat(257) }, { element: 'a\nb' }, { paper: 'NaN,1' }, { paper: '1000001,1' }, { paper: ',1' }]) expect(() => commentTarget(root, frame, opts)).toThrow()
  })
  it('pins without dev, computes holders, and re-pins invitee threads as Marver while keeping same-id position', async () => {
    const output = out(); seed('invitee', 'ana@test.dev')
    await commentsCommand(root, 'new', frame, { element: 'box-cart', body: 'Check the label', board: 'flow' })
    expect(logs().at(-1)).toMatchObject({ type: 'create', agent: true, nodeKey: 'draw', anchor: { el: { draw: { id: 'box-cart', label: 'Account sweep', rev: 0, epoch: 'test' } } } })
    expect(output.mock.calls.flat().join('\n')).toContain('comments reply invitee')
    await commentsCommand(root, 'move', 'invitee', { paper: '412,96' })
    expect(logs().at(-1)).toMatchObject({ type: 'reanchor', agent: true, anchor: { el: { draw: { at: { x: 412, y: 96 } } } } })
    for (const id of ['checkout:submit', 'x'.repeat(65)]) {
      await commentsCommand(root, 'new', frame, { element: id, body: 'Keep this', board: 'flow' })
      await commentsCommand(root, 'move', 'invitee', { element: id })
      expect(logs().at(-1)?.anchor).toMatchObject({ el: { draw: { id } } })
    }
    seed('position', 'ana@test.dev', false, { ...anchor(), pos: { fx: 0.2, fy: 0.8 } })
    await commentsCommand(root, 'move', 'position', { element: 'box-cart' }); expect(logs().at(-1)?.anchor).toMatchObject({ pos: { fx: 0.2, fy: 0.8 } })
    const before = logs().length
    await expect(commentsCommand(root, 'move', 'invitee', { element: 'gone' })).rejects.toThrow('no element')
    expect(logs()).toHaveLength(before)
  })
  it('prints file-derived element, paper and DOM descriptions in list and marks, including JSON', async () => {
    const output = out()
    seed('element', 'nic@test.dev', true); seed('missing', 'nic@test.dev', true, anchor('gone'))
    seed('paper', 'nic@test.dev', true, { el: { draw: { at: { x: 412, y: 96 } } } })
    appendEvents(join(root, 'design/comments'), 'flow', [{ id: 'dom', type: 'create', commentId: 'dom', ts: 1, frame: 'checkout/screen', body: 'Account', agent: true, anchor: { el: { semantics: { tag: 'h1', quote: 'Account' }, cssPath: 'main > h1' } } }])
    for (const json of [false, true]) {
      output.mockClear(); await commentsCommand(root, 'list', undefined, { json })
      const text = output.mock.calls.flat().join('\n')
      expect(text).toContain('element box-cart'); expect(text).toContain('Account sweep'); expect(text).toContain('element gone'); expect(text).toContain('paper 412,96'); expect(text).toContain('main > h1'); expect(text).not.toContain('forged words')
      output.mockClear(); marksCommand(root, { json })
      const marks = output.mock.calls.flat().join('\n'); expect(marks).toContain('element box-cart'); expect(marks).toContain('Account sweep'); expect(marks).toContain('paper 412,96'); expect(marks).toContain('main > h1')
    }
  })
  it.each([false, true])('uses Marver on owner/agent threads and capability-selected voice on invitee threads (agentEvents=%s)', async (capable) => {
    const output = out(); seed('owner', 'nic@test.dev'); seed('marver', 'nic@test.dev', true); seed('invitee', 'ana@test.dev')
    saveCollab(root, { url: 'https://canvas.test', token: 'operator', operator: true, email: 'nic@test.dev' })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/capabilities')) return Response.json({ agentEvents: capable })
      // Defer sync; the voice decision precedes publishing and does not depend on a successful exchange.
      return new Response('unavailable', { status: 503 })
    })
    for (const id of ['owner', 'marver', 'invitee']) await commentsCommand(root, 'reply', id, { body: 'Aligned Account sweep', ask: true })
    const replies = logs().filter((e) => e.type === 'reply')
    expect(replies.map((r) => !!r.agent)).toEqual([true, true, capable])
    expect(replies.every((r) => r.asks)).toBe(true)
    expect(output.mock.calls.flat().join('\n')).toContain(capable ? 'replied to invitee as Marver' : 'replied to invitee in your voice')
    expect(replay(logs()).every((t) => !t.resolved)).toBe(true)
  })
  it('recognizes the owner\'s projected identity even when agent events are unavailable', async () => {
    out()
    saveCollab(root, { url: 'https://canvas.test', token: 'session', email: 'nic@test.dev' })
    const id = '1234567890abcdef12345678'
    bindIdentity(root, 'https://canvas.test', 'nic@test.dev', id)
    appendEvents(join(root, 'design/comments'), 'flow', [{ id: 'opaque', type: 'create', commentId: 'opaque', ts: 1, board: 'flow', frame, author: { id, name: 'Nic' }, body: 'Align this' }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }))
    await commentsCommand(root, 'reply', 'opaque', { body: 'Aligned it' })
    expect(logs().at(-1)).toMatchObject({ type: 'reply', agent: true })
  })
  it('built CLI preserves opaque numeric ids and accepts negative paper coordinates', () => {
    const cli = join(process.cwd(), 'dist/cli.mjs')
    const run = (args: string[]) => execFileSync(process.execPath, [cli, 'comments', ...args, '--root', root], { timeout: 15000, encoding: 'utf8' })
    run(['new', frame, '--element', '001', '--body', 'Keep it', '--board', 'flow'])
    expect(logs().at(-1)?.anchor).toMatchObject({ el: { draw: { id: '001' } } })
    run(['new', frame, '--paper', '-412,96', '--body', 'Here', '--board', 'flow'])
    expect(logs().at(-1)?.anchor).toMatchObject({ el: { draw: { at: { x: -412, y: 96 } } } })
  })
})

describe('drawing run CLI', () => {
  it('validates a session handle through its --as connection before sending the explicit claim', async () => {
    out(); vi.stubEnv('MARVER_JAM_RUN', '')
    writeFileSync(join(root, 'design/.local/dev.json'), JSON.stringify({ port: 12345, token: 'work', pid: process.pid }))
    const connection: ReturnType<typeof jamCli.ownConn> = { v: 1, id: 'conn-test', agent: 'codex', session: 'session-test', cwd: root, busy: true, since: 1, seen: 1, key: 'key', inc: 'inc' }
    const conn = vi.spyOn(jamCli, 'ownConn').mockReturnValue(connection)
    const ask = vi.spyOn(transport, 'request').mockResolvedValue({ ok: true })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ rev: 1, ids: ['box-cart'] }))
    await drawCommand(root, 'set', [frame, 'box-cart', 'x=10'], { run: 'r-12345678.2', as: 'conn-test' })
    expect(conn).toHaveBeenCalledWith(root, process.env, 'conn-test')
    expect(ask).toHaveBeenCalledWith(root, connection, 'progress', { handle: 'r-12345678.2' })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).run).toBe('r-12345678.2')
    ask.mockResolvedValue({ ok: false, error: 'the owner moved this run elsewhere' })
    await expect(drawCommand(root, 'set', [frame, 'box-cart', 'x=11'], { run: 'r-12345678.2', as: 'conn-test' })).rejects.toThrow('moved this run')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('validates handles and carries the spawned run handle on retries, printing stranded threads', async () => {
    expect(() => parseDrawArgs('rm', [frame, 'box-cart'], { run: 'bad' })).toThrow('--run')
    expect(() => parseDrawArgs('rm', [frame, 'box-cart'], { as: 'conn' })).toThrow('--run')
    writeFileSync(join(root, 'design/.local/dev.json'), JSON.stringify({ port: 12345, token: 'work', pid: process.pid }))
    vi.stubEnv('MARVER_JAM_RUN', 'r-12345678.0')
    const output = out(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(Response.json({ rev: 1, ids: ['box-cart'], stranded: ['thread-a'] }))
    await drawCommand(root, 'rm', [frame, 'box-cart'])
    expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body)
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).run).toBe('r-12345678.0')
    expect(output.mock.calls.flat().join('\n')).toContain('threads stranded: thread-a')
  })
})
