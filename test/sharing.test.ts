import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { serve } from '../src/server/serve.ts'

/**
 * The sharing v1 enforcement surface, end to end against a real serve().
 *
 * Started with the seed relocation (04-solution §8 item 1, acceptance 3):
 * comment history is identity history, so the raw JSONL must never be
 * reachable as a static file - not from a new build (seeds live outside the
 * web root) and not from an old one (the server refuses the path outright).
 */

const PORT = 4741
let root = ''
let server: Server | null = null

const seedEvent = (id: string) =>
  JSON.stringify({ id, ts: 1, type: 'create', commentId: id, frame: 'x/y', author: { email: 'past@author.test', name: 'Past' }, body: 'hello' })

/** A minimal published canvas on disk - what buildSite leaves behind, hand-rolled. */
function scaffold() {
  const dist = join(root, 'design', '.dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>BUNDLE</body></html>')
  writeFileSync(join(dist, 'meta.json'), JSON.stringify({ name: 'Seed Test', branding: true, rights: { main: 'comment' } }))
}

async function boot(env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  server = await serve(root, PORT)
  await new Promise((r) => setTimeout(r, 50))
}

const get = (path: string) => fetch(`http://localhost:${PORT}${path}`, { redirect: 'manual' })

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mv-sharing-')) })
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  server = null
  rmSync(root, { recursive: true, force: true })
  delete process.env.MARVER_DATA_DIR
  delete process.env.MARVER_PASSWORD
})

describe('seeds out of the web root (acceptance 3)', () => {
  it('refuses /design/comments/* statically even when an old build left the file in dist', async () => {
    scaffold()
    const legacy = join(root, 'design', '.dist', 'design', 'comments')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'main.jsonl'), seedEvent('ev-legacy') + '\n')
    const data = join(root, 'data')
    await boot({ MARVER_DATA_DIR: data })

    // the raw log is not served - not the file, and not the shell fallback either
    const res = await get('/design/comments/main.jsonl')
    expect(res.status).toBe(404)
    // a missing log is indistinguishable from a present one
    expect((await get('/design/comments/other.jsonl')).status).toBe(404)

    // but the seed still reached the live store (old-build compatibility)
    const stored = readFileSync(join(data, 'comments', 'main.jsonl'), 'utf8')
    expect(stored).toContain('ev-legacy')
  })

  it('unions seeds from design/.dist-seeds (the new home, outside the web root)', async () => {
    scaffold()
    const seeds = join(root, 'design', '.dist-seeds')
    mkdirSync(seeds, { recursive: true })
    writeFileSync(join(seeds, 'main.jsonl'), seedEvent('ev-relocated') + '\n')
    const data = join(root, 'data')
    await boot({ MARVER_DATA_DIR: data })

    const stored = readFileSync(join(data, 'comments', 'main.jsonl'), 'utf8')
    expect(stored).toContain('ev-relocated')
    // and nothing under the seeds dir is reachable over HTTP - a miss falls back
    // to the shell (hash routing), never to the log bytes
    expect(await (await get('/design/.dist-seeds/main.jsonl')).text()).not.toContain('past@author.test')
    expect(await (await get('/../.dist-seeds/main.jsonl')).text()).not.toContain('past@author.test')
  })

  it('refuses the path on a static-only serve too (no data dir, no API)', async () => {
    scaffold()
    const legacy = join(root, 'design', '.dist', 'design', 'comments')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'main.jsonl'), seedEvent('ev-static') + '\n')
    await boot()
    expect((await get('/design/comments/main.jsonl')).status).toBe(404)
  })
})
