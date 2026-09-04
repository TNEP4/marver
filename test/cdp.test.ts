import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Browser, findChrome, Frames } from '../src/server/cdp.ts'
import { captureIn, sweepGhosts, withBrowser } from '../src/server/shot.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const psRow = (needle: string) => spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout.split('\n').find((l) => l.includes(needle))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const posix = process.platform === 'darwin' || process.platform === 'linux'

describe('the pipe framing, with exact chunk boundaries', () => {
  const nul = Buffer.from([0])
  it('one message split in three chunks, inside a multibyte character, comes back whole', () => {
    const f = new Frames()
    const msg = Buffer.from('{"id":1,"result":{"v":"é🙂"}}', 'utf8')
    // cut inside the 4-byte emoji
    const cut = msg.indexOf(Buffer.from('🙂')) + 2
    expect(f.push(msg.subarray(0, 5))).toEqual([])
    expect(f.push(msg.subarray(5, cut))).toEqual([])
    expect(f.push(Buffer.concat([msg.subarray(cut), nul]))).toEqual(['{"id":1,"result":{"v":"é🙂"}}'])
  })
  it('two messages in one chunk yield two; a trailing partial waits for its NUL', () => {
    const f = new Frames()
    expect(f.push(Buffer.concat([Buffer.from('{"id":1}'), nul, Buffer.from('{"id":2}'), nul, Buffer.from('{"id":')]))).toEqual(['{"id":1}', '{"id":2}'])
    expect(f.push(Buffer.concat([Buffer.from('3}'), nul]))).toEqual(['{"id":3}'])
    expect(f.push(nul)).toEqual([''])   // an empty message is still a message (JSON.parse rejects it upstream)
  })
  it('a message past the size guard fails BEFORE it is held, not after it is assembled', () => {
    const f = new Frames(16)
    expect(f.push(Buffer.from('0123456789'))).toEqual([])
    expect(() => f.push(Buffer.from('0123456789'))).toThrow(/runaway/)
    expect(f.push(Buffer.concat([Buffer.from('{}'), nul]))).toEqual(['{}'])   // and it is clean afterwards
  })
})

describe('the debugging pipe transport', () => {
  const saved = process.env.MARVER_CHROME
  afterEach(() => { if (saved === undefined) delete process.env.MARVER_CHROME; else process.env.MARVER_CHROME = saved })

  it.skipIf(!findChrome())('a real Chrome: handshake, a session, a 3-chunk answer reassembled, close leaves no process and no profile', async () => {
    const b = await Browser.launch('mv-shot-')
    const pid = b.pid!
    const row = psRow(`--user-data-dir=`) && psRow(String(pid))
    expect(row).toBeTruthy()
    const profile = /--user-data-dir=(\S+)/.exec(row!)![1]
    expect(existsSync(profile)).toBe(true)
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true })
    // an answer far bigger than one pipe chunk (64KiB): a 2 MB string comes back in many
    // `data` events split anywhere, multibyte characters included
    const big = await b.send('Runtime.evaluate', { expression: `'é🙂'.repeat(500_000)`, returnByValue: true }, sessionId)
    expect(big.result.value.length).toBe(1_500_000)
    expect(big.result.value.startsWith('é🙂é🙂')).toBe(true)
    // two commands in flight at once come back to the right callers
    const [x, y] = await Promise.all([b.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, sessionId), b.send('Runtime.evaluate', { expression: '"two"', returnByValue: true }, sessionId)])
    expect([x.result.value, y.result.value]).toEqual([2, 'two'])
    // abort settles only the tagged caller
    const mine = {}
    const hung = b.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }, sessionId, mine)
    const theirs = b.send('Runtime.evaluate', { expression: '3', returnByValue: true }, sessionId, {})
    b.abort(mine, 'watchdog')
    await expect(hung).rejects.toThrow(/watchdog/)
    expect((await theirs).result.value).toBe(3)
    await b.close()
    expect(alive(pid)).toBe(false)
    expect(existsSync(profile)).toBe(false)
    await expect(b.send('Browser.getVersion')).rejects.toThrow(/closed/)
  }, 30_000)

  it.skipIf(!posix)('a binary that starts but never brings up CDP is killed at the handshake deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-shim-'))
    const shim = join(dir, 'chrome')
    writeFileSync(shim, '#!/bin/sh\nsleep 120\n'); chmodSync(shim, 0o755)
    process.env.MARVER_CHROME = shim
    const t0 = Date.now()
    await expect(Browser.launch('mv-shot-')).rejects.toThrow(/did not answer in time/)
    expect(Date.now() - t0).toBeGreaterThan(14_000)
    await wait(300)
    expect(psRow(`${shim} --headless`)).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  }, 30_000)

  it.skipIf(!posix)('a binary that exits at once fails the launch at once, with the reason', async () => {
    process.env.MARVER_CHROME = '/usr/bin/false'
    const t0 = Date.now()
    await expect(Browser.launch('mv-shot-')).rejects.toThrow(/exited|closed its devtools pipe/)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})

