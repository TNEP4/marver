import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanJamEvent, flushJam, jamLog, jamSeams, logJam, readJam } from '../src/server/perf-jam.ts'
import { jamSummary, spread } from '../src/cli/perf.ts'

/** Jam timings (spec 27a Part D): numbers and codes only, one buffered writer, read back by `marver perf --jam`. */

const SENTINEL = 'PURPLE-ELEPHANT-SECRET'
const CAP = 'cap-1792483674182-bhfnus', CAP2 = 'cap-1792483674999-zzz111', BATCH = 'e751e77e-9727-4d58-835e-90af26e23f86'
const temp = () => { const r = mkdtempSync(join(tmpdir(), 'mv-perfjam-')); mkdirSync(join(r, 'design', '.local'), { recursive: true }); return r }

describe('the Jam timing log', () => {
  it('an event is rebuilt from the allowlist: words, notes, names, replies and free-text errors never get in', async () => {
    const root = temp()
    logJam(root, { kind: 'capture', capture: CAP, sealMs: 812.4, words: SENTINEL, note: SENTINEL, title: SENTINEL, pictures: { count: 2, ms: [400, 900], late: 1, failed: 0, what: SENTINEL } })
    logJam(root, { kind: 'run', batch: BATCH, agentMs: [12000], failure: SENTINEL, reply: SENTINEL, members: [{ kind: 'capture', waitMs: 300, outcome: 'review', body: SENTINEL }] })
    logJam(root, { kind: 'name', capture: CAP, ms: 3900, ok: true, name: SENTINEL })
    logJam(root, { kind: 'shot', frame: 'demo/hero', ms: 640, outcome: 'ok', error: SENTINEL })
    logJam(root, { kind: 'capture', capture: SENTINEL })                    // not a capture id: dropped
    logJam(root, { kind: 'run', batch: SENTINEL })                          // not a batch id: dropped
    logJam(root, { kind: 'name', capture: 'nic@example.com', ms: 5, ok: true })   // not a capture id: dropped
    logJam(root, { kind: 'shot', frame: SENTINEL, ms: 5, outcome: 'ok' })   // not a frame id: the frame is left out
    logJam(root, { kind: 'transcript', text: SENTINEL })                    // not an event kind: dropped
    await flushJam(root)
    const text = readFileSync(jamLog(root), 'utf8')
    expect(text).not.toContain(SENTINEL)
    const evs = readJam(root).events
    expect(evs.map((e) => e.kind)).toEqual(['capture', 'run', 'name', 'shot', 'shot'])
    expect(evs[4].frame).toBeUndefined()
    expect(text).not.toContain('nic@example.com')
    expect(evs[0]).toMatchObject({ v: 1, capture: CAP, sealMs: 812, pictures: { count: 2, ms: [400, 900], late: 1, failed: 0 } })
    expect(evs[1]).toMatchObject({ batch: BATCH, agentMs: [12000], members: [{ kind: 'capture', waitMs: 300, outcome: 'review' }] })
    expect(evs[1].failure).toBeUndefined()   // not one of the codes
    rmSync(root, { recursive: true, force: true })
  })

  it('a capture event sent twice (a resend) is written once; a value that cannot be known is left out, never 0', async () => {
    const root = temp()
    logJam(root, { kind: 'capture', capture: CAP2, wordsWaitMs: 300 })
    logJam(root, { kind: 'capture', capture: CAP2, wordsWaitMs: 300 })
    await flushJam(root)
    const evs = readJam(root).events
    expect(evs.length).toBe(1)
    expect('sealMs' in evs[0]).toBe(false)
    expect(cleanJamEvent({ kind: 'run', batch: BATCH, beforeMs: -5, deliverMs: Number.NaN })).toEqual({ kind: 'run', batch: BATCH })
    rmSync(root, { recursive: true, force: true })
  })

  it('a log that cannot be written changes nothing for the operation it measured', async () => {
    const root = temp()
    mkdirSync(join(root, 'design', '.local', 'perf'), { recursive: true })
    chmodSync(join(root, 'design', '.local', 'perf'), 0o500)
    expect(() => logJam(root, { kind: 'shot', frame: 'a/b', ms: 10, outcome: 'ok' })).not.toThrow()
    await flushJam(root)
    chmodSync(join(root, 'design', '.local', 'perf'), 0o700)
    expect(existsSync(jamLog(root))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('what is being written counts against the limit until it is written: an append held, then 1,000 more are dropped', async () => {
    const root = temp()
    // the append held open, as a slow disk would hold it
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const { appendFile } = await import('node:fs/promises')
    let first = true
    jamSeams.append = async (file, data) => { if (first) { first = false; await held } await appendFile(file, data) }
    try {
      for (let i = 0; i < 1_000; i++) logJam(root, { kind: 'shot', frame: `s/f${i}`, ms: i, outcome: 'ok' })
      await new Promise((r) => setTimeout(r, 50))   // the writer has taken them and is held
      for (let i = 0; i < 1_000; i++) logJam(root, { kind: 'shot', frame: `t/f${i}`, ms: i, outcome: 'ok' })
      release()
      await flushJam(root)
    } finally { delete jamSeams.append }
    const evs = readJam(root).events
    expect(evs.filter((e) => e.kind === 'shot').length).toBe(1_000)
    expect(evs.find((e) => e.kind === 'dropped')?.count).toBe(1_000)
    rmSync(root, { recursive: true, force: true })
  }, 30_000)

  it('past 1,000 waiting events new ones are dropped and counted - the count written once the writer catches up', async () => {
    const root = temp()
    for (let i = 0; i < 1_200; i++) logJam(root, { kind: 'shot', frame: `s/f${i}`, ms: i, outcome: 'ok' })
    await flushJam(root)
    const evs = readJam(root).events
    expect(evs.filter((e) => e.kind === 'shot').length).toBe(1_000)
    expect(evs.find((e) => e.kind === 'dropped')?.count).toBe(200)
    rmSync(root, { recursive: true, force: true })
  }, 30_000)

  it('read back: malformed lines skipped, a window that starts before the log says so', () => {
    const root = temp()
    mkdirSync(join(root, 'design', '.local', 'perf'), { recursive: true })
    const now = Date.now()
    writeFileSync(jamLog(root), [JSON.stringify({ v: 1, ts: now - 1000, kind: 'shot', ms: 5 }), '{"truncated', 'not json', JSON.stringify({ v: 1, ts: now, kind: 'shot', ms: 7 })].join('\n') + '\n')
    const r = readJam(root, now - 60_000)
    expect(r.events.map((e) => e.ms)).toEqual([5, 7])
    expect(r.first).toBe(now - 1000)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('marver perf --jam', () => {
  it('each step: count, median, p90 and max; runs by outcome; the last problems', () => {
    expect(spread([])).toEqual({ n: 0 })
    expect(spread([5, 1, 3, 2, 4, 6, 7, 8, 9, 10])).toEqual({ n: 10, median: 5, p90: 9, max: 10 })
    const s = jamSummary([
      { ts: 1, kind: 'capture', capture: 'c1', sealMs: 900, pictures: { ms: [500, 700], late: 1 } },
      { ts: 2, kind: 'run', batch: 'b1', agentMs: [20_000, 15_000], beforeMs: 1200, members: [{ kind: 'capture', waitMs: 100, outcome: 'review' }] },
      { ts: 3, kind: 'run', batch: 'b2', agentMs: [8000], failure: 'agent', members: [{ kind: 'comment', outcome: 'failed' }] },
      { ts: 4, kind: 'shot', frame: 'a/b', ms: 600, outcome: 'stale', recaptures: 2 },
      { ts: 5, kind: 'run', batch: 'b1', redelivered: true, deliverMs: 40 },
      { ts: 6, kind: 'run', batch: 'b3', redelivered: true, failure: 'delivery' },
    ])
    expect(s.steps['run: agent']).toEqual({ n: 3, median: 15_000, p90: 20_000, max: 20_000 })
    expect(s.steps['capture: a picture']).toMatchObject({ n: 2, max: 700 })
    expect(s.steps['run: delivery']).toMatchObject({ n: 1, max: 40 })
    expect(s.outcomes).toEqual({ review: 1, failed: 1 })
    expect(s.retakes).toBe(2)
    expect(s.problems.map((p) => p.what)).toEqual(['run b3 could not post its replies', 'shot a/b: stale after 2 retakes', 'run b2 failed: agent', 'capture c1: 1 picture(s) too late, 0 failed'])
    // a redelivery is no run of its own in the counts
    expect(s.outcomes).toEqual({ review: 1, failed: 1 })
  })
})
