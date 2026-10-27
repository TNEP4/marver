/**
 * Claude Code's listener (`marver jam listen`), run as a process against a fake inbox socket: it posts the line the
 * canvas wrote, word for word, and an upgrade of the package under it changes nothing - it never restarts itself.
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { connId, pingLine, writeOffers } from '../src/server/jam/conn.ts'
import { readListener } from '../src/server/jam/listener.ts'

const CLI = join(__dirname, '..', 'src', 'cli', 'index.ts')
const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 50)) }
  return ok()
}

describe('jam listen', { timeout: 40_000 }, () => {
  it('posts the canvas\'s line word for word (an older canvas\'s offers in its own words); an upgrade under it spawns nothing', async () => {
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
    // the command runs from an installed package: its entry beside a package.json (what an upgrade rewrites)
    const pkg = join(root, 'pkg')
    mkdirSync(pkg)
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'm', version: '1.0.0' }))
    writeFileSync(join(pkg, 'cli.mjs'), `import ${JSON.stringify(pathToFileURL(CLI).href)}\n`)
    const session = randomUUID()
    const env = { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: sock, CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_PID: String(process.pid), CLAUDE_CODE_ENTRYPOINT: 'cli' }
    delete (env as any).MARVER_JAM_BACKGROUND; delete (env as any).MARVER_JAM
    const p = spawn(process.execPath, [join(pkg, 'cli.mjs'), 'jam', 'listen', '--root', root], { env, stdio: ['pipe', 'ignore', 'inherit'] })
    p.stdin.end(JSON.stringify({ session_id: session, hook_event_name: 'SessionStart', cwd: root, permission_mode: 'default' }))
    const id = connId('claude', session)
    try {
      expect(await until(() => readListener(root, process.pid)?.pid === p.pid)).toBe(true)
      const line = 'Live Jam: new request from your Marver canvas - "Intro frame redesign" (aaaa1111) - run `npx marver jam next`.'
      writeOffers(root, id, { n: 1, gen: 10, latest: { id: 'aaaa1111', title: 'Intro frame redesign' }, line })
      expect(await until(() => got.length === 1)).toBe(true)
      expect(got[0]).toBe(line)
      writeOffers(root, id, { n: 1, gen: 11, line: `${line} (again)` })
      expect(await until(() => got.length === 2)).toBe(true)
      expect(got[1]).toBe(`${line} (again)`)
      // a canvas before 0.28 writes no line: the listener says it in its own words
      writeOffers(root, id, { n: 2, gen: 12 })
      expect(await until(() => got.length === 3)).toBe(true)
      expect(got[2]).toBe('Live Jam: 2 new requests from your Marver canvas - run `npx marver jam next` for each.')
      // nothing waits (a line kept from before): nothing said
      writeOffers(root, id, { n: 0, gen: 13, line })
      // the package upgraded under it: the same listener goes on - nothing started, the lock still its own
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'm', version: '1.0.1' }))
      writeFileSync(join(pkg, 'cli.mjs'), `// 1.0.1\nimport ${JSON.stringify(pathToFileURL(CLI).href)}\n`)
      await new Promise((r) => setTimeout(r, 3_000))
      expect([p.exitCode, readListener(root, process.pid)?.pid]).toEqual([null, p.pid])
      writeOffers(root, id, { n: 1, gen: 14, line: 'Live Jam: new request from your Marver canvas - "Session record" (bbbb2222) - run `npx marver jam next`.' })
      expect(await until(() => got.length === 4)).toBe(true)
      expect(got[3]).toContain('"Session record" (bbbb2222)')
      expect(got.length).toBe(4)
    } finally {
      try { p.kill() } catch { /* gone */ }
      server.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the line the canvas writes', () => {
  it('names the request; the same words again end "(again)", counted; a stop or a carry-on is said with it', () => {
    const one = { n: 1, gen: 1, latest: { id: 'aaaa1111', title: 'Intro frame redesign' } }
    const a = pingLine(one)
    expect(a).toBe('Live Jam: new request from your Marver canvas - "Intro frame redesign" (aaaa1111) - run `npx marver jam next`.')
    expect(pingLine(one, a)).toBe(`${a} (again)`)
    expect(pingLine(one, `${a} (again)`)).toBe(`${a} (again ×2)`)
    expect(pingLine(one, `${a} (again ×2)`)).toBe(`${a} (again ×3)`)
    expect(pingLine({ ...one, latest: { id: 'bbbb2222', title: 'Pricing' } }, a)).not.toMatch(/again/)
    const back = pingLine({ n: 0, gen: 2, resume: ['r-aaaa1111.1'] })
    expect(back).toBe('Live Jam: the owner gave r-aaaa1111.1 back to you - carry on, and run `npx marver jam progress r-aaaa1111.1`.')
    expect(pingLine({ n: 0, gen: 3, resume: ['r-aaaa1111.1'] }, back)).toBe(`${back} (again)`)
    expect(pingLine({ ...one, stop: ['r-cccc3333.2'] })).toBe(`${a} Live Jam: the owner moved r-cccc3333.2 elsewhere - stop working on it and run \`npx marver jam release r-cccc3333.2\`.`)
  })
})
