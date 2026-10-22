import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { CLI, fixtureRoot, runDev, startDev, type Dev } from './dev-server.ts'
import { portInUse } from '../src/server/exclusive.ts'
import { findChrome } from '../src/server/cdp.ts'
import { collabFileFor } from '../src/server/sync.ts'
import { workspaceId } from '../src/server/workspace.ts'

/**
 * The slots, end to end (spec 28 A1.3, A1.10): real `marver dev` starts from dist/ on a registry of
 * their own, with the twenty slots moved to the suite's own in the run's block (test/global-setup.ts).
 * Two projects take slots 1 and 2 and get them back; a canvas killed hard is reclaimed; a busy port of
 * its own falls back to a slot and a held port in the range stops the start; the published slot file
 * signs the shell's document (A1.4); and what runs against a canvas - work, link, shot, Live Jam's audio
 * socket (across a Vite restart too) and a capture - works on a slot.
 */

const BASE = inject('marverSlotBases').slotsDev
let home = ''
const env = (extra: NodeJS.ProcessEnv = {}) => ({ MARVER_HOME: home, MARVER_SLOT_BASE: String(BASE), ...extra })
const roots: string[] = []
const devs: Dev[] = []
const children: ChildProcess[] = []
const servers: Server[] = []
beforeAll(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'mv-slotsdev-home-'))) })
afterEach(async () => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
})
afterAll(async () => {
  for (const d of devs.splice(0)) await d.stop('SIGKILL')
  for (const r of [home, ...roots]) rmSync(r, { recursive: true, force: true })
})

const FRAME = `export const meta = { title: 'One', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>One</h1></main>\n`
const project = (prefix: string, config = 'export default { jam: false }\n') => {
  const r = fixtureRoot(prefix, {
    'design/config.ts': config,
    'design/scenes/demo/one.tsx': FRAME,
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [{ key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 }] }),
  })
  roots.push(r)
  return r
}
const start = async (root: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) => { const d = await startDev(root, { args, env: env(extra) }); devs.push(d); return d }
const stop = async (d: Dev, signal: NodeJS.Signals = 'SIGINT') => { await d.stop(signal); devs.splice(devs.indexOf(d), 1) }
const running = (f = '') => join(home, 'running', f)
const record = (f: string) => JSON.parse(readFileSync(running(f), 'utf8'))
const cli = (args: string[], root: string) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile(process.execPath, [CLI, ...args, '--root', root], { cwd: root, env: { ...process.env, ...env(), CI: '1' }, timeout: 120_000 }, (err, stdout, stderr) =>
    resolve({ code: err ? Number((err as any).code) || 1 : 0, out: stdout + stderr }))
})
const occupy = async (port: number) => {
  const s = createServer()
  servers.push(s)
  await new Promise<void>((r, j) => { s.once('error', j); s.listen(port, '127.0.0.1', () => r()) })
}
const freePort = async (from: number) => { let p = from + Math.floor(Math.random() * 500); while (await portInUse(p)) p++; return p }
const sleeper = () => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); children.push(c); return c.pid! }

