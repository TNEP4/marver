import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendRun, logReload, perfDir, perfLogs, perfLogSeams, readPage, readReloads, readRuns, tidyPerfDir } from '../src/server/perf.ts'
import { flushJam, jamLog, jamSeams, logJam, readJam, tidyJam } from '../src/server/perf-jam.ts'
import { parseSegmentName, SEGMENTS, segmentName } from '../src/shared/perf-records.ts'
import { readSegmented } from '../src/server/perf-segments.ts'

/**
 * Spec 30 R9 (#42-#45), the dev server's writers: every log a live file plus closed segments - closed by size and by
 * age, named with a conservative newest bound, deleted whole once that bound is 14 days old (an unlink, never a read),
 * the safety cap's counted drop, a 0.29 file closed as a segment at the first 0.30 start, Jam's writer under the same
 * rules - and the readers reading every segment in `openedAt` order, then the live file.
 */

const DAY = 86_400_000
const WS = '0123456789abcdef', PAGE = 'aaaaaaaaaaaa', LOAD = 'bbbbbbbbbbbb'
const temp = () => { const r = mkdtempSync(join(tmpdir(), 'mv-r30-seg-')); mkdirSync(join(r, 'design', '.local'), { recursive: true }); return r }
const quiet = (seq: number, ts: number) => ({ v: 1, ws: WS, page: PAGE, load: LOAD, seq, ts, kind: 'quiet', ms: 10 })
/** page lines as the server appends them (logPage's cleaner would move a time far from the real clock) */
const pageLines = (...recs: Record<string, unknown>[]) => perfLogs.append(root, 'page', recs.map((r) => JSON.stringify(r)))
const segs = (root: string, base: string) => (existsSync(perfDir(root)) ? readdirSync(perfDir(root)) : []).filter((f) => f.startsWith(`${base}.`) && f !== `${base}.jsonl`).sort()
const posix = process.platform !== 'win32'

let root = ''
let now = 0
beforeEach(() => { root = temp(); now = Date.now(); perfLogSeams.reset(); perfLogSeams.now = () => now })
afterEach(() => { perfLogSeams.now = undefined; perfLogSeams.reset(); jamSeams.now = undefined; rmSync(root, { recursive: true, force: true }) })

