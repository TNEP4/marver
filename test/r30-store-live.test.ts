import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Live, liveLine, Tail } from '../src/cli/perf-live.ts'
import { logReload, perfDir, perfLogSeams } from '../src/server/perf.ts'

/**
 * Spec 30 R11 #47: the tail. A file held by identity: at each poll its descriptor drained, a partial last line kept,
 * and only then another file at the path opened from its start - so a line appended, a rotation and a line appended to
 * the new file, all between two polls, each print once, and a partial line prints only when complete. From the file's
 * end at the start; a file not there yet from its start. Every record once by (page, seq).
 */

let base = '', f = ''
const line = (o: Record<string, unknown>) => JSON.stringify({ ts: 1793361005698, ...o }) + '\n'
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'mv-r30-live-'))); f = join(base, 'page.jsonl') })
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('a file held by identity (#47)', () => {
  it('starts from the end: what was there is not printed, what comes after is', () => {
    writeFileSync(f, line({ n: 1 }))
    const t = new Tail(f, true)
    expect(t.poll()).toEqual([])
    appendFileSync(f, line({ n: 2 }))
    expect(t.poll().map((l) => JSON.parse(l).n)).toEqual([2])
    expect(t.poll()).toEqual([])
    t.close()
  })

  it('a line appended, a rotation and a line appended to the new file, all between two polls, each print once', () => {
    writeFileSync(f, line({ n: 1 }))
    const t = new Tail(f, true)
    appendFileSync(f, line({ n: 2 }))                         // the tail, just before the rotation
    renameSync(f, join(base, 'page.1793361005698-1793361005699.jsonl'))
    writeFileSync(f, line({ n: 3 }))                          // the new live file
    appendFileSync(f, line({ n: 4 }))
    expect(t.poll().map((l) => JSON.parse(l).n)).toEqual([2, 3, 4])
    expect(t.poll()).toEqual([])
    appendFileSync(f, line({ n: 5 }))
    expect(t.poll().map((l) => JSON.parse(l).n)).toEqual([5])
    t.close()
  })

  it('a rename with no new file yet: drained, held, and the new file read from its start when it comes', () => {
    writeFileSync(f, line({ n: 1 }))
    const t = new Tail(f, true)
    appendFileSync(f, line({ n: 2 }))
    renameSync(f, join(base, 'page.1793361005698-1793361005699.jsonl'))
    expect(t.poll().map((l) => JSON.parse(l).n)).toEqual([2])
    expect(t.poll()).toEqual([])
    writeFileSync(f, line({ n: 3 }))
    expect(t.poll().map((l) => JSON.parse(l).n)).toEqual([3])
    t.close()
  })

  it('a partial line prints only when complete, across as many polls and reads as it takes', () => {
    writeFileSync(f, '')
    const t = new Tail(f, true)
    const whole = line({ n: 1, s: 'é·ü' })                  // cut inside a multi-byte character too
    const b = Buffer.from(whole)
    const cut = b.indexOf(Buffer.from('é')) + 1
    appendFileSync(f, b.subarray(0, cut))
    expect(t.poll()).toEqual([])
    appendFileSync(f, b.subarray(cut, b.length - 1))
    expect(t.poll()).toEqual([])
    appendFileSync(f, b.subarray(b.length - 1))
    expect(t.poll()).toEqual([whole.trimEnd()])
    t.close()
  })

  it('a partial line before a rotation completes in the old file; one past it completes in the new one', () => {
    writeFileSync(f, '')
    const t = new Tail(f, true)
    const a = Buffer.from(line({ n: 1 }))
    appendFileSync(f, a.subarray(0, 5))
    expect(t.poll()).toEqual([])
    appendFileSync(f, a.subarray(5))                          // landed, then renamed, between two polls
    renameSync(f, join(base, 'page.1793361005698-1793361005699.jsonl'))
    const c = Buffer.from(line({ n: 2 }))
    writeFileSync(f, c.subarray(0, 4))
    expect(t.poll().map((l) => JSON.parse(l).n)).toEqual([1])
    appendFileSync(f, c.subarray(4))
    expect(t.poll().map((l) => JSON.parse(l).n)).toEqual([2])
    t.close()
  })

  it('a path with no file at the start is read from its first line when one comes', () => {
    const t = new Tail(f, true)
    expect(t.poll()).toEqual([])
    writeFileSync(f, line({ n: 1 }))
    expect(t.poll().map((l) => JSON.parse(l).n)).toEqual([1])
    t.close()
  })

  it('a file is never read from a descriptor twice: the same inode at the path changes nothing', () => {
    writeFileSync(f, line({ n: 1 }) + line({ n: 2 }))
    const t = new Tail(f, false)
    expect(t.poll().map((l) => JSON.parse(l).n)).toEqual([1, 2])
    expect(t.poll()).toEqual([])
    t.close()
  })
})