describe('two projects on the slots (A1.3)', () => {
  let a = '', b = ''
  let devA: Dev, devB: Dev
  beforeAll(async () => {
    a = project('mv-slots-a-')
    b = project('mv-slots-b-')
    devA = await start(a)
    devB = await start(b)
  }, 120_000)

  it('take slots 1 and 2, each published ready with the address it bound, its workspace and a key of its own', () => {
    expect([devA.port, devB.port]).toEqual([BASE + 1, BASE + 2])
    for (const [n, root] of [[1, a], [2, b]] as const) {
      const f = record(`slot-${n}.json`)
      expect(f).toMatchObject({ v: 1, state: 'ready', slot: n, port: BASE + n, url: `http://localhost:${BASE + n}/`, root, ws: workspaceId(root), features: [], version: expect.stringMatching(/^\d+\.\d+\.\d+/) })
      expect(f.origin).toMatch(new RegExp(`^http://(\\[::1\\]|127\\.0\\.0\\.1):${BASE + n}$`))
      expect(f.key).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(statSync(running(`slot-${n}.json`)).mode & 0o777).toBe(0o600)
    }
    expect(statSync(running()).mode & 0o777).toBe(0o700)
    expect(devA.out()).toContain(`ports are now fixed slots: this canvas is at http://localhost:${BASE + 1}/`)
  })

  it('the shell\'s document, asked for with a nonce, is signed with the slot file\'s key (A1.4)', async () => {
    const f = record('slot-1.json')
    const nonce = randomBytes(24).toString('base64url')
    const res = await fetch(`${devA.origin}/`, { headers: { 'x-mv-nonce': nonce } })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-mv-instance')).toBe(f.instance)
    expect(res.headers.get('x-mv-proof')).toBe(createHmac('sha256', Buffer.from(f.key, 'base64url')).update(`doc|${nonce}|${f.port}`).digest('base64url'))
    const plain = await fetch(`${devA.origin}/`)
    expect(plain.headers.get('x-mv-proof')).toBeNull()
    // the registry itself is never served, whatever the path - refused by the registry's own guard, which runs
    // before Vite's (this home is outside the canvas's allowed folders, so Vite would refuse it too)
    const leak = await fetch(`${devA.origin}/@fs${running('slot-1.json')}`)
    expect([leak.status, await leak.text()]).toEqual([403, 'the canvas registry (~/.marver) is never served'])
  })

  it('marver ls lists them both, without their keys', async () => {
    const { code, out } = await new Promise<{ code: number; out: string }>((resolve) => execFile(process.execPath, [CLI, 'ls', '--json'], { env: { ...process.env, ...env() } }, (err, stdout) => resolve({ code: err ? 1 : 0, out: stdout })))
    expect(code).toBe(0)
    expect(JSON.parse(out).canvases.map((c: any) => [c.slot, c.url, c.folder, c.state])).toEqual([[1, `http://localhost:${BASE + 1}/`, a, 'ready'], [2, `http://localhost:${BASE + 2}/`, b, 'ready']])
    expect(out).not.toContain(record('slot-1.json').key)
  })

  it('what runs against a canvas works on a slot: marver work, marver link, marver shot', async () => {
    const work = await cli(['work', 'start', 'demo/one'], a)
    expect(work.code, work.out).toBe(0)
    expect(work.out).toContain('working: demo/one')
    expect((await cli(['work', 'done', '--all'], a)).code).toBe(0)
    const link = await cli(['link', 'demo/one'], a)
    expect(link.code, link.out).toBe(0)
    expect(link.out).toContain(`http://localhost:${BASE + 1}/#`)
    if (!findChrome()) throw new Error('Chrome is installed on this Mac - a shot must run here')
    const shot = await cli(['shot', 'demo/one'], a)
    expect(shot.code, shot.out).toBe(0)
    expect(shot.out).toMatch(/\.png/)
  }, 180_000)

  it('stopped, they give their slots back; started the other way round, each gets its own slot back', async () => {
    await stop(devA)
    await stop(devB)
    expect(readdirSync(running())).toEqual([])
    devB = await start(b)
    devA = await start(a)
    expect([devA.port, devB.port]).toEqual([BASE + 1, BASE + 2])
    expect(devB.out()).not.toContain('last run was at')   // the same address as last time
  }, 120_000)

  it('a canvas killed hard leaves its file; the next start reclaims the same slot', async () => {
    await stop(devB, 'SIGKILL')
    expect(record('slot-2.json').pid).toBe(devB.proc.pid)
    devB = await start(b)
    expect(devB.port).toBe(BASE + 2)
    expect(record('slot-2.json').pid).toBe(devB.proc.pid)
    expect(readdirSync(running()).filter((f) => f.includes('.reclaim'))).toEqual([])
  }, 120_000)

  it('a port inside the range claims that exact slot - and stops, never elsewhere, while another canvas holds it', async () => {
    await stop(devB)
    const c = project('mv-slots-c-')
    const devC = await start(c, ['--port', String(BASE + 6)])
    expect(devC.port).toBe(BASE + 6)
    expect(record('slot-6.json').root).toBe(c)
    const { code, out } = await runDev(b, { args: ['--port', String(BASE + 6)], env: env() })
    expect(code).toBe(1)
    expect(out).toContain(`port ${BASE + 6} is slot 6, and "${c.split('/').pop()}" (${c}) holds it - stop it first (Ctrl-C in its terminal), or start without --port`)
    expect(out).not.toMatch(/→ http:\/\/localhost:/)
    expect(readdirSync(running()).sort()).toEqual(['slot-1.json', 'slot-6.json'])
    await stop(devC)
  }, 120_000)

  it('a project whose slot is taken moves, and says where it was last', async () => {
    await stop(devA)
    const fake = sleeper()
    writeFileSync(running('slot-1.json'), JSON.stringify({ v: 1, state: 'ready', pid: fake, instance: 'fake', slot: 1, port: BASE + 1, origin: null, url: `http://localhost:${BASE + 1}/`, root: '/tmp/x', name: 'x', version: '0', features: [], ws: 'd'.repeat(16), startedAt: Date.now(), key: '' }))
    devA = await start(a)
    expect(devA.port).toBe(BASE + 2)
    expect(devA.out()).toMatch(new RegExp(`last run was at http://localhost:${BASE + 1}/ \\(bound http://[^)]+\\) - a Jam capture left unsent there: npx marver dev --recover`))
    await stop(devA)
    rmSync(running('slot-1.json'))
  }, 120_000)
})

