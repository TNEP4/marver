/**
 * The registry reader (spec 28 A2.3, A2.14 #10, #12): `parseEntry`'s rules on A1.3's record, and the reader on a
 * real folder - the watch, the reconcile, `reread`, `closing` told as gone, EPERM as gone, and every file the
 * checks refuse (a link, another mode, a FIFO, a folder others can write).
 */
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boundOrigin, createRegistry, parseEntry, pidAlive, publicEntry, slotBase, type FileFacts, type Registry, type RegistryEvent } from '../../src/main/registry.ts'

const UID = process.getuid!()
const BASE = 30000
const ok: FileFacts = { uid: UID, mode: 0o100600, isFile: true, isSymlink: false, size: 400 }
const key = () => randomBytes(32).toString('base64url')

function rec(o: Record<string, unknown> = {}) {
  const slot = 'slot' in o ? o.slot : 3
  const port = (o.port as number | undefined) ?? (typeof slot === 'number' ? BASE + slot : 5200)
  return {
    v: 1, state: 'ready', pid: process.pid, instance: randomUUID(), slot, port, origin: `http://[::1]:${port}`,
    url: `http://localhost:${port}/`, root: '/Users/nic/tms', name: 'TMS broker', version: '0.27.1', features: ['bridge'],
    ws: '0123456789abcdef', startedAt: 1, key: key(), ...o,
  }
}
const parse = (file: string, r: unknown, f: Partial<FileFacts> = {}) => parseEntry(file, { ...ok, ...f }, JSON.stringify(r), { uid: UID, slotBase: BASE })
const why = (p: ReturnType<typeof parse>) => (p.ok ? 'ok' : p.why)

