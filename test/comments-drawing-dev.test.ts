import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiMiddleware } from '../src/server/api.ts'
import { readLog } from '../src/server/comments.ts'
import { commentRequest } from './comment-http.ts'

it('dev POST validates drawing anchors on creates and re-pins without rewriting ids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mv-comments-draw-dev-'))
  try {
    mkdirSync(join(root, 'design/.local'), { recursive: true })
    writeFileSync(join(root, 'design/.local/profile.json'), JSON.stringify({ email: 'owner@test.dev', name: 'Owner' }))
    const api = apiMiddleware(root)
    const post = (events: unknown[]) => commentRequest((req, res) => api(req, res, () => { throw new Error('route not handled') }), 'comments/main', { events }, { cookie: 'mv_c=csrf', 'x-mv-c': 'csrf' })
    const anchor = (id: string) => ({ el: { draw: { id, type: 'rectangle' } } })
    const commentId = crypto.randomUUID()
    const create = { id: crypto.randomUUID(), ts: Date.now(), type: 'create', commentId, frame: 'checkout/flow', body: 'Submit', anchor: anchor('checkout:submit') }
    expect((await post([create])).status).toBe(200)
    for (const type of ['create', 'reanchor']) {
      const bad = { ...create, id: crypto.randomUUID(), type, anchor: anchor('x'.repeat(257)) }
      expect((await post([bad])).status).toBe(400)
    }
    expect(readLog(join(root, 'design/comments'), 'main').find((e) => e.id === create.id)?.anchor).toEqual(create.anchor)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 15_000)
