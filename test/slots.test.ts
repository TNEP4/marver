import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  formatRunning, legacyEntry, legacyPort, notePrefer, place, readPrefer, readRunning, recoverEntries, recoverTarget,
  slotBase, slotOfPort, slotPort, stopPrefer, type PlaceInput,
} from '../src/server/slots.ts'
import { legacyWorkspace, workspaceId } from '../src/server/workspace.ts'

/**
 * The slots (spec 28 A1.3): twenty fixed ports, one file each in the registry, claimed by real
 * processes racing one another. Every case has a registry of its own (MARVER_HOME) and the slots on
 * 48905-48924 (MARVER_SLOT_BASE), so nothing here touches ~/.marver or a real canvas's port; the claim
 * races inject the port check, so the machine's own listeners never decide them - one case binds a
 * real server on a slot's port instead.
 */

const BASE = 48904
const MODULE = resolve('src/server/slots.ts')
let home = ''
const saved = { home: process.env.MARVER_HOME, base: process.env.MARVER_SLOT_BASE }
const children: ChildProcess[] = []
const servers: Server[] = []
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mv-slots-')))
  process.env.MARVER_HOME = home
  process.env.MARVER_SLOT_BASE = String(BASE)
})
afterEach(async () => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  process.env.MARVER_HOME = saved.home
  process.env.MARVER_SLOT_BASE = saved.base
  rmSync(home, { recursive: true, force: true })
})

const running = (f = '') => join(home, 'running', f)
const read = (f: string) => JSON.parse(readFileSync(running(f), 'utf8'))
const sleeper = (): ChildProcess => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(c)
  return c
}
const deadPid = async (): Promise<number> => {
  const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((r) => c.once('exit', r))
  return c.pid!
}
/** A slot file as another canvas would have left it. */
const holderFile = (n: number, pid: number, extra: Record<string, unknown> = {}) => {
  mkdirSync(running(), { recursive: true })
  writeFileSync(running(`slot-${n}.json`), JSON.stringify({ v: 1, state: 'ready', pid, instance: `held-${n}`, slot: n, port: BASE + n, origin: `http://[::1]:${BASE + n}`,
    url: `http://localhost:${BASE + n}/`, root: `/tmp/project-${n}`, name: `project-${n}`, version: '0.27.0', features: [], ws: 'a'.repeat(16), startedAt: Date.now() - 60_000, key: 'k'.repeat(43), ...extra }))
}
const input = (o: Partial<PlaceInput> = {}): PlaceInput => ({ root: '/tmp/p', name: 'p', version: '0.27.0', id: '0123456789abcdef', ws: '0123456789abcdef', instance: randomUUID(), inUse: async () => false, ...o })

type ChildResult = { ok: boolean; slot?: number | null; port?: number; notes?: string[]; fellBackFrom?: number; message?: string; child: ChildProcess }
/** A separate start: places itself in its own process, prints the result, and holds the claim until
 *  killed. `realPorts` keeps the real port check; otherwise every port counts as free. */
const starter = (o: { id?: string; explicit?: { port: number; from: 'flag' }; recover?: { port: number }; realPorts?: boolean } = {}): Promise<ChildResult> => new Promise((res, rej) => {
  const src = `const m = await import(${JSON.stringify(MODULE)});
const o = JSON.parse(process.env.MV_PLACE);
const id = o.id ?? '0123456789abcdef';
const r = await m.place({ root: '/tmp/p-' + process.pid, name: 'p-' + process.pid, version: '0.27.0', id, ws: id, instance: crypto.randomUUID(), reclaimWaitMs: 200,
  ...(o.realPorts ? {} : { inUse: async () => false }), ...(o.explicit ? { explicit: o.explicit } : {}), ...(o.recover ? { recover: o.recover } : {}) });
process.stdout.write(JSON.stringify(r.ok ? { ok: true, slot: r.claim.slot, port: r.claim.port, notes: r.notes, fellBackFrom: r.fellBackFrom } : { ok: false, message: r.message }) + '\\n');
if (r.ok) setInterval(() => {}, 1000); else process.exit(0)`
  const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', src], {
    stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MARVER_HOME: home, MARVER_SLOT_BASE: String(BASE), MV_PLACE: JSON.stringify(o) },
  })
  children.push(c)
  let out = ''
  c.stdout!.on('data', (d) => { out += d; if (out.includes('\n')) res({ ...JSON.parse(out.split('\n')[0]), child: c }) })
  c.once('error', rej)
  c.once('exit', (code) => { if (!out.includes('\n')) rej(new Error(`starter exited ${code} without a result`)) })
})
const mode = (p: string) => statSync(p).mode & 0o777

