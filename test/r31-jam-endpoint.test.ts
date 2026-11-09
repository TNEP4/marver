import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { appendEvents } from '../src/server/comments.ts'
import { fresh, write as writeJournal } from '../src/server/jam/journal.ts'
import type { Card } from '../src/server/jam/types.ts'

/**
 * Spec 31 C.5 on the Jam card route (Codex r10), through a real `marver dev` with Jam on (port 5636): once a capture's
 * own comment is deleted, no `jam/card` answer - the move taken at its revision, or refused at a stale one (409) -
 * carries what it said. The journal's card (its brief, your edit) never leaves the server; the page gets the queue view.
 */

const OWNER = { email: 'nic@local', name: 'Nic' }
const CAP = 'cap-1700000000001-wxyz'
let root = ''
let dev: Dev | null = null
const C = 'r31jamtoken'
const put = (rel: string, body: string | object) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2)) }
const post = async (body: unknown) => {
  const r = await fetch(`${dev!.origin}/__mv/api/jam/card`, { method: 'POST', headers: { cookie: `mv_c=${C}`, 'x-mv-c': C, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, text: await r.text() }
}

beforeAll(async () => {
  root = fixtureRoot('mv-r31-jamep-')
  put('design/config.ts', "export default { jam: { agent: 'claude', concurrency: 1 } }\n")
  put('design/scenes/spec/alpha.tsx', 'export default () => <main><h1>a</h1></main>\n')
  put('design/boards/main.json', { version: 1, name: 'main', nodes: [{ frame: 'spec/alpha' }] })
  put('design/.local/profile.json', OWNER)
  put(`design/.local/jam/captures/${CAP}.json`, { format: 'marver.jam.capture', v: 1, id: CAP, context: { canvas: 'x', board: 'main' }, view: {}, timeline: [{ at: 1, event: 'words', text: 'the withdrawn words' }], pictures: [] })
  const now = Date.now()
  appendEvents(join(root, 'design', 'comments'), 'main', [
    { id: 'capc-ev-9', ts: now - 5000, type: 'create', commentId: 'capc-th-9', board: 'main', frame: 'spec/alpha', author: OWNER, capture: CAP, body: 'the withdrawn words' },
    { id: 'capc-del-9', ts: now - 4000, type: 'delete', commentId: 'capc-th-9', board: 'main', author: OWNER },
  ])
  const j = fresh()
  j.baselined = true
  j.seen = ['main|capc-ev-9', 'main|capc-del-9']
  j.cards.push({ id: CAP, kind: 'capture', board: 'main', frames: ['spec/alpha'], thread: 'capc-th-9', capture: CAP, events: [], state: 'review', made: now - 5000, order: now - 5000, rev: 3, at: now - 4000,
    payload: { record: { context: { board: 'main' }, timeline: [{ at: 1, event: 'words', text: 'the withdrawn words' }] } as never, recordHash: 'h', edited: 'the withdrawn edit' },
    brief: { asks: [], history: [{ id: 'capc-ev-9', body: 'the withdrawn words', ts: now - 5000 }] } } as Card)
  writeJournal(root, j)
  dev = await startDev(root, { args: ['--port', '5636'], env: { MARVER_NO_UPDATE_CHECK: '1' } })
}, 90_000)

afterAll(async () => {
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('jam/card answers after a capture is withdrawn (spec 31 C.5, Codex r10)', () => {
  it('a stale revision (409) and the current one: neither answer carries the withdrawn words', async () => {
    const stale = await post({ id: CAP, rev: 1, action: 'later' })
    expect(stale.status).toBe(409)
    expect(stale.text).not.toMatch(/withdrawn (words|edit)/)
    const current = await post({ id: CAP, rev: 3, action: 'later' })
    expect([200, 409]).toContain(current.status)
    expect(current.text).not.toMatch(/withdrawn (words|edit)/)
  })
})