describe('parseEntry', () => {
  it('reads a ready and a starting record, the key decoded', () => {
    const r = rec()
    const p = parse('slot-3.json', r)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.entry).toMatchObject({ file: 'slot-3.json', state: 'ready', slot: 3, port: BASE + 3, origin: `http://[::1]:${BASE + 3}`, ws: r.ws, instance: r.instance, features: ['bridge'] })
    expect(p.entry.key).toHaveLength(32)
    expect(p.entry.key.toString('base64url')).toBe(r.key)
    const s = parse('slot-3.json', rec({ state: 'starting', origin: null }))
    expect(s.ok && s.entry.state === 'starting' && s.entry.origin === null).toBe(true)
  })

  it('a starting record\'s origin is ignored; a closing one keeps it; a state it does not know reads as starting', () => {
    const s = parse('slot-3.json', rec({ state: 'starting', origin: 'http://127.0.0.1:1/' }))
    expect(s.ok && s.entry.origin).toBe(null)
    const c = parse('slot-3.json', rec({ state: 'closing' }))
    expect(c.ok && c.entry.state === 'closing' && c.entry.origin).toBe(`http://[::1]:${BASE + 3}`)
    const u = parse('slot-3.json', rec({ state: 'warming' }))
    expect(u.ok && u.entry.state).toBe('starting')
  })

  it('port files: no slot, the port of their name', () => {
    expect(why(parse('port-5200.json', rec({ slot: null, port: 5200 })))).toBe('ok')
    expect(why(parse('port-5201.json', rec({ slot: null, port: 5200 })))).toBe('its port is not its name')
    expect(why(parse('port-5200.json', rec({ slot: 3, port: 5200 })))).toBe('its port is not its name')
  })

  it('refuses what the file is: a link, another owner, a mode others can read, past 16 KB', () => {
    expect(why(parse('slot-3.json', rec(), { isSymlink: true }))).toBe('not a regular file')
    expect(why(parse('slot-3.json', rec(), { isFile: false }))).toBe('not a regular file')
    expect(why(parse('slot-3.json', rec(), { uid: UID + 1 }))).toBe('owned by another user')
    expect(why(parse('slot-3.json', rec(), { mode: 0o100644 }))).toBe('readable or writable by others')
    expect(why(parse('slot-3.json', rec(), { mode: 0o100620 }))).toBe('readable or writable by others')
    expect(why(parse('slot-3.json', rec(), { size: 16 * 1024 + 1 }))).toBe('larger than 16 KB')
  })

  it('refuses a record that does not hold together', () => {
    expect(why(parse('slot-3.json', rec({ slot: 4 })))).toBe('its slot is not its name')
    expect(why(parse('slot-3.json', rec({ port: BASE + 4 })))).toBe('its port is not its slot')
    expect(why(parse('slot-21.json', rec({ slot: 21 })))).toBe('its slot is not its name')
    expect(why(parse('slot-3.json', rec({ url: `http://127.0.0.1:${BASE + 3}/` })))).toBe('its url is not localhost on its port')
    expect(why(parse('slot-3.json', rec({ ws: 'not-hex-at-all!!' })))).toBe('no workspace')
    expect(why(parse('slot-3.json', rec({ ws: '0123456789ABCDEF' })))).toBe('no workspace')
    expect(why(parse('slot-3.json', rec({ key: randomBytes(31).toString('base64url') })))).toBe('no 32-byte key')
    expect(why(parse('slot-3.json', rec({ key: randomBytes(33).toString('base64url') })))).toBe('no 32-byte key')
    expect(why(parse('slot-3.json', rec({ v: 2 })))).toBe('not version 1')
    expect(why(parse('slot-3.json', rec({ pid: 0 })))).toBe('no pid')
    expect(why(parse('slot-3.json', rec({ instance: 'x' })))).toBe('no instance')
    expect(why(parse('slot-3.json', rec({ root: 'relative/path' })))).toBe('no root')
    expect(why(parse('slot-3.json', rec({ features: 'bridge' })))).toBe('bad features')
    expect(why(parseEntry('slot-3.json', ok, '{not json', { uid: UID, slotBase: BASE }))).toBe('not JSON')
    expect(why(parseEntry('slot-3.json', ok, '[]', { uid: UID, slotBase: BASE }))).toBe('not a record')
  })

  it('a bound origin is loopback on the record\'s own port, and nothing else', () => {
    const p = BASE + 3
    expect(why(parse('slot-3.json', rec({ origin: `http://127.0.0.1:${p}` })))).toBe('ok')
    expect(why(parse('slot-3.json', rec({ origin: `http://localhost:${p}` })))).toBe('ok')
    expect(why(parse('slot-3.json', rec({ origin: `http://192.168.1.5:${p}` })))).toBe('its origin is not loopback on its port')
    expect(why(parse('slot-3.json', rec({ origin: `http://[::1]:${p}/x` })))).toBe('its origin is not loopback on its port')
    expect(why(parse('slot-3.json', rec({ origin: `http://[::1]:${p + 1}` })))).toBe('its origin is not loopback on its port')
    expect(why(parse('slot-3.json', rec({ origin: `https://[::1]:${p}` })))).toBe('its origin is not loopback on its port')
    expect(why(parse('slot-3.json', rec({ origin: `http://u:p@[::1]:${p}` })))).toBe('its origin is not loopback on its port')
    expect(why(parse('slot-3.json', rec({ origin: null })))).toBe('its origin is not loopback on its port')
    expect(boundOrigin('http://[::1]:4806', 4806)).toBe('http://[::1]:4806')
    expect(boundOrigin('http://[0:0:0:0:0:0:0:1]:4806', 4806)).toBe(null)
  })

  it('ignores fields it does not know, and missing features are none', () => {
    const p = parse('slot-3.json', { ...rec({ features: undefined }), later: { x: 1 }, inset: true })
    expect(p.ok && p.entry.features).toEqual([])
    expect(p.ok && 'later' in p.entry).toBe(false)
  })

  it('a slot file\'s name only: .tmp and .reclaim are not slot files', () => {
    expect(why(parse('slot-3.json.reclaim', rec()))).toBe('not a slot file name')
    expect(why(parse('slot-3.json.abc123.tmp', rec()))).toBe('not a slot file name')
  })

  it('slotBase honours MARVER_SLOT_BASE as the package does', () => {
    expect(slotBase({})).toBe(4804)
    expect(slotBase({ MARVER_SLOT_BASE: '31000' })).toBe(31000)
    expect(slotBase({ MARVER_SLOT_BASE: '80' })).toBe(4804)
    expect(slotBase({ MARVER_SLOT_BASE: 'x' })).toBe(4804)
  })

  it('a pid of another user is gone (EPERM), a dead one too', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(1)).toBe(false)   // launchd: root's, so EPERM
    expect(pidAlive(2 ** 22 + 12345)).toBe(false)
  })

  it('publicEntry carries no key', () => {
    const p = parse('slot-3.json', rec())
    expect(p.ok && 'key' in publicEntry(p.entry)).toBe(false)
  })
})