describe('the slots: claims (A1.3)', () => {
  it('twenty at once get twenty slots, each its own file: starting, mode 600, in a folder of mode 700', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => starter()))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => r.slot).sort((a, b) => a! - b!)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(mode(running())).toBe(0o700)
    for (const r of results) {
      const f = read(`slot-${r.slot}.json`)
      expect(f).toMatchObject({ v: 1, state: 'starting', pid: r.child.pid, slot: r.slot, port: BASE + r.slot!, origin: null, url: `http://localhost:${BASE + r.slot!}/`, features: [], ws: '0123456789abcdef' })
      expect(f.key).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(mode(running(`slot-${r.slot}.json`))).toBe(0o600)
    }
  }, 60_000)

  it('thirty racing for twenty dead slot files: twenty get one, ten are told all are taken, no .reclaim is left', async () => {
    const dead = await deadPid()
    for (let n = 1; n <= 20; n++) holderFile(n, dead)
    const results = await Promise.all(Array.from({ length: 30 }, () => starter()))
    const won = results.filter((r) => r.ok)
    expect(won).toHaveLength(20)
    expect(new Set(won.map((r) => r.slot)).size).toBe(20)
    for (const r of results.filter((r) => !r.ok)) expect(r.message).toMatch(/^all 20 slots are taken:/)
    expect(readdirSync(running()).filter((f) => f.endsWith('.reclaim'))).toEqual([])
    for (const r of won) expect(read(`slot-${r.slot}.json`).pid).toBe(r.child.pid)
  }, 60_000)

  it('a live holder is never taken: the claim goes to the next slot', async () => {
    holderFile(1, sleeper().pid!)
    const r = await place(input())
    expect(r.ok && r.claim.slot).toBe(2)
    expect(read('slot-1.json').instance).toBe('held-1')
  })

  it('the preference comes back: the project\'s slot while a lower one is free', async () => {
    notePrefer('0123456789abcdef', { slot: 3, url: `http://localhost:${BASE + 3}/`, bind: `http://[::1]:${BASE + 3}`, ws: '0123456789abcdef' })
    const r = await place(input())
    expect(r.ok && r.claim.slot).toBe(3)
    // another project has no such preference
    const other = await place(input({ id: 'fedcba9876543210', ws: 'fedcba9876543210' }))
    expect(other.ok && other.claim.slot).toBe(1)
  })

  for (const host of ['127.0.0.1', '::1']) {
    it(`a port another program holds (${host}) is skipped, said once - the claim never lands on it`, async () => {
      const srv = createServer()
      servers.push(srv)
      await new Promise<void>((r, j) => { srv.once('error', j); srv.listen(BASE + 1, host, () => r()) })
      const r = await starter({ realPorts: true })
      expect(r.ok).toBe(true)
      expect(r.slot).not.toBe(1)
      expect(r.notes).toContain(`port ${BASE + 1} is used by another program - slot 1 skipped`)
      expect(existsSync(running('slot-1.json'))).toBe(false)   // released, not left behind
    }, 30_000)
  }

  it('the twenty-first stops, with the list and what to do', async () => {
    const pid = sleeper().pid!
    for (let n = 1; n <= 20; n++) holderFile(n, pid)
    const r = await place(input())
    expect(r.ok).toBe(false)
    if (r.ok) return
    const lines = r.message.split('\n').map((l) => l.trim())
    expect(lines[0]).toBe('all 20 slots are taken:')
    expect(lines[1]).toMatch(/^slot\s+link\s+name\s+folder\s+version\s+state\s+up$/)
    for (let n = 1; n <= 20; n++) expect(r.message).toContain(`http://localhost:${BASE + n}/  project-${n}`)
    expect(lines.at(-1)).toBe('stop one (Ctrl-C in its terminal), or start this one with --port <n>')
    expect(readdirSync(running()).filter((f) => !/^slot-\d+\.json$/.test(f))).toEqual([])
  })

  it('a stuck .reclaim skips its slot with the repair line, and stays', async () => {
    holderFile(1, await deadPid())
    writeFileSync(running('slot-1.json.reclaim'), JSON.stringify({ pid: await deadPid(), instance: 'crashed', at: 1 }))
    const r = await place(input({ reclaimWaitMs: 50 }))
    expect(r.ok && r.claim.slot).toBe(2)
    expect(r.ok && r.notes).toEqual([`slot 1 is stuck: delete ${home}/running/slot-1.json.reclaim if no canvas is starting`])
    expect(existsSync(running('slot-1.json.reclaim'))).toBe(true)
  })

  it('a slot file that names no canvas is skipped, said, and left', async () => {
    mkdirSync(running(), { recursive: true })
    writeFileSync(running('slot-1.json'), '{"half":')
    const r = await place(input())
    expect(r.ok && r.claim.slot).toBe(2)
    expect(r.ok && r.notes).toEqual([`${home}/running/slot-1.json is unreadable - slot 1 skipped (delete it if no canvas runs there)`])
    expect(readFileSync(running('slot-1.json'), 'utf8')).toBe('{"half":')
  })

  it('ready rewrites the claim whole - same instance, same key - and release leaves a file another start holds', async () => {
    const r = await place(input())
    if (!r.ok) throw new Error(r.message)
    const before = read('slot-1.json')
    r.claim.ready(`http://[::1]:${BASE + 1}`)
    const after = read('slot-1.json')
    expect(after).toEqual({ ...before, state: 'ready', origin: `http://[::1]:${BASE + 1}` })
    expect(Buffer.from(after.key, 'base64url').equals(r.claim.key)).toBe(true)
    expect(r.claim.key).toHaveLength(32)
    expect(mode(running('slot-1.json'))).toBe(0o600)
    expect(readdirSync(running())).toEqual(['slot-1.json'])   // no temp file left
    writeFileSync(running('slot-1.json'), JSON.stringify({ ...after, instance: 'someone-else' }))
    r.claim.release()
    expect(read('slot-1.json').instance).toBe('someone-else')
    writeFileSync(running('slot-1.json'), JSON.stringify(after))
    r.claim.release()
    expect(existsSync(running('slot-1.json'))).toBe(false)
  })

  it('each file\'s release is handed over the moment it is held, before the port check', async () => {
    const held: string[] = []
    let checked = 0
    const r = await place(input({ onHold: () => { held.push(`hold ${checked}`) }, inUse: async (p) => { checked++; return p === BASE + 1 } }))
    expect(r.ok && r.claim.slot).toBe(2)
    expect(held).toEqual(['hold 0', 'hold 1'])   // slot 1 (then released: busy), slot 2
  })
})