describe.skipIf(!findChrome())('shots sharing one browser', () => {
  it("a shot's watchdog fails THAT shot alone; its neighbours in the same browser are fine and the browser closes after", async () => {
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      // `never`: a root that never gets children - readiness never comes; `fine`: content at once
      res.end(req.url?.includes('never') ? '<div id="root"></div>' : '<div id="root"><h1 style="height:300px">fine</h1></div>')
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as { port: number }).port
    const dir = mkdtempSync(join(tmpdir(), 'mv-wd-'))
    const req = (name: string, timeoutMs: number) => ({ url: `http://127.0.0.1:${port}/${name}`, width: 400, height: 300, out: join(dir, `${name}.png`), timeoutMs, scale: 1 })
    let pid = 0
    const results = await withBrowser('shot', (b) => { pid = b.pid!; return Promise.all([captureIn(req('never', 700), b), captureIn(req('fine', 30_000), b), captureIn(req('fine2', 30_000), b)]) })
    expect(results[0].ok).toBe(false)
    if (!results[0].ok) expect(results[0].error).toMatch(/never rendered/)
    expect(results[1].ok && results[2].ok).toBe(true)
    expect(existsSync(join(dir, 'fine.png')) && existsSync(join(dir, 'fine2.png'))).toBe(true)
    expect(alive(pid)).toBe(false)
    srv.close(); rmSync(dir, { recursive: true, force: true })
  }, 40_000)
})

describe.skipIf(!posix)('the upgrade sweep', () => {
  const saved = process.env.MARVER_CHROME
  afterEach(() => { if (saved === undefined) delete process.env.MARVER_CHROME; else process.env.MARVER_CHROME = saved })

  it('kills an ORPHANED headless browser on one of our profiles, spares a parented one and a stranger, removes stale unreferenced profiles', async () => {
    // node stands in for Chrome: it keeps its argv, so `ps` shows the profile argument
    process.env.MARVER_CHROME = process.execPath
    const tag = Math.random().toString(36).slice(2)
    const ghostDir = join(tmpdir(), `mv-shot-ghost${tag}`)
    const ownedDir = join(tmpdir(), `mv-browser-owned${tag}`)
    const staleDir = join(tmpdir(), `mv-shot-stale${tag}`)
    const freshDir = join(tmpdir(), `mv-shot-fresh${tag}`)
    const strangerDir = join(tmpdir(), `mv-shot-stranger${tag}`)
    for (const d of [ghostDir, ownedDir, staleDir, freshDir, strangerDir]) mkdirSync(d)
    const old = new Date(Date.now() - 20 * 60_000)
    utimesSync(staleDir, old, old); utimesSync(ownedDir, old, old)
    const idleJs = join(tmpdir(), `mv-idle-${tag}.js`)
    writeFileSync(idleJs, 'setTimeout(() => {}, 60000)')
    const idle = [idleJs]
    // the ghost: double-forked so its parent is 1, as a browser whose server died
    spawnSync('sh', ['-c', 'nohup "$0" "$@" >/dev/null 2>&1 &', process.execPath, ...idle, '--headless=new', `--user-data-dir=${ghostDir}`])
    // parented (this test process is its server): must survive, and its OLD profile must stay
    const owned = spawn(process.execPath, [...idle, '--headless=new', `--user-data-dir=${ownedDir}`], { stdio: 'ignore' })
    // orphans that are NOT a headless browser of ours: a stranger merely mentioning the path,
    // and our own binary on our own profile but not headless
    spawnSync('sh', ['-c', `nohup sh -c 'sleep 60; true' x --user-data-dir=${strangerDir} >/dev/null 2>&1 &`])
    const headedDir = join(tmpdir(), `mv-shot-headed${tag}`); mkdirSync(headedDir)
    spawnSync('sh', ['-c', 'nohup "$0" "$@" >/dev/null 2>&1 &', process.execPath, ...idle, `--user-data-dir=${headedDir}`])
    await wait(400)
    const ghostRow = psRow(`--user-data-dir=${ghostDir}`)
    expect(ghostRow).toBeTruthy()
    const ghostPid = Number(ghostRow!.trim().split(/\s+/)[0])
    const strangerRow = psRow(`--user-data-dir=${strangerDir}`)
    const strangerPid = Number(strangerRow!.trim().split(/\s+/)[0])
    const headedPid = Number(psRow(`--user-data-dir=${headedDir}`)!.trim().split(/\s+/)[0])
    expect(alive(ghostPid)).toBe(true)

    const lines: string[] = []
    await sweepGhosts((l) => lines.push(l))
    expect(alive(ghostPid)).toBe(false)
    expect(lines.some((l) => l.includes(`pid ${ghostPid}`))).toBe(true)
    expect(alive(owned.pid!)).toBe(true)
    expect(alive(strangerPid)).toBe(true)
    expect(alive(headedPid)).toBe(true)
    expect(existsSync(staleDir)).toBe(false)     // old and unreferenced
    expect(existsSync(freshDir)).toBe(true)      // young: a browser may be starting on it
    expect(existsSync(ownedDir)).toBe(true)      // old but a live process references it
    owned.kill('SIGKILL'); process.kill(strangerPid, 'SIGKILL'); process.kill(headedPid, 'SIGKILL')
    for (const d of [ghostDir, ownedDir, freshDir, strangerDir, headedDir, idleJs]) rmSync(d, { recursive: true, force: true })
  }, 20_000)
})