describe('the dev server\'s logs: segments (#42)', () => {
  it('a live file closes by size: an O(1) rename to <name>.<openedAt>-<bound>.jsonl, every line kept, the next append a new live file', () => {
    const big = { pad: 'p'.repeat(4000) }
    let n = 0
    while (!segs(root, 'runs').length && n < 10_000) appendRun(root, { v: 1, run: `r${n++}`, ts: now, ...big })
    const size = statSync(join(perfDir(root), segs(root, 'runs')[0]!)).size
    expect(size).toBeGreaterThanOrEqual(SEGMENTS['runs.jsonl'].segmentBytes)
    expect(size - size / n).toBeLessThan(SEGMENTS['runs.jsonl'].segmentBytes)   // closed by the append that passed it
    const p = parseSegmentName('runs.jsonl', segs(root, 'runs')[0]!)!
    expect(p.openedAt).toBe(now)
    expect(p.bound).toBe(now)
    expect(existsSync(join(perfDir(root), 'runs.jsonl'))).toBe(false)   // closed past its size, at once
    appendRun(root, { v: 1, run: 'after', ts: now })
    expect(existsSync(join(perfDir(root), 'runs.jsonl'))).toBe(true)
    expect(readRuns(root).map((r) => r.run)).toEqual([...Array.from({ length: n }, (_, i) => `r${i}`), 'after'])
  })

  it('a live file closes 24 h after it was opened, whatever its size; its bound is the later of the close and its largest ts', () => {
    const t0 = now
    pageLines(quiet(0, t0))
    now = t0 + 10 * 3_600_000
    pageLines(quiet(1, now + 20 * 3_600_000))   // an event time ahead of the server's (its clock within 24 h): past the close
    now = t0 + DAY + 1
    pageLines(quiet(2, now))
    const [seg] = segs(root, 'page')
    expect(seg).toBe(segmentName('page.jsonl', t0, t0 + 30 * 3_600_000))
    expect(readPage(root).map((r) => r.seq)).toEqual([0, 1, 2])
  })

  it('a segment\'s bound comes from what was written into it, never from the next segment: a last batch of older event times is not deleted early', () => {
    const t0 = now - 20 * DAY
    now = t0
    pageLines(quiet(0, t0), quiet(1, t0 + 23 * 3_600_000))   // A: newest event at t0 + 23 h
    now = t0 + DAY
    pageLines(quiet(2, t0 + 3_600_000))                       // B opens; its first batch carries older times
    now = t0 + 2 * DAY
    pageLines(quiet(3, now))
    const [a, b] = segs(root, 'page').map((x) => ({ x, ...parseSegmentName('page.jsonl', x)! }))
    expect(a!.bound).toBe(t0 + DAY)                                // its close, later than its newest ts
    expect(b!.bound).toBe(t0 + 2 * DAY)                            // never t0 + 1 h, its own first line's time
    // 14 days after A's bound and a moment: A goes, B (bound one day later) stays
    now = t0 + DAY + 14 * DAY + 1
    perfLogSeams.reset()
    tidyPerfDir(root, now)
    const bounds = segs(root, 'page').map((x) => parseSegmentName('page.jsonl', x)!.bound)
    expect(bounds).not.toContain(t0 + DAY)
    expect(bounds).toContain(t0 + 2 * DAY)
  })

  it.skipIf(!posix)('retention unlinks a segment past 14 days without reading it, at start and hourly in the writer\'s turn', () => {
    mkdirSync(perfDir(root), { recursive: true })
    const old = join(perfDir(root), segmentName('reloads.jsonl', now - 20 * DAY, now - 14 * DAY - 1))
    const kept = join(perfDir(root), segmentName('reloads.jsonl', now - 15 * DAY, now - 14 * DAY + 60_000))
    for (const f of [old, kept]) { writeFileSync(f, JSON.stringify({ ts: now - 15 * DAY, kind: 'x' }) + '\n'); chmodSync(f, 0o000) }   // unreadable: an unlink needs no read
    tidyPerfDir(root, now)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(kept)).toBe(true)
    chmodSync(kept, 0o600)
    // an hour on, the writer's next append prunes again; before the hour it does not
    now += 30 * 60_000
    logReload(root, { kind: 'shell-boot' })
    expect(existsSync(kept)).toBe(true)
    now += 31 * 60_000
    logReload(root, { kind: 'shell-boot' })
    expect(existsSync(kept)).toBe(false)
  })

  it('the safety cap (#43): past it, the oldest segments go and a counted `dropped {reason: retention-cap}` line says how many lines', () => {
    mkdirSync(perfDir(root), { recursive: true })
    const cap = SEGMENTS['jam.jsonl'].capBytes   // runs.jsonl has the same 8 MB
    const line = JSON.stringify({ v: 1, ts: now, run: 'x', pad: 'p'.repeat(1000) }) + '\n'
    const per = Math.ceil(2 * 2 ** 20 / line.length)
    for (let i = 0; i < 5; i++) writeFileSync(join(perfDir(root), segmentName('runs.jsonl', now - (5 - i) * 3_600_000, now - (4 - i) * 3_600_000)), line.repeat(per))
    expect(5 * per * line.length).toBeGreaterThan(cap)
    tidyPerfDir(root, now)
    expect(segs(root, 'runs')).toHaveLength(3)                      // the two oldest went
    const dropped = perfLogs.read(root, 'runs').filter((l) => l.kind === 'dropped')
    expect(dropped).toEqual([{ v: 1, ts: now, kind: 'dropped', n: 2 * per, reason: 'retention-cap' }])
    expect(readRuns(root).every((r) => r.run === 'x')).toBe(true)   // the runs' reader skips it
    // the page log's names no page: no reader takes it for a record of one
    expect(readPage(root)).toEqual([])
  })

  it('migration (#45): a 0.29 file is closed as a segment - openedAt its first line\'s ts, bound its mtime + 24 h - nothing rewritten', () => {
    mkdirSync(perfDir(root), { recursive: true })
    const first = now - 5 * DAY
    const text = [JSON.stringify({ ts: first, kind: 'update', file: 'a.tsx', reload: ['x/a'], inPlace: [] }), JSON.stringify({ ts: now - 2 * DAY, kind: 'ready', cause: 'job', frame: 'x/a' }), ''].join('\n')
    const f = join(perfDir(root), 'reloads.jsonl')
    writeFileSync(f, text)
    const mtime = new Date(now - 2 * DAY)
    utimesSync(f, mtime, mtime)
    tidyPerfDir(root, now)
    expect(segs(root, 'reloads')).toEqual([segmentName('reloads.jsonl', first, mtime.getTime() + DAY)])
    expect(readFileSync(join(perfDir(root), segs(root, 'reloads')[0]!), 'utf8')).toBe(text)
    expect(readReloads(root).map((l) => l.kind)).toEqual(['update', 'ready'])
  })

  it('a live file adopted after a restart keeps its lines; closed later, its bound is its mtime + 24 h (no tracked maximum)', () => {
    pageLines(quiet(0, now))
    perfLogSeams.reset()                                            // the dev server restarted
    now += 3_600_000
    pageLines(quiet(1, now))
    expect(segs(root, 'page')).toEqual([])                          // adopted, not closed: opened an hour ago
    const opened = now - 3_600_000
    now = opened + DAY
    pageLines(quiet(2, now))
    const p = parseSegmentName('page.jsonl', segs(root, 'page')[0]!)!
    expect(p.openedAt).toBe(opened)
    expect(p.bound).toBeGreaterThanOrEqual(statSync(join(perfDir(root), segs(root, 'page')[0]!)).mtimeMs + DAY - 1)
    expect(readPage(root).map((r) => r.seq)).toEqual([0, 1, 2])
  })

  it('readers read the segments in openedAt order, then the live file; a segment whose bound is before `since` is not read', () => {
    mkdirSync(perfDir(root), { recursive: true })
    const w = (name: string, ...ts: number[]) => writeFileSync(join(perfDir(root), name), ts.map((t) => JSON.stringify({ ts: t, kind: 'k', at: t })).join('\n') + '\n')
    w(segmentName('reloads.jsonl', now - 3 * DAY, now - 2 * DAY), now - 3 * DAY)
    w(segmentName('reloads.jsonl', now - 5 * DAY, now - 4 * DAY), now - 5 * DAY)
    w('reloads.jsonl', now - 1)
    expect(readReloads(root).map((l) => l.at)).toEqual([now - 5 * DAY, now - 3 * DAY, now - 1])
    expect(readReloads(root, now - 3.5 * DAY).map((l) => l.at)).toEqual([now - 3 * DAY, now - 1])
    // a link named like a segment is no segment
    expect(readSegmented(perfDir(root), 'reloads.jsonl')).toHaveLength(3)
  })
})