describe('the slots: explicit ports and --recover (A1.3, A1.6)', () => {
  it('a port inside the range claims exactly that slot', async () => {
    const r = await place(input({ explicit: { port: BASE + 6, from: 'flag' } }))
    expect(r.ok && [r.claim.slot, r.claim.file]).toEqual([6, running('slot-6.json')])
  })

  it('...and while another canvas holds it, stops with who - never another slot', async () => {
    holderFile(6, sleeper().pid!)
    const r = await place(input({ explicit: { port: BASE + 6, from: 'flag' } }))
    expect(r).toEqual({ ok: false, message: `port ${BASE + 6} is slot 6, and "project-6" (/tmp/project-6) holds it - stop it first (Ctrl-C in its terminal), or start without --port` })
    expect(readdirSync(running())).toEqual(['slot-6.json'])
    const busy = await place(input({ explicit: { port: BASE + 7, from: 'config' }, inUse: async () => true }))
    expect(busy).toEqual({ ok: false, message: `port ${BASE + 7} (slot 7) is in use by another program - stop it, or remove \`port\` from design/config.ts` })
    expect(readdirSync(running())).toEqual(['slot-6.json'])
  })

  it('a port outside the range is a port file of its own; busy, it falls back to a slot and says from where', async () => {
    const own = await place(input({ explicit: { port: 47123, from: 'flag' } }))
    expect(own.ok && [own.claim.slot, own.claim.file]).toEqual([null, running('port-47123.json')])
    expect(read('port-47123.json')).toMatchObject({ slot: null, port: 47123, url: 'http://localhost:47123/' })
    const r = await place(input({ explicit: { port: 47124, from: 'flag' }, inUse: async (p) => p === 47124 }))
    expect(r.ok && [r.claim.slot, r.fellBackFrom]).toEqual([1, 47124])
    expect(existsSync(running('port-47124.json'))).toBe(false)
  })

  it('--recover takes exactly its port, or stops and says why', async () => {
    const r = await starter({ recover: { port: BASE + 2 } })
    expect(r.ok && r.slot).toBe(2)
    const again = await place(input({ recover: { port: BASE + 2 } }))
    expect(again.ok).toBe(false)
    expect(!again.ok && again.message).toMatch(new RegExp(`^port ${BASE + 2} is held by "p-${r.child.pid}" \\(/tmp/p-${r.child.pid}\\) - --recover never takes another address`))
    const busy = await place(input({ recover: { port: 47125 }, inUse: async () => true }))
    expect(busy).toEqual({ ok: false, message: 'port 47125 is in use - --recover never takes another address; stop what holds it and run it again' })
    expect(readdirSync(running()).sort()).toEqual(['slot-2.json'])
  }, 30_000)
})

