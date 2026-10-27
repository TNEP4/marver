/**
 * Claude Code's listener (`marver jam listen`), run as a process against a fake inbox socket: every ping names
 * its request (Claude Code drops a message identical to the one before it from the same sender), a new offer
 * pings again at the same count, and an upgraded package hands over to a fresh listener on the new code.
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connId, writeOffers } from '../src/server/jam/conn.ts'
import { readListener } from '../src/server/jam/listener.ts'

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
})