describe('ports of their own (A1.3)', () => {
  it('a busy --port falls back to a slot and says so; nothing is registered for the busy port', async () => {
    const r = project('mv-slots-busy-')
    const p = await freePort(47_000)
    await occupy(p)
    const d = await start(r, ['--port', String(p)])
    expect(d.port).toBe(BASE + 1)
    expect(d.out()).toContain(`port ${p} is in use - serving "${r.split('/').pop()}" on slot 1 instead`)
    expect(existsSync(running(`port-${p}.json`))).toBe(false)
    await stop(d)
  }, 120_000)

  it('a free --port outside the range is a port file of its own, gone when it stops', async () => {
    const r = project('mv-slots-own-')
    const p = await freePort(47_500)
    const d = await start(r, ['--port', String(p)])
    expect(d.port).toBe(p)
    expect(record(`port-${p}.json`)).toMatchObject({ slot: null, port: p, state: 'ready', url: `http://localhost:${p}/` })
    await stop(d)
    expect(existsSync(running(`port-${p}.json`))).toBe(false)
  }, 120_000)

  it('a port in design/config.ts is kept, and the start says how to move to the slots', async () => {
    const p = await freePort(48_000)
    const r = project('mv-slots-config-', `export default { port: ${p}, jam: false }\n`)
    const d = await start(r)
    expect(d.port).toBe(p)
    expect(existsSync(running(`port-${p}.json`))).toBe(true)
    expect(d.out()).toContain(`this canvas keeps its own port (${p} in design/config.ts); remove it to use the slots`)
    expect(d.out()).not.toContain('ports are now fixed slots')
    await stop(d)
  }, 120_000)
})

describe('the registry is never served (A1.13 #5)', () => {
  it('a MARVER_HOME inside the project: its files answer 403 by every path', async () => {
    const r = project('mv-slots-inner-')
    const inner = join(r, '.mv-home')
    const d = await startDev(r, { env: { MARVER_HOME: inner, MARVER_SLOT_BASE: String(BASE) } })
    devs.push(d)
    const key = JSON.parse(readFileSync(join(inner, 'running', 'slot-1.json'), 'utf8')).key
    // every way Vite finds a file: the name as asked, its extension and index resolution (an extensionless
    // `?import` resolves to slot-1.json), the asset queries, /@fs/, and a link elsewhere in the project
    symlinkSync(join(inner, 'running', 'slot-1.json'), join(r, 'linked.json'))
    const paths = [
      '/.mv-home/running/slot-1.json', `/@fs${inner}/running/slot-1.json`, '/.mv-home/running/../running/slot-1.json',
      '/.mv-home/running/slot-1?import', '/.mv-home/running/slot-1', `/@fs${inner}/running/slot-1?import`, `/@fs${inner}/running/slot-1`,
      ...['?import', '?raw', '?url', '?inline', '?raw&import', '?url&import', '?inline&import'].flatMap((q) => [`/.mv-home/running/slot-1.json${q}`, `/@fs${inner}/running/slot-1.json${q}`]),
      '/linked?import', '/linked.json?import', '/linked.json?raw',
      `/@id/${inner}/running/slot-1?import`, '/@id/.mv-home/running/slot-1?import', '/.mv-home/running?import', '/.mv-home?import',
    ]
    for (const path of paths) {
      const res = await fetch(`${d.origin}${path}`)
      const body = await res.text()
      expect(body, path).not.toContain(key)
      expect(res.status, path).toBe(403)
    }
    await stop(d)
  }, 120_000)

  it('with MARVER_HOME moved, the ~/.marver in the home folder is refused too', async () => {
    const r = project('mv-slots-realhome-')
    const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'mv-slots-fakehome-')))
    roots.push(fakeHome)
    mkdirSync(join(fakeHome, '.marver', 'canvases'), { recursive: true })
    writeFileSync(join(fakeHome, '.marver', 'canvases', 'x.json'), '{"token":"a-secret"}')
    const d = await start(r, [], { HOME: fakeHome })
    const res = await fetch(`${d.origin}/@fs${fakeHome}/.marver/canvases/x.json`)
    expect([res.status, await res.text()]).toEqual([403, 'the canvas registry (~/.marver) is never served'])
    await stop(d)
  }, 120_000)
})

