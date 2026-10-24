/**
 * Main's error policy (errors.ts, spec 28 A2.1) on the real binary: once the window is up, an exception or a
 * rejection that nothing in main caught is recorded in perf/app.jsonl and the app goes on - main answers at once,
 * never held behind Electron's modal box ("A JavaScript error occurred in the main process"), which blocked main on
 * the screen until SIGKILL. And a quit whose guard throws is refused, never left in flight: the next quit quits.
 *
 * test/harness/catch-uncaught.cjs is loaded too, as the safety net it is in quit.test.ts: its listener alone keeps
 * Electron's box away, so should the policy go missing no box comes on the screen - the case fails on the record
 * the policy did not write.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'

const CATCH = resolve(import.meta.dirname, '..', 'harness', 'catch-uncaught.cjs')

let w: WindowRun | undefined
beforeAll(async () => {
  w = await launchWindow('prod', { prepare: async (env) => ({ extraEnv: { NODE_OPTIONS: `--require ${CATCH}`, MVAPP_UNCAUGHT: join(env.dir, 'uncaught.txt') } }) })
})
afterAll(async () => { await w?.close().catch(() => {}) })

// the dev build is Marver Dev: its lines go to app-dev.jsonl through the recorder's writer (A3.8 #12), with the
// envelope and among the recorder's own; the release's app.jsonl is never written
const records = (home: string) => {
  const f = join(home, 'perf', 'app-dev.jsonl')
  expect(existsSync(join(home, 'perf', 'app.jsonl'))).toBe(false)
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; what: string; message: string; flavour: string }).filter((r) => r.kind === 'main-error') : []
}

/** main answers within `ms`: not held by a modal box */
async function answers(run: WindowRun['run'], ms = 1000): Promise<boolean> {
  return Promise.race([run.call('ping').then(() => true, () => false), sleep(ms).then(() => false)])
}

describe('an error nothing caught in main (A2.1)', () => {
  it('is recorded in perf/app.jsonl, and main answers at once - an exception, then a rejection', async () => {
    if (!w) throw new Error('no app')
    expect(readFileSync(join(w.env.dir, 'uncaught.txt'), 'utf8')).toContain('loaded browser')   // the safety net is in main
    expect(records(w.env.home)).toEqual([])
    await w.run.call('throw', { what: 'exception' })
    await sleep(200)
    expect(await answers(w.run)).toBe(true)
    await w.run.call('throw', { what: 'rejection' })
    await sleep(200)
    expect(await answers(w.run)).toBe(true)
    await w.run.call('recorder:flush')   // the writer flushes every 2 s; now
    const got = records(w.env.home)
    expect(got.every((r) => r.flavour === 'dev')).toBe(true)
    expect(got.map((r) => [r.kind, r.what, r.message])).toEqual([
      ['main-error', 'exception', 'mv-test: an exception nothing caught'],
      ['main-error', 'rejection', 'mv-test: a rejection nothing caught'],
    ])
    expect((await w.log('main-error')).map((l) => l.data.what)).toEqual(['exception', 'rejection'])
    // the app still works: a canvas tab comes and is shown
    const { id } = await w.canvas({ slot: 1, name: 'After the error' })
    await w.run.call('activate', { id })
    await w.until((s) => !!s.tabs.find((t) => t.id === id)?.doc?.lifted, 10_000, 'the canvas lifted')
  })

  it('a quit whose guard throws is refused, and the next quit quits (exit 0)', async () => {
    const run = w!.run
    // a canvas tab, live, that has not reported: the quit's guard asks its sheet - which throws
    const { id } = await w!.canvas({ slot: 2, name: 'Quit canvas' })
    await run.call('activate', { id })
    await w!.until((s) => !!s.tabs.find((t) => t.id === id)?.doc?.lifted, 10_000, 'the canvas lifted')
    expect((await w!.tab(id)).reports.safety).toBe('unknown')
    await run.call('sheet', { mode: 'throw' })
    const since = (await w!.log()).length
    await run.call('quit')
    const end = Date.now() + 5000
    let q = await w!.log('quit', since)
    while (!q.some((l) => 'answer' in l.data) && Date.now() < end) { await sleep(50); q = await w!.log('quit', since) }
    expect(q.map((l) => l.data)).toEqual(expect.arrayContaining([expect.objectContaining({ error: 'mv-test: the sheet threw' }), { answer: 'refused' }]))
    expect(await answers(run)).toBe(true)
    expect((await w!.state()).quitting).toBe(false)
    // the next quit is heard: its sheet confirmed, the app ends
    await run.call('sheet', { mode: 'confirm' })
    const exited = new Promise<number | null>((r) => run.child!.once('exit', (c) => r(c)))
    await run.call('quit').catch(() => {})
    const code = await Promise.race([exited, sleep(10_000).then(() => 'held' as const)])
    expect(code).toBe(0)
    // the safety net heard only what the first case threw on purpose: the guard's throw reached nothing uncaught
    const said = readFileSync(join(w!.env.dir, 'uncaught.txt'), 'utf8').split('\n').filter((l) => /^(uncaught|rejection):/.test(l))
    expect(said.filter((l) => !l.includes('nothing caught'))).toEqual([])
    await w!.close()
    w = undefined
  })
})
