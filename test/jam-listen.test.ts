/**
 * Claude Code's listener (`marver jam listen`), run as a process against a fake inbox socket: every ping names
 * its request (Claude Code drops a message identical to the one before it from the same sender), a new offer
 * pings again at the same count, and an upgraded package hands over to a fresh listener on the new code.
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connId, writeOffers } from '../src/server/jam/conn.ts'
import { claimListener, handOver, readListener, releaseListener } from '../src/server/jam/listener.ts'
import { installedBuild, packageOf } from '../src/cli/jam.ts'

const CLI = join(__dirname, '..', 'src', 'cli', 'index.ts')
const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 50)) }
  return ok()
}

describe('jam listen', { timeout: 40_000 }, () => {
  it('names each request, pings per new offer, and restarts itself on a new package version', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-jam-listen-')))
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    const sock = join(root, 'inbox.sock')
    const got: string[] = []
    const server = createServer((c) => {
      let buf = ''
      c.on('data', (d) => {
        buf += d
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
          if (m.type === 'user') got.push(m.message.content)
        }
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    const pkg = join(root, 'pkg.json')
    writeFileSync(pkg, JSON.stringify({ version: '1.0.0' }))
    const session = randomUUID()
    const env = { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: sock, CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: 'cli', MARVER_JAM_PKG: pkg }
    delete (env as any).MARVER_JAM_BACKGROUND; delete (env as any).MARVER_JAM
    const p = spawn(process.execPath, [CLI, 'jam', 'listen', '--root', root], { env, stdio: ['pipe', 'ignore', 'inherit'] })
    p.stdin.end(JSON.stringify({ session_id: session, hook_event_name: 'SessionStart', cwd: root, permission_mode: 'default' }))
    const id = connId('claude', session)
    try {
      expect(await until(() => readListener(root, process.pid)?.pid === p.pid)).toBe(true)
      writeOffers(root, id, { n: 1, gen: 10, latest: { id: 'aaaa1111', title: 'Intro frame redesign' } })
      expect(await until(() => got.length === 1)).toBe(true)
      expect(got[0]).toContain('"Intro frame redesign" (aaaa1111)')
      // the next run at the same count: a new generation, a new name - pinged again, and never the same words
      writeOffers(root, id, { n: 1, gen: 11, latest: { id: 'bbbb2222', title: 'Citing skills versus coding agents' } })
      expect(await until(() => got.length === 2)).toBe(true)
      expect(got[1]).not.toBe(got[0])
      // an upgrade: this listener hands over to a fresh one, which holds the lock for the same session
      writeFileSync(pkg, JSON.stringify({ version: '1.0.1' }))
      expect(await until(() => p.exitCode !== null)).toBe(true)
      expect(await until(() => { const l = readListener(root, process.pid); return !!l && l.pid !== p.pid && l.session === session })).toBe(true)
      const next = readListener(root, process.pid)!.pid
      writeOffers(root, id, { n: 1, gen: 12, latest: { id: 'cccc3333', title: 'Session record' } })
      expect(await until(() => got.length === 3)).toBe(true)
      expect(got[2]).toContain('"Session record"')
      try { process.kill(next, 'SIGTERM') } catch { /* gone */ }
    } finally {
      try { p.kill() } catch { /* gone */ }
      const l = readListener(root, process.pid); if (l) try { process.kill(l.pid, 'SIGTERM') } catch { /* gone */ }
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
    void readFileSync
  })

  it('the same words again say so; a second "give it back" reaches the session; an install under way never hands over', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-jam-listen-')))
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    const sock = join(root, 'inbox.sock')
    const got: string[] = []
    const server = createServer((c) => {
      let buf = ''
      c.on('data', (d) => {
        buf += d
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
          if (m.type === 'user') got.push(m.message.content)
        }
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    const pkg = join(root, 'pkg.json')
    writeFileSync(pkg, JSON.stringify({ version: '1.0.0' }))
    const session = randomUUID()
    const env = { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: sock, CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: 'cli', MARVER_JAM_PKG: pkg }
    delete (env as any).MARVER_JAM_BACKGROUND; delete (env as any).MARVER_JAM
    const p = spawn(process.execPath, [CLI, 'jam', 'listen', '--root', root], { env, stdio: ['pipe', 'ignore', 'inherit'] })
    p.stdin.end(JSON.stringify({ session_id: session, hook_event_name: 'SessionStart', cwd: root, permission_mode: 'default' }))
    const id = connId('claude', session)
    try {
      expect(await until(() => readListener(root, process.pid)?.pid === p.pid)).toBe(true)
      // the same run offered back (another session picked, then this one again): the same words, said to be again
      writeOffers(root, id, { n: 1, gen: 10, latest: { id: 'aaaa1111', title: 'Intro frame redesign' } })
      expect(await until(() => got.length === 1)).toBe(true)
      writeOffers(root, id, { n: 1, gen: 11, latest: { id: 'aaaa1111', title: 'Intro frame redesign' } })
      expect(await until(() => got.length === 2)).toBe(true)
      expect(got[1]).toBe(`${got[0]} (again)`)
      // "give it back" twice: the carry-on clears when the session acts on it (no new generation), the second reaches it
      writeOffers(root, id, { n: 0, gen: 12, resume: ['r-aaaa1111.1'] })
      expect(await until(() => got.length === 3)).toBe(true)
      expect(got[2]).toContain('gave r-aaaa1111.1 back to you')
      writeOffers(root, id, { n: 0, gen: 12 })
      await new Promise((r) => setTimeout(r, 1_500))
      writeOffers(root, id, { n: 0, gen: 13, resume: ['r-aaaa1111.1'] })
      expect(await until(() => got.length === 4)).toBe(true)
      expect(got[3]).toBe(`${got[2]} (again)`)
      // an install under way: the package unreadable for a while, then the same version - never a handover
      unlinkSync(pkg)
      await new Promise((r) => setTimeout(r, 2_500))
      writeFileSync(pkg, JSON.stringify({ version: '1.0.0' }))
      await new Promise((r) => setTimeout(r, 2_500))
      expect([p.exitCode, readListener(root, process.pid)?.pid]).toEqual([null, p.pid])
      // the new version, once it holds: handed over
      writeFileSync(pkg, JSON.stringify({ version: '1.0.1' }))
      expect(await until(() => p.exitCode !== null)).toBe(true)
      expect(await until(() => { const l = readListener(root, process.pid); return !!l && l.pid !== p.pid && l.session === session })).toBe(true)
      try { process.kill(readListener(root, process.pid)!.pid, 'SIGTERM') } catch { /* gone */ }
    } finally {
      try { p.kill() } catch { /* gone */ }
      const l = readListener(root, process.pid); if (l) try { process.kill(l.pid, 'SIGTERM') } catch { /* gone */ }
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('started by a prompt far past a pipe\'s 64 KB, it hands its successor the whole input before it goes', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-jam-listen-')))
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    const sock = join(root, 'inbox.sock')
    const server = createServer(() => { /* the inbox: nothing posted in this test */ })
    await new Promise<void>((r) => server.listen(sock, r))
    const pkg = join(root, 'pkg.json')
    writeFileSync(pkg, JSON.stringify({ version: '1.0.0' }))
    const session = randomUUID()
    const env = { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: sock, CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: 'cli', MARVER_JAM_PKG: pkg }
    delete (env as any).MARVER_JAM_BACKGROUND; delete (env as any).MARVER_JAM
    const p = spawn(process.execPath, [CLI, 'jam', 'listen', '--root', root], { env, stdio: ['pipe', 'ignore', 'inherit'] })
    // UserPromptSubmit carries the prompt: half a megabyte of it
    p.stdin.end(JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', cwd: root, permission_mode: 'default', prompt: 'x'.repeat(512 * 1024) }))
    try {
      expect(await until(() => readListener(root, process.pid)?.pid === p.pid)).toBe(true)
      writeFileSync(pkg, JSON.stringify({ version: '1.0.1' }))
      // it goes only once its successor - a whole process starting - has read all of it: slow under a loaded suite
      expect(await until(() => p.exitCode !== null, 40_000)).toBe(true)
      expect(await until(() => { const l = readListener(root, process.pid); return !!l && l.pid !== p.pid && l.session === session }, 20_000)).toBe(true)
    } finally {
      try { p.kill() } catch { /* gone */ }
      const l = readListener(root, process.pid); if (l) try { process.kill(l.pid, 'SIGTERM') } catch { /* gone */ }
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  it('a successor that fails as it starts never leaves the session with no listener: the old one holds on, and hands over once the new one starts', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-jam-listen-')))
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    const sock = join(root, 'inbox.sock')
    const got: string[] = []
    const server = createServer((c) => {
      let buf = ''
      c.on('data', (d) => {
        buf += d
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
          if (m.type === 'user') got.push(m.message.content)
        }
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    const pkg = join(root, 'pkg.json')
    writeFileSync(pkg, JSON.stringify({ version: '1.0.0' }))
    // the command the hook runs: a link to the CLI, so the build under it can break mid-install
    const entry = join(root, 'cli.ts'), tried = join(root, 'tried.txt')
    symlinkSync(CLI, entry)
    const session = randomUUID()
    const env = { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: sock, CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: 'cli', MARVER_JAM_PKG: pkg }
    delete (env as any).MARVER_JAM_BACKGROUND; delete (env as any).MARVER_JAM
    const p = spawn(process.execPath, [entry, 'jam', 'listen', '--root', root], { env, stdio: ['pipe', 'ignore', 'inherit'] })
    p.stdin.end(JSON.stringify({ session_id: session, hook_event_name: 'SessionStart', cwd: root, permission_mode: 'default' }))
    const id = connId('claude', session)
    try {
      expect(await until(() => readListener(root, process.pid)?.pid === p.pid)).toBe(true)
      // an upgrade whose new build cannot start yet (a file it imports is not there): the successor dies at once
      unlinkSync(entry)
      writeFileSync(entry, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(tried)}, 'x')\nthrow new Error('a package file is missing mid-install')\n`)
      writeFileSync(pkg, JSON.stringify({ version: '1.0.1' }))
      expect(await until(() => existsSync(tried), 20_000)).toBe(true)
      // the old listener still holds the session, and still pings it
      expect(await until(() => readListener(root, process.pid)?.pid === p.pid, 5_000)).toBe(true)
      expect(p.exitCode).toBeNull()
      writeOffers(root, id, { n: 1, gen: 10, latest: { id: 'aaaa1111', title: 'Intro frame redesign' } })
      expect(await until(() => got.length === 1)).toBe(true)
      // the install done: the next try hands over
      unlinkSync(entry); symlinkSync(CLI, entry)
      expect(await until(() => p.exitCode !== null, 30_000)).toBe(true)
      expect(await until(() => { const l = readListener(root, process.pid); return !!l && l.pid !== p.pid && l.session === session }, 20_000)).toBe(true)
    } finally {
      try { p.kill() } catch { /* gone */ }
      const l = readListener(root, process.pid); if (l) try { process.kill(l.pid, 'SIGTERM') } catch { /* gone */ }
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})

describe('a handover at its deadline', () => {
  it('a successor that takes the lock just as it is stopped never leaves the session with no listener: the old one waits for it to be gone, then takes the lock back', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-jam-listen-')))
    mkdirSync(join(root, 'design', '.local'), { recursive: true })
    // a successor slow to start: it claims the lock between the old one's last look and its stop - the signal lands
    // later (SIGTERM is asynchronous), and it lets the lock go as it dies
    const slow = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    let gone = false
    slow.on('exit', () => { gone = true })
    const next = { pid: slow.pid, gone: () => gone, kill: (signal?: NodeJS.Signals) => {
      claimListener(root, process.pid, { pid: slow.pid!, session: 's' })
      setTimeout(() => { releaseListener(root, process.pid, slow.pid!); slow.kill(signal) }, 300)
    } }
    try {
      // it held nothing in time: stopped - and the old one listens on, holding the lock
      expect(await handOver(root, process.pid, { pid: process.pid, session: 's' }, next, 300)).toBe(false)
      expect(gone).toBe(true)
      expect(readListener(root, process.pid)?.pid).toBe(process.pid)
    } finally {
      try { slow.kill('SIGKILL') } catch { /* gone */ }
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the build a listener runs', () => {
  it('is read through the path it was started by - pnpm\'s link, npm\'s .bin link - so an upgrade shows; a preview at the same version too', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-jam-pkg-')))
    const saved = process.env.MARVER_JAM_PKG
    delete process.env.MARVER_JAM_PKG
    try {
      const store = (v: string) => { const d = join(root, 'node_modules', '.pnpm', `m@${v}`, 'node_modules', 'm'); mkdirSync(join(d, 'dist'), { recursive: true }); writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'm', version: v })); writeFileSync(join(d, 'dist', 'cli.mjs'), `// ${v}`); return d }
      const link = join(root, 'node_modules', 'm')
      symlinkSync(store('1.0.0'), link)
      mkdirSync(join(root, 'node_modules', '.bin'))
      symlinkSync('../m/dist/cli.mjs', join(root, 'node_modules', '.bin', 'm'))
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'project', version: '9.9.9' }))
      // pnpm's shim runs node_modules/m/dist/cli.mjs (through the link); npm's .bin/m is a link to it
      const viaShim = packageOf(join(link, 'dist', 'cli.mjs'))!
      const viaBin = packageOf(join(root, 'node_modules', '.bin', 'm'))!
      expect(viaShim).toEqual({ dir: link, main: join('dist', 'cli.mjs') })
      expect(viaBin).toEqual(viaShim)
      const before = installedBuild(viaShim)!
      expect(before.startsWith('1.0.0:')).toBe(true)
      // upgraded: the link points at the new version's folder; the old one stays (pnpm keeps it a while)
      unlinkSync(link); symlinkSync(store('1.0.1'), link)
      expect(installedBuild(viaShim)!.startsWith('1.0.1:')).toBe(true)
      // a preview repacked at the same version: a new entry file - a new build
      unlinkSync(link); const again = store('1.0.1-same'); writeFileSync(join(again, 'package.json'), JSON.stringify({ name: 'm', version: '1.0.0' })); symlinkSync(again, link)
      expect(installedBuild(viaShim)).not.toBe(before)
      // mid-install (the folder moved aside): unknown, never the project's version
      unlinkSync(link)
      expect(installedBuild(viaShim)).toBeNull()
    } finally {
      if (saved !== undefined) process.env.MARVER_JAM_PKG = saved
      rmSync(root, { recursive: true, force: true })
    }
  })
})