describe('the reader on a folder', () => {
  const dirs: string[] = []
  const regs: Registry[] = []
  afterEach(() => {
    for (const r of regs.splice(0)) r.stop()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  function setup(o: { alive?: (pid: number) => boolean; betweenLooks?: (file: string) => void } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'mvreg-'))
    dirs.push(home)
    const dir = join(home, 'running')
    const events: RegistryEvent[] = []
    const lines: string[] = []
    process.env.MARVER_SLOT_BASE = String(BASE)
    const reg = createRegistry({ dir, alive: o.alive, log: (l) => lines.push(l), betweenLooks: o.betweenLooks })
    regs.push(reg)
    reg.on((e) => events.push(e))
    const put = (name: string, r: unknown, mode = 0o600) => {
      const tmp = join(dir, `${name}.${randomBytes(3).toString('hex')}.tmp`)
      writeFileSync(tmp, JSON.stringify(r), { mode })
      renameSync(tmp, join(dir, name))
    }
    return { dir, reg, events, lines, put }
  }
  const until = async (f: () => boolean, ms = 2000) => {
    const end = Date.now() + ms
    while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) }
  }

  it('makes running/ (700) when missing, and lists what is there at start', async () => {
    const { dir, reg, events, put } = setup()
    await reg.start()
    expect(execFileSync('stat', ['-f', '%Lp', dir], { encoding: 'utf8' }).trim()).toBe('700')
    expect(reg.entries()).toEqual([])
    put('slot-3.json', rec())
    await reg.reread()
    expect(reg.entries().map((e) => e.file)).toEqual(['slot-3.json'])
    expect(events.map((e) => e.kind)).toEqual(['entry'])
  })

  it('the watch hears a new file, starting then ready, and its removal', async () => {
    const { dir, reg, events, put } = setup()
    await reg.start()
    const r = rec({ state: 'starting', origin: null })
    put('slot-3.json', r)
    await until(() => events.length === 1)
    expect(events[0]).toMatchObject({ kind: 'entry', entry: { state: 'starting', origin: null } })
    put('slot-3.json', { ...r, state: 'ready', origin: `http://127.0.0.1:${BASE + 3}` })
    await until(() => events.length === 2)
    expect(events[1]).toMatchObject({ kind: 'entry', entry: { state: 'ready', origin: `http://127.0.0.1:${BASE + 3}` } })
    expect(reg.byPort(BASE + 3)?.instance).toBe(r.instance)
    expect(reg.byInstance(r.instance)?.state).toBe('ready')
    rmSync(join(dir, 'slot-3.json'))
    await until(() => events.length === 3)
    expect(events[2]).toEqual({ kind: 'gone', file: 'slot-3.json', instance: r.instance, why: 'removed' })
    expect(reg.byPort(BASE + 3)).toBeUndefined()
  })

  it('a pid that stops is gone at the next read; closing is gone and never listed; a new instance is gone, then an entry', async () => {
    let dead = false
    const { reg, events, put } = setup({ alive: () => !dead })
    await reg.start()
    const a = rec()
    put('slot-3.json', a)
    await reg.reread()
    dead = true
    await reg.reread()
    expect(events.at(-1)).toEqual({ kind: 'gone', file: 'slot-3.json', instance: a.instance, why: 'pid' })
    dead = false
    await reg.reread()
    expect(events.at(-1)).toMatchObject({ kind: 'entry', entry: { instance: a.instance } })
    put('slot-3.json', { ...a, state: 'closing' })
    await reg.reread()
    expect(events.at(-1)).toEqual({ kind: 'gone', file: 'slot-3.json', instance: a.instance, why: 'closing' })
    expect(reg.entries()).toEqual([])
    const n = events.length
    await reg.reread()
    expect(events.length).toBe(n)   // told once
    const b = rec()
    put('slot-3.json', b)
    await reg.reread()
    expect(events.slice(n).map((e) => e.kind)).toEqual(['entry'])
    put('slot-3.json', rec())
    await reg.reread()
    expect(events.slice(n + 1)).toMatchObject([{ kind: 'gone', instance: b.instance, why: 'removed' }, { kind: 'entry' }])
  })

  it('the 5 s reconcile notices a pid that stopped with no file change', async () => {
    let dead = false
    const { reg, events, put } = setup({ alive: () => !dead })
    await reg.start()
    put('slot-5.json', rec({ slot: 5 }))
    await reg.reread()
    await new Promise((r) => setTimeout(r, 400))   // the watch's debounce has run: only the tick reads again
    const n = events.length
    dead = true
    const t0 = Date.now()
    await new Promise((r) => setTimeout(r, 300))
    expect(events.length).toBe(n)
    await until(() => events.at(-1)?.kind === 'gone', 6000)
    expect(Date.now() - t0).toBeLessThan(5600)
  }, 10_000)

  it('skips a link, a file others can read, a FIFO and a bad record - each said once - and keeps the good ones', async () => {
    const { dir, reg, lines, put } = setup()
    await reg.start()
    const good = rec({ slot: 2 })
    put('slot-2.json', good)
    const outside = join(dir, '..', 'elsewhere.json')
    writeFileSync(outside, JSON.stringify(rec({ slot: 4 })), { mode: 0o600 })
    symlinkSync(outside, join(dir, 'slot-4.json'))
    put('slot-5.json', rec({ slot: 5 }), 0o644)
    chmodSync(join(dir, 'slot-5.json'), 0o644)
    execFileSync('mkfifo', [join(dir, 'slot-6.json')])
    put('slot-7.json', rec({ slot: 7, url: 'http://evil/' }))
    await reg.reread()
    await reg.reread()
    expect(reg.entries().map((e) => e.file)).toEqual(['slot-2.json'])
    expect(lines.filter((l) => l.includes('slot-4.json'))).toEqual(['registry: slot-4.json skipped: not a regular file'])
    expect(lines.filter((l) => l.includes('slot-5.json'))).toEqual(['registry: slot-5.json skipped: readable or writable by others'])
    expect(lines.filter((l) => l.includes('slot-6.json'))).toEqual(['registry: slot-6.json skipped: not a regular file'])
    expect(lines.filter((l) => l.includes('slot-7.json'))).toEqual(['registry: slot-7.json skipped: its url is not localhost on its port'])
  })

  it('reads nothing from a folder others can write, or a folder that is a link', async () => {
    const { dir, reg, lines, put } = setup()
    await reg.start()
    put('slot-3.json', rec())
    chmodSync(dir, 0o777)
    await reg.reread()
    expect(reg.entries()).toEqual([])
    expect(lines.some((l) => l.includes('writable by others'))).toBe(true)
    chmodSync(dir, 0o700)
    await reg.reread()
    expect(reg.entries()).toHaveLength(1)
    const real = join(dir, '..', 'real-running')
    renameSync(dir, real)
    symlinkSync(real, dir)
    await reg.reread()
    expect(reg.entries()).toEqual([])
  })

  it('lists by slot, then port files by port; reread during a read waits for one more', async () => {
    const { reg, put } = setup()
    await reg.start()
    put('port-5300.json', rec({ slot: null, port: 5300 }))
    put('slot-9.json', rec({ slot: 9 }))
    put('slot-2.json', rec({ slot: 2 }))
    put('port-5299.json', rec({ slot: null, port: 5299 }))
    await Promise.all([reg.reread(), reg.reread(), reg.reread()])
    expect(reg.entries().map((e) => e.file)).toEqual(['slot-2.json', 'slot-9.json', 'port-5299.json', 'port-5300.json'])
  })

  it('a file renamed over between its two looks, or one that will not open, keeps its live entry: read again at once, never gone and back', async () => {
    let race: ((file: string) => void) | null = null
    let dead = false
    const looks: string[] = []
    const { dir, reg, events, put } = setup({ alive: () => !dead, betweenLooks: (f) => { looks.push(f); race?.(f) } })
    await reg.start()
    const a = rec()
    put('slot-3.json', a)
    await reg.reread()
    expect(events.map((e) => e.kind)).toEqual(['entry'])
    // the package rewrites its slot file through a rename (at ready, at closing): once, while it is read
    let left = 1
    race = (f) => { if (f === 'slot-3.json' && left-- > 0) put('slot-3.json', a) }
    looks.length = 0
    await reg.reread()
    expect(looks.filter((f) => f === 'slot-3.json')).toHaveLength(2)   // undecided, then read again at once
    expect(events.map((e) => e.kind)).toEqual(['entry'])
    expect(reg.byInstance(a.instance)?.state).toBe('ready')
    // renamed over at every look: a few reads at most, the entry kept while its pid runs, nothing told
    race = (f) => { if (f === 'slot-3.json') put('slot-3.json', a) }
    looks.length = 0
    await reg.reread()
    expect(looks.filter((f) => f === 'slot-3.json')).toHaveLength(4)
    expect(events.map((e) => e.kind)).toEqual(['entry'])
    expect(reg.byInstance(a.instance)).toBeDefined()
    // a new file that cannot be decided is not listed yet
    race = (f) => { if (f === 'slot-4.json') put('slot-4.json', rec({ slot: 4 })) }
    put('slot-4.json', rec({ slot: 4 }))
    await reg.reread()
    expect(reg.entries().map((e) => e.file)).toEqual(['slot-3.json'])
    race = null
    await reg.reread()
    expect(reg.entries().map((e) => e.file)).toEqual(['slot-3.json', 'slot-4.json'])
    // one that will not open (mode 000: lstat answers, open is refused) stays listed while its pid runs
    const n = events.length
    chmodSync(join(dir, 'slot-3.json'), 0o000)
    await reg.reread()
    expect(reg.byInstance(a.instance)).toBeDefined()
    expect(events.length).toBe(n)
    // and is gone once its pid is
    dead = true
    await reg.reread()
    expect(events.slice(n)).toContainEqual({ kind: 'gone', file: 'slot-3.json', instance: a.instance, why: 'pid' })
    chmodSync(join(dir, 'slot-3.json'), 0o600)
  })

  it('stop() ends the watch: no event after it', async () => {
    const { reg, events, put } = setup()
    await reg.start()
    reg.stop()
    put('slot-3.json', rec())
    await new Promise((r) => setTimeout(r, 300))
    expect(events).toEqual([])
  })
})