describe('the preference file (A1.3)', () => {
  const id = '0123456789abcdef'
  const at = (port: number, bind = `http://[::1]:${port}`, ws = id) => ({ slot: slotOfPort(port), url: `http://localhost:${port}/`, bind, ws })

  it('a new address only when url, bind or ws differ - newest first, at most five, until moved at each start and stop', () => {
    expect(readPrefer(id)).toBeUndefined()
    expect(notePrefer(id, at(BASE + 1), 100)).toEqual({ first: true, previous: null })
    expect(notePrefer(id, at(BASE + 1), 200)).toEqual({ first: false, previous: { url: `http://localhost:${BASE + 1}/`, bind: `http://[::1]:${BASE + 1}`, ws: id, from: 100, until: 100 } })
    stopPrefer(id, at(BASE + 1), 250)
    expect(readPrefer(id)!.history).toEqual([{ url: `http://localhost:${BASE + 1}/`, bind: `http://[::1]:${BASE + 1}`, ws: id, from: 100, until: 250 }])
    notePrefer(id, at(BASE + 1, `http://127.0.0.1:${BASE + 1}`), 300)   // the bound address changed
    notePrefer(id, at(BASE + 1, `http://127.0.0.1:${BASE + 1}`, 'feedfacefeedface'), 400)   // the workspace changed
    for (const [n, t] of [[2, 500], [3, 600], [4, 700]]) notePrefer(id, at(BASE + n), t)
    const p = readPrefer(id)!
    expect(p.slot).toBe(4)
    expect(p.history.map((a) => [a.url, a.bind, a.ws, a.from])).toEqual([
      [`http://localhost:${BASE + 4}/`, `http://[::1]:${BASE + 4}`, id, 700],
      [`http://localhost:${BASE + 3}/`, `http://[::1]:${BASE + 3}`, id, 600],
      [`http://localhost:${BASE + 2}/`, `http://[::1]:${BASE + 2}`, id, 500],
      [`http://localhost:${BASE + 1}/`, `http://127.0.0.1:${BASE + 1}`, 'feedfacefeedface', 400],
      [`http://localhost:${BASE + 1}/`, `http://127.0.0.1:${BASE + 1}`, id, 300],
    ])
    // a stop that is not the newest entry's changes nothing
    stopPrefer(id, at(BASE + 2), 800)
    expect(readPrefer(id)!.history[2].until).toBe(500)
    expect(mode(join(home, 'prefer', `${id}.json`))).toBe(0o600)
    expect(mode(join(home, 'prefer'))).toBe(0o700)
  })

  it('a run on a port of its own keeps the slot it preferred', () => {
    notePrefer(id, at(BASE + 5), 1)
    notePrefer(id, { slot: null, url: 'http://localhost:47123/', bind: 'http://[::1]:47123', ws: id }, 2)
    expect(readPrefer(id)!.slot).toBe(5)
  })

  it('a corrupt file reads as unreadable - not a first run - and the next write replaces it', () => {
    mkdirSync(join(home, 'prefer'), { recursive: true })
    writeFileSync(join(home, 'prefer', `${id}.json`), '{"v":1,"slot":99')
    expect(readPrefer(id)).toBeNull()
    expect(notePrefer(id, at(BASE + 1), 5)).toEqual({ first: false, previous: null })
    expect(readPrefer(id)).toEqual({ v: 1, slot: 1, history: [{ url: `http://localhost:${BASE + 1}/`, bind: `http://[::1]:${BASE + 1}`, ws: id, from: 5, until: 5 }] })
  })

  it('ten projects writing their preferences at once all survive whole', async () => {
    const ids = Array.from({ length: 10 }, (_, k) => `${'0'.repeat(15)}${k.toString(16)}`)
    const src = `const m = await import(${JSON.stringify(MODULE)});
for (let i = 0; i < 20; i++) m.notePrefer(process.env.MV_ID, { slot: 1 + (i % 20), url: 'http://localhost:' + (${BASE} + 1 + (i % 20)) + '/', bind: 'http://[::1]:' + (${BASE} + 1 + (i % 20)), ws: process.env.MV_ID })`
    await Promise.all(ids.map((mvId) => new Promise((r, j) => {
      const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', src], { stdio: 'inherit', env: { ...process.env, MARVER_HOME: home, MARVER_SLOT_BASE: String(BASE), MV_ID: mvId } })
      children.push(c)
      c.once('exit', (code) => code === 0 ? r(null) : j(new Error(`exit ${code}`)))
    })))
    for (const k of ids) {
      const p = readPrefer(k)!
      expect(p.slot).toBe(20)
      expect(p.history).toHaveLength(5)
      expect(p.history.every((a) => a.ws === k)).toBe(true)
    }
    expect(readdirSync(join(home, 'prefer')).sort()).toEqual(ids.map((k) => `${k}.json`).sort())
  }, 30_000)
})