describe('Jam\'s writer under the same rules (#42)', () => {
  it('closes by size and by age in its own queue, keeps every event, and a 0.29 jam.jsonl becomes a segment at start', async () => {
    mkdirSync(perfDir(root), { recursive: true })
    const old = now - 3 * DAY
    writeFileSync(jamLog(root), JSON.stringify({ v: 1, ts: old, kind: 'shot', ms: 1 }) + '\n')
    jamSeams.now = () => now
    tidyJam(root, now)
    await flushJam(root)
    expect(segs(root, 'jam')).toEqual([segmentName('jam.jsonl', old, Math.ceil(statSync(join(perfDir(root), segs(root, 'jam')[0]!)).mtimeMs + DAY))])
    for (let i = 0; i < 20; i++) logJam(root, { kind: 'shot', frame: 'demo/hero', ms: i, outcome: 'ok' })
    await flushJam(root)
    expect(segs(root, 'jam')).toHaveLength(1)
    now += DAY
    logJam(root, { kind: 'shot', frame: 'demo/hero', ms: 99, outcome: 'ok' })
    await flushJam(root)
    expect(segs(root, 'jam')).toHaveLength(2)                       // the live file opened a day ago closed before the append
    expect(readJam(root).events.map((e) => e.ms)).toEqual([1, ...Array.from({ length: 20 }, (_, i) => i), 99])
    expect(readJam(root).first).toBe(old)
  })

  it('its retention unlinks whole segments past 14 days and its cap writes the counted line', async () => {
    mkdirSync(perfDir(root), { recursive: true })
    jamSeams.now = () => now
    const gone = join(perfDir(root), segmentName('jam.jsonl', now - 16 * DAY, now - 15 * DAY))
    writeFileSync(gone, JSON.stringify({ v: 1, ts: now - 16 * DAY, kind: 'shot' }) + '\n')
    const line = JSON.stringify({ v: 1, ts: now, kind: 'shot', pad: 'p'.repeat(1000) }) + '\n'
    const per = Math.ceil(2 * 2 ** 20 / line.length)
    for (let i = 0; i < 5; i++) writeFileSync(join(perfDir(root), segmentName('jam.jsonl', now - (5 - i) * 3_600_000, now - (4 - i) * 3_600_000)), line.repeat(per))
    tidyJam(root, now)
    await flushJam(root)
    expect(existsSync(gone)).toBe(false)
    expect(segs(root, 'jam')).toHaveLength(3)
    expect(readJam(root).events.filter((e) => e.kind === 'dropped')).toEqual([{ v: 1, ts: now, kind: 'dropped', count: 2 * per, reason: 'retention-cap' }])
  })
})