describe('Live Jam on a slot (A1.10)', () => {
  it('the audio socket opens with a ticket - after a Vite restart too - and a capture carrying the project\'s workspace passes its check', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'mv-slots-bin-'))
    roots.push(bin)
    writeFileSync(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: "result", result: "" }) + "\\n")\n')
    chmodSync(join(bin, 'claude'), 0o755)
    const r = project('mv-slots-jam-', "export default { jam: { agent: 'claude' } }\n")
    const d = await start(r, [], { PATH: `${bin}:${process.env.PATH}` })
    expect(d.port).toBe(BASE + 1)
    const owner = { 'content-type': 'application/json', cookie: 'mv_c=tok', 'x-mv-c': 'tok', origin: d.origin }
    const audio = async () => {
      const t = await fetch(`${d.origin}/__mv/api/jam/audio-ticket`, { method: 'POST', headers: owner, body: '{}' })
      expect(t.status).toBe(200)
      const { ticket } = await t.json()
      return new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${d.port}/__mv/api/jam/audio?ticket=${ticket}`, { headers: { origin: d.origin, cookie: 'mv_c=tok' } })
        ws.once('open', () => { ws.close(); resolve(true) })
        ws.once('error', () => resolve(false))
        ws.once('unexpected-response', () => resolve(false))
        setTimeout(() => { ws.terminate(); resolve(false) }, 10_000)   // an upgrade nobody handles is never answered
      })
    }
    expect(await audio()).toBe(true)
    // an .env edit restarts Vite in place: the socket goes with the new server, and the slot stays the canvas's
    writeFileSync(join(r, '.env'), 'MV_RESTART=1\n')
    for (let by = Date.now() + 30_000; Date.now() < by && !/server restarted/.test(d.out()); await new Promise((res) => setTimeout(res, 100)));
    expect(d.out()).toMatch(/server restarted/)
    expect(await audio()).toBe(true)
    expect(record('slot-1.json')).toMatchObject({ state: 'ready', pid: d.proc.pid })
    const capture = (workspace: string) => fetch(`${d.origin}/__mv/api/jam/capture`, { method: 'POST', headers: owner, body: JSON.stringify({ workspace, record: {} }) })
      .then(async (res) => ({ status: res.status, json: await res.json() }))
    const own = await capture(workspaceId(r))
    expect(own.json.error ?? '').not.toMatch(/another workspace|not running/)
    expect(await capture('feedfacefeedface')).toEqual({ status: 409, json: { error: 'this capture was made in another workspace' } })
    await stop(d)
  }, 120_000)

  it('collaboration sync is unaffected: its credential is keyed by the project\'s real path, never by a port (and lives in the suite\'s home)', () => {
    const r = roots.find((x) => x.includes('mv-slots-a-'))!
    expect(collabFileFor(r)).toBe(join(process.env.MARVER_HOME!, 'canvases', `${createHash('sha256').update(realpathSync(r)).digest('hex').slice(0, 32)}.json`))
  })
})