describe('what it prints (#47)', () => {
  const live = (o: { kinds?: string[]; json?: boolean } = {}) => { const out: string[] = []; return { out, l: new Live({ ...o, print: (x) => out.push(x) }) } }
  const repo = () => { const r = join(base, 'repo'); mkdirSync(perfDir(r), { recursive: true }); return r }

  it('one line per record: time, canvas, kind, the fields that matter; never a whole list', () => {
    const t = liveLine('tms', { ts: 1793361005698, kind: 'update', file: 'a.tsx', change: 'deadbeef:1', cause: 'update', reload: ['a', 'b'], reloadN: 900 })
    expect(t).toMatch(/ {2}tms {2}update {2}/)
    expect(t).toContain('file a.tsx')
    expect(t).toContain('reload 900')
    expect(t).not.toContain('"a"')
    expect(liveLine('x', { kind: 'error', source: 'frame', message: 'm'.repeat(400) }).length).toBeLessThan(200)
  })

  it('an in-place update with no end from Vite says so', () => {
    expect(liveLine('tms', { kind: 'inplace', node: 'n', noAfterUpdate: true })).toContain('noAfterUpdate true')
    expect(liveLine('tms', { kind: 'inplace', node: 'n' })).not.toContain('noAfterUpdate')
  })

  it('from a canvas\'s files and the app\'s, `--kinds` its filter, the raw line with --json', () => {
    const r = repo(), home = join(base, 'home')
    mkdirSync(join(home, 'perf'), { recursive: true })
    const { out, l } = live({ kinds: ['cmd', 'ready'] })
    l.addCanvas(r, 'tms')
    l.addApp(home)
    logReload(r, { kind: 'ready', tab: 's', frame: 'x/1', cause: 'job', ms: 3 })
    logReload(r, { kind: 'update', file: 'a.tsx', reload: [], inPlace: [] })
    appendFileSync(join(home, 'perf', 'app.jsonl'), line({ kind: 'cmd', phase: 'once', id: 'a', cmd: 'reload', via: 'key', in: 'main', outcome: 'done', ms: 1 }))
    appendFileSync(join(home, 'perf', 'app.jsonl'), line({ kind: 'tab', tab: 't1' }))
    l.poll()
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('tms  ready')
    expect(out[1]).toContain('app  cmd')
    l.close()
    const j = live({ json: true })
    j.l.addApp(home)
    const raw = line({ kind: 'start', pid: 1 })
    appendFileSync(join(home, 'perf', 'app.jsonl'), raw)
    j.l.poll()
    expect(j.out).toEqual([raw.trimEnd()])
    j.l.close()
  })

  it('a record written twice prints once by (page, seq); a server line, which names none, always prints; a torn line never', () => {
    const r = repo()
    const { out, l } = live()
    l.addCanvas(r, 'tms')
    const rec = line({ kind: 'ready', tab: 's', page: 'aaaaaaaaaaaa', seq: 4, frame: 'x/1' })
    const p = join(perfDir(r), 'reloads.jsonl')
    appendFileSync(p, rec + rec + line({ kind: 'full-reload', passed: true }) + line({ kind: 'full-reload', passed: false }) + '{"kind":"torn\n')
    l.poll()
    expect(out.map((x) => x.split('  ')[2])).toEqual(['ready', 'full-reload', 'full-reload'])
    l.close()
  })

  it('an app event and a canvas\'s record with the same page and seq are two records; each repeats once, by its own identity', () => {
    const r = repo(), home = join(base, 'home')
    mkdirSync(join(home, 'perf'), { recursive: true })
    const { out, l } = live()
    l.addCanvas(r, 'tms')
    l.addApp(home)
    const PAGE = 'aaaaaaaaaaaa', p = join(perfDir(r), 'page.jsonl'), a = join(home, 'perf', 'app.jsonl')
    const shell = line({ kind: 'theme', page: PAGE, seq: 7 })
    const event = line({ kind: 'shown', flavour: 'release', app: 'bbbbbbbbbbbb', seq: 7, page: PAGE, tab: 't1', ms: 3 })
    appendFileSync(p, shell + shell)
    appendFileSync(a, event + event)
    // the same seq in another launch, in the other flavour, and from another page: each its own
    appendFileSync(a, line({ kind: 'shown', flavour: 'release', app: 'cccccccccccc', seq: 7, page: PAGE, tab: 't1', ms: 4 }))
    appendFileSync(join(home, 'perf', 'app-dev.jsonl'), line({ kind: 'shown', flavour: 'dev', app: 'bbbbbbbbbbbb', seq: 7, page: PAGE, tab: 't1', ms: 5 }))
    appendFileSync(p, line({ kind: 'theme', page: 'dddddddddddd', seq: 7 }))
    l.poll()
    expect(out.map((x) => `${x.split('  ')[1]} ${x.split('  ')[2]}`).sort()).toEqual(['app shown', 'app shown', 'app shown', 'tms theme', 'tms theme'])
    l.close()
  })

  it('a canvas that happens to be called `app` keeps a page\'s identity', () => {
    const r = repo()
    const { out, l } = live()
    l.addCanvas(r, 'app')
    const rec = line({ kind: 'theme', page: 'aaaaaaaaaaaa', seq: 1, app: 'not-a-launch' })
    appendFileSync(join(perfDir(r), 'page.jsonl'), rec + line({ kind: 'theme', page: 'aaaaaaaaaaaa', seq: 1, app: 'another' }))
    l.poll()
    expect(out).toHaveLength(1)
    l.close()
  })

  it('follows the server\'s own rotation: nothing skipped, nothing twice', () => {
    const r = repo()
    const { out, l } = live({ kinds: ['ready'] })
    let now = Date.now()
    perfLogSeams.reset()
    perfLogSeams.now = () => now
    try {
      logReload(r, { kind: 'ready', tab: 's', frame: 'x/0' })
      l.addCanvas(r, 'tms')
      logReload(r, { kind: 'ready', tab: 's', frame: 'x/1' })
      now += 86_400_001                                       // the live file closes before this append
      logReload(r, { kind: 'ready', tab: 's', frame: 'x/2' })
      logReload(r, { kind: 'ready', tab: 's', frame: 'x/3' })
      l.poll()
      expect(out.map((x) => /frame (x\/\d)/.exec(x)![1])).toEqual(['x/1', 'x/2', 'x/3'])
    } finally { perfLogSeams.now = undefined; perfLogSeams.reset(); l.close() }
  })
})