describe('--recover\'s entries (A1.6)', () => {
  it('the history newest first, then the address 0.26 gave the folder - always last', () => {
    const root = '/Users/someone/project'
    const id = workspaceId(root)   // no such path: the root as given
    expect(recoverEntries(root)).toEqual([legacyEntry(root)])
    expect(legacyEntry(root)).toEqual({ url: `http://localhost:${legacyPort(root)}/`, bind: `http://localhost:${legacyPort(root)}`, ws: legacyWorkspace(root), legacy: true })
    notePrefer(id, { slot: 2, url: `http://localhost:${BASE + 2}/`, bind: `http://[::1]:${BASE + 2}`, ws: id }, 1)
    notePrefer(id, { slot: 3, url: `http://localhost:${BASE + 3}/`, bind: `http://127.0.0.1:${BASE + 3}`, ws: id }, 2)
    expect(recoverEntries(root).map((e) => e.url)).toEqual([`http://localhost:${BASE + 3}/`, `http://localhost:${BASE + 2}/`, `http://localhost:${legacyPort(root)}/`])
  })

  it('an entry names exactly what to bind', () => {
    expect(recoverTarget({ url: 'http://localhost:4806/', bind: 'http://[::1]:4806', ws: 'a'.repeat(16) })).toEqual({ port: 4806, host: '::1', ws: 'a'.repeat(16), url: 'http://localhost:4806/', bind: 'http://[::1]:4806' })
    expect(recoverTarget({ url: 'http://localhost:4807/', bind: 'http://127.0.0.1:4807', ws: 'b'.repeat(16) })).toMatchObject({ port: 4807, host: '127.0.0.1' })
    expect(recoverTarget(legacyEntry('/x', 5287))).toEqual({ port: 5287, ws: legacyWorkspace('/x'), url: 'http://localhost:5287/', bind: 'http://localhost:5287' })
  })
})

describe('ports and the list', () => {
  it('0.26\'s hash port, pinned', () => {
    expect(legacyPort('/Users/someone/atlas-app')).toBe(5200 + (Math.abs([...'/Users/someone/atlas-app'].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 0)) % 200))
    expect(legacyPort('/a')).toBe(5354)   // (47 * 31 + 97) % 200 = 154
  })

  it('the slot range moves only with a sane MARVER_SLOT_BASE', () => {
    expect(slotBase()).toBe(BASE)
    expect([slotPort(1), slotPort(20), slotOfPort(BASE + 1), slotOfPort(BASE + 20), slotOfPort(BASE), slotOfPort(BASE + 21)]).toEqual([BASE + 1, BASE + 20, 1, 20, null, null])
    for (const bad of ['', 'abc', '80', '65530', '4804.5']) {
      process.env.MARVER_SLOT_BASE = bad
      expect(slotBase()).toBe(4804)
    }
    expect([slotOfPort(4805), slotOfPort(4824), slotOfPort(4825)]).toEqual([1, 20, null])
  })

  it('the list hides dead pids and keeps the key out', async () => {
    holderFile(2, sleeper().pid!)
    holderFile(1, await deadPid())
    const list = readRunning()
    expect(list.map((r) => r.slot)).toEqual([2])
    expect(list[0]).not.toHaveProperty('key')
    expect(list[0]).not.toHaveProperty('instance')
    const lines = formatRunning(list, list[0].startedAt + 3_723_000)
    expect(lines[1]).toMatch(new RegExp(`^ {3}2  http://localhost:${BASE + 2}/  project-2  /tmp/project-2  0.27.0   ready  1h 2m$`))
  })
})
