import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser } from './browser.ts'
import { RELOAD_OUTBOX, WRITE_MATCH_MS } from '../src/shared/perf-records.ts'

/**
 * Edit to redraw, joined end to end, and why a board loaded again (spec 30 R1, R2), where they happen: a REAL dev server,
 * a REAL browser, real files changing, and the lines that reach design/.local/perf. No Tailwind here: a stylesheet edit
 * is a real in-place update in every frame, and the in-place tests must count only their own. Skips without Chrome.
 */

const PORT = 9750 + Math.floor(Math.random() * 200)
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
let ORIGIN = `http://localhost:${PORT}`
let root = ''
let server: ChildProcess | null = null
let browser: Browser | null = null
let log = ''

type Line = Record<string, any>
const put = (rel: string, body: string | object) => {
  const f = join(root, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const read = (name: string): Line[] => {
  try { return readFileSync(join(root, 'design/.local/perf', name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const reloads = () => read('reloads.jsonl')
const pageLines = () => read('page.jsonl')
async function until<T>(fn: () => T | undefined | null | false, ms = 30_000, what = 'a line'): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const v = fn(); if (v) return v; await sleep(100) }
  throw new Error(`timed out waiting for ${what}\nreloads tail:\n${reloads().slice(-25).map((l) => JSON.stringify(l)).join('\n')}\nserver:\n${log.slice(-800)}`)
}
const frame = (text: string) => `export const meta = { viewport: 'desktop' }\nexport default () => <main><h1>${text}</h1></main>\n`
const usesButton = (text: string) => `import { Button } from '../../../src/Button.tsx'\nexport const meta = { viewport: 'desktop' }\nexport default () => <main><h1>${text}</h1><Button /></main>\n`
const button = (text: string) => `export function Button() { return <button>${text}</button> }\n`
const nodeOf = (key: string) => `window.__mvStore.getState().nodes.find((n) => n.key === ${JSON.stringify(key)})`
const docText = (key: string) => `(document.querySelector('[data-node=${JSON.stringify(key)}] iframe')?.contentDocument?.body?.innerText ?? '')`
const allReady = (s: string, keys: string[]) => browser!.until(s, keys.map((k) => `${nodeOf(k)}?.status === 'ready'`).join(' && '), 30_000)
const eachPage = (lines: Line[], page: string) => lines.filter((l) => l.page === page)

const opened: string[] = []
/** A fresh tab on a board; `pre`: scripts to run in it before the page's own. */
async function open(path: string, pre: string[] = []): Promise<{ s: string; page: string }> {
  const s = await browser!.tab({ width: 1400, height: 900 })
  opened.push(s)
  for (const source of pre) await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source }, s)
  await browser!.go(s, `${ORIGIN}/${path}`)
  const page = await browser!.until(s, 'window.__mvRecorder?.page', 30_000)
  return { s, page }
}
async function close(t: { s: string }) {
  opened.splice(opened.indexOf(t.s), 1)
  await browser!.closeTab(t.s).catch(() => {})
}

/** Hold this tab's requests matching `patterns` until released (Fetch interception), as page-recorder-browser's. */
async function hold(s: string, patterns: string[]) {
  const glob = (p: string) => new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  const waiting: string[] = []
  let freed = false
  const off = browser!.on((m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== s) return
    const { requestId, request } = m.params
    if (!patterns.some((p) => glob(p).test(request.url))) return
    if (freed) void browser!.send('Fetch.continueRequest', { requestId }, s).catch(() => {})
    else waiting.push(requestId)
  })
  await browser!.send('Fetch.enable', { patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) }, s)
  return {
    paused: () => waiting.length,
    async release() {
      freed = true
      for (const id of waiting.splice(0)) await browser!.send('Fetch.continueRequest', { requestId: id }, s).catch(() => {})
      await browser!.send('Fetch.disable', {}, s).catch(() => {})
      off()
    },
  }
}

/** This tab's reload batches in order, each answered by `answer(n)` (a status), or let through. */
async function batches(s: string, answer: (n: number) => number | undefined) {
  const seen: { status?: number; records: Line[] }[] = []
  const off = browser!.on((m) => {
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== s) return
    const { requestId, request } = m.params
    if (!/\/api\/perf\/reload/.test(request.url)) return
    const status = answer(seen.length)
    seen.push({ status, records: JSON.parse(request.postData ?? '{}').records ?? [] })
    if (status === undefined) void browser!.send('Fetch.continueRequest', { requestId }, s).catch(() => {})
    else void browser!.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from('{"error":"no"}').toString('base64') }, s).catch(() => {})
  })
  await browser!.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/perf/reload*', requestStage: 'Request' }] }, s)
  return { seen, async stop() { await browser!.send('Fetch.disable', {}, s).catch(() => {}); off() } }
}

// the ready watchdog's 10 s, run ten times faster: its own timer, no other
const FAST_WATCHDOG = `(() => {
  if (window.parent !== window) return
  const orig = window.setTimeout
  window.setTimeout = function (fn, ms, ...a) { if (ms === 10000 && /FrameNode/.test(new Error().stack ?? '')) ms = 1000; return orig.call(this, fn, ms, ...a) }
})()`

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mv-r30-edits-'))
  put('package.json', { name: 'r30-edits-fixture', private: true, type: 'module' })
  const repoRoot = join(import.meta.dirname, '..')
  mkdirSync(join(root, 'node_modules', '@marver-design'), { recursive: true })
  for (const e of readdirSync(join(repoRoot, 'node_modules'))) { if (e !== '.bin' && e !== '.vite' && e !== '.vite-marver' && e !== '@marver-design') symlinkSync(join(repoRoot, 'node_modules', e), join(root, 'node_modules', e)) }
  symlinkSync(repoRoot, join(root, 'node_modules', '@marver-design', 'marver'))
  put('design/config.ts', 'export default { jam: false }\n')
  put('design/theme.css', 'body { margin: 0 }\n')
  put('src/Button.tsx', button('button v1'))
  for (const f of ['one', 'hold', 'two', 'far', 'elsewhere', 'feat', 'pre', 'hang', 'lone', 'away']) put(`design/scenes/kit/${f}.tsx`, frame(`${f} v1`))
  put('design/scenes/app/uses.tsx', usesButton('uses'))
  put('design/scenes/app/plain.tsx', frame('plain'))
  const at = (key: string, f: string, x: number, y = 0) => ({ key, frame: f, x, y, w: 1440, h: 900 })
  put('design/boards/main.json', { version: 1, name: 'main', auto: false, order: 0, nodes: [
    at('k-one', 'kit/one', 0), at('k-hold', 'kit/hold', 1500), at('k-two', 'kit/two', 3000), at('k-uses', 'app/uses', 4500), at('k-plain', 'app/plain', 6000),
    at('k-two-far', 'kit/two', 0, 200_000), at('k-far', 'kit/far', 3000, 200_000), at('k-away', 'kit/away', 6000, 200_000),
  ] })
  put('design/boards/feat.json', { version: 1, name: 'feat', type: 'feature', auto: false, order: 1, nodes: [at('k-feat', 'kit/feat', 0)] })
  put('design/boards/pair.json', { version: 1, name: 'pair', auto: false, order: 2, nodes: [at('k-pre', 'kit/pre', 0), at('k-hang', 'kit/hang', 1500)] })
  put('design/boards/lone.json', { version: 1, name: 'lone', auto: false, order: 3, nodes: [at('k-lone', 'kit/lone', 0)] })
  server = spawn(process.execPath, [CLI, 'dev', '--root', root, '--port', String(PORT)], { cwd: root, stdio: 'pipe', env: { ...process.env, BROWSER: 'none', CI: '1' } })
  server.stdout?.on('data', (d) => { log += d; const m = log.match(/→ (http:\/\/localhost:\d+)\//); if (m) ORIGIN = m[1] })
  server.stderr?.on('data', (d) => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !/→ http:\/\/localhost:\d+\//.test(log)) await sleep(100)
  while (Date.now() - t0 < 60_000) { if (await fetch(`${ORIGIN}/`).then((r) => r.ok, () => false)) break; await sleep(200) }
  browser = await Browser.launch()
}, 120_000)

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (root) rmSync(root, { recursive: true, force: true })
})

/** The server's lines for this edit of `file`: its change, the update naming it, the send carrying it. */
const joined = (file: string, since: number) => {
  const all = reloads().filter((l) => l.ts >= since)
  const change = all.find((l) => l.kind === 'change' && l.file === file)
  const update = change && all.find((l) => l.kind === 'update' && l.change === change.change)
  const invalidate = change && all.find((l) => l.kind === 'invalidate' && l.changes.includes(change.change))
  return change && update && invalidate ? { change, update, invalidate, revision: invalidate.revision as string } : null
}
const readyFor = (page: string, node: string, revision: string) => eachPage(reloads(), page).find((l) => l.kind === 'ready' && l.node === node && l.revisions?.includes(revision))
const invalidatedFor = (page: string, revision: string) => eachPage(reloads(), page).find((l) => l.kind === 'invalidated' && l.revision === revision)
const nodesFor = (page: string, revision: string): string[] => eachPage(reloads(), page).filter((l) => l.kind === 'invalidated-nodes' && l.revision === revision).flatMap((l) => l.nodes)

describe('edit to redraw, joined end to end (R1)', () => {
  let tab: { s: string; page: string }
  const MAIN = '#/b/main?f=kit/one,kit/hold,kit/two,app/uses,app/plain'

  it('the page says it booted, with its page and seq, and how it was navigated', async () => {
    if (!browser) return
    tab = await open(MAIN)
    await allReady(tab.s, ['k-one', 'k-hold', 'k-two', 'k-uses', 'k-plain'])
    const boot = await until(() => eachPage(reloads(), tab.page).find((l) => l.kind === 'shell-boot'))
    expect(boot.seq).toEqual(expect.any(Number))
    expect(boot.tab).toEqual(expect.any(String))
    expect(boot.nav).toBe('navigate')
    expect(boot).not.toHaveProperty('resumed')
    // a first load is no job: its document has no token
    const first = await until(() => eachPage(reloads(), tab.page).find((l) => l.kind === 'ready' && l.node === 'k-one'))
    expect(first.cause).toBe('first')
    for (const k of ['revisions', 'queuedMs', 'bootMs', 'heldBy', 'asleep']) expect(first).not.toHaveProperty(k)
  }, 90_000)

  it('an edit gives change -> invalidate -> invalidated -> ready, on one revision, with queuedMs', async () => {
    if (!browser) return
    await browser.until(tab.s, `${nodeOf('k-one')}?.status === 'ready'`, 30_000)
    const since = Date.now()
    put('design/scenes/kit/one.tsx', frame('one v2'))
    await browser.until(tab.s, `${docText('k-one')}.includes('one v2')`, 30_000)
    const j = await until(() => joined('design/scenes/kit/one.tsx', since))
    expect(j.change).toMatchObject({ event: 'update', reloadN: 1, inPlaceN: 0 })
    expect(j.change.hmrTs).toEqual(expect.any(Number))
    expect(j.change.flightMs).toEqual(expect.any(Number))
    expect(j.update).toMatchObject({ cause: 'update', reload: ['kit/one'], inPlace: [], reloadN: 1 })
    expect(j.invalidate.frames).toBe(1)
    const ready = await until(() => readyFor(tab.page, 'k-one', j.revision))
    const inv = invalidatedFor(tab.page, j.revision)!
    expect(inv).toMatchObject({ asked: 1, offBoard: 0, onBoard: 1 })
    expect(inv.awake + inv.asleep).toBe(1)
    expect(ready.asleep === true).toBe(inv.asleep === 1)         // a frame at rest sleeps: frozen as its navigation started
    expect(nodesFor(tab.page, j.revision)).toEqual(['k-one'])
    expect(ready).toMatchObject({ cause: 'job', frame: 'kit/one', revisions: [j.revision] })
    expect(ready.queuedMs).toEqual(expect.any(Number))
    expect(ready.bootMs).toBeGreaterThan(0)
    expect(ready.ms).toEqual(expect.any(Number))
    expect(ready.seq).toEqual(expect.any(Number))
  }, 60_000)

  it('a second revision arriving while the first loads goes to the next navigation, not the running one', async () => {
    if (!browser) return
    const h = await hold(tab.s, ['*kit/hold.tsx*'])
    const since = Date.now()
    put('design/scenes/kit/hold.tsx', frame('hold v2'))
    const first = await until(() => joined('design/scenes/kit/hold.tsx', since))
    await until(() => readyAfter())                              // its document was asked for, and is held loading
    function readyAfter() { return h.paused() > 0 }
    const navBefore: number = await browser.eval(tab.s, `${nodeOf('k-hold')}.nav`)
    const mid = Date.now()
    put('design/scenes/kit/hold.tsx', frame('hold v3'))
    const second = await until(() => { const a = reloads().filter((l) => l.ts >= mid); const c = a.find((l) => l.kind === 'change' && l.file === 'design/scenes/kit/hold.tsx'); const i = c && a.find((l) => l.kind === 'invalidate' && l.changes.includes(c.change)); return i?.revision as string | undefined })
    await until(() => invalidatedFor(tab.page, second))
    expect(second).not.toBe(first.revision)
    await h.release()
    const running = await until(() => readyFor(tab.page, 'k-hold', first.revision))
    expect(running.revisions).toEqual([first.revision])          // frozen: the second is not its
    const next = await until(() => readyFor(tab.page, 'k-hold', second))
    expect(next.revisions).toEqual([second])
    expect(next.seq).toBeGreaterThan(running.seq)
    expect(next.heldBy).toBe('loading')                          // the first reason the queue refused it
    expect(await browser.eval(tab.s, `${nodeOf('k-hold')}.nav`)).toBe(navBefore + 1)
    await browser.until(tab.s, `${docText('k-hold')}.includes('hold v3')`, 30_000)
  }, 90_000)

  it('a frame shown by two nodes counts two', async () => {
    if (!browser) return
    const since = Date.now()
    put('design/scenes/kit/two.tsx', frame('two v2'))
    const j = await until(() => joined('design/scenes/kit/two.tsx', since))
    const inv = await until(() => invalidatedFor(tab.page, j.revision))
    expect(inv).toMatchObject({ asked: 1, offBoard: 0, onBoard: 2 })
    expect(inv.held.offscreen).toBe(1)
    await until(() => nodesFor(tab.page, j.revision).length === 2)
    expect(nodesFor(tab.page, j.revision).sort()).toEqual(['k-two', 'k-two-far'])
    await until(() => readyFor(tab.page, 'k-two', j.revision))
  }, 60_000)

  it('a reload by hand is no job: its document has no token, and what waits is not its to claim', async () => {
    if (!browser) return
    await browser.until(tab.s, `${nodeOf('k-plain')}?.status === 'ready'`, 30_000)
    const since = Date.now()
    await browser.eval(tab.s, `window.__mvStore.getState().reloadFrame('k-plain'), 1`)
    const line = await until(() => eachPage(reloads(), tab.page).find((l) => l.kind === 'ready' && l.node === 'k-plain' && l.cause === 'manual' && l.ts >= since))
    expect(line).not.toHaveProperty('revisions')
    expect(line).not.toHaveProperty('queuedMs')
  }, 60_000)

  it('a node in use is held leased, and the play stage holds every node: each counted, and said by its ready', async () => {
    if (!browser) return
    await allReady(tab.s, ['k-one'])
    await browser.eval(tab.s, `window.__mvStore.getState().setInteract('k-one'), 1`)
    let since = Date.now()
    put('design/scenes/kit/one.tsx', frame('one leased'))
    const leased = await until(() => joined('design/scenes/kit/one.tsx', since))
    expect((await until(() => invalidatedFor(tab.page, leased.revision))).held).toEqual({ leased: 1 })
    await browser.eval(tab.s, `window.__mvStore.getState().setInteract(null), 1`)
    expect((await until(() => readyFor(tab.page, 'k-one', leased.revision))).heldBy).toBe('leased')
    await allReady(tab.s, ['k-one'])

    await browser.eval(tab.s, `window.__mvStore.getState().setPlay({ at: 'app/plain', device: 'desktop', theme: 'light', focus: true }), 1`)
    since = Date.now()
    put('design/scenes/kit/one.tsx', frame('one in play'))
    const played = await until(() => joined('design/scenes/kit/one.tsx', since))
    expect((await until(() => invalidatedFor(tab.page, played.revision))).held).toEqual({ play: 1 })
    await browser.eval(tab.s, `window.__mvStore.getState().setPlay(null), 1`)
    expect((await until(() => readyFor(tab.page, 'k-one', played.revision))).heldBy).toBe('play')
  }, 90_000)

  it('a frame on no board is offBoard, with no node to redraw', async () => {
    if (!browser) return
    const since = Date.now()
    put('design/scenes/kit/elsewhere.tsx', frame('elsewhere v2'))
    const j = await until(() => joined('design/scenes/kit/elsewhere.tsx', since))
    const inv = await until(() => invalidatedFor(tab.page, j.revision))
    expect(inv).toMatchObject({ asked: 1, offBoard: 1, onBoard: 0, awake: 0, asleep: 0, held: {} })
    expect(inv).not.toHaveProperty('parts')
    expect(nodesFor(tab.page, j.revision)).toEqual([])
  }, 60_000)

  it('an off-screen node is held offscreen until panned in, and its ready says so', async () => {
    if (!browser) return
    await browser.until(tab.s, `${nodeOf('k-far')}?.status === 'ready'`, 30_000)
    const since = Date.now()
    put('design/scenes/kit/far.tsx', frame('far v2'))
    const j = await until(() => joined('design/scenes/kit/far.tsx', since))
    const inv = await until(() => invalidatedFor(tab.page, j.revision))
    expect(inv.held).toEqual({ offscreen: 1 })
    await sleep(1200)
    expect(readyFor(tab.page, 'k-far', j.revision)).toBeUndefined()   // still waiting: nothing claims a redraw
    await browser.eval(tab.s, `location.hash = '#/b/main?f=kit/far', 1`)
    const ready = await until(() => readyFor(tab.page, 'k-far', j.revision))
    expect(ready.heldBy).toBe('offscreen')
    expect(ready.queuedMs).toBeGreaterThanOrEqual(1000)
    await browser.eval(tab.s, `location.hash = ${JSON.stringify(MAIN)}, 1`)
    await sleep(800)
  }, 60_000)

  it('a round with no end from Vite: its line says so, through the shell and the server', async () => {
    if (!browser) return
    await allReady(tab.s, ['k-uses', 'k-plain'])
    const hmrTs = Date.now()
    await browser.eval(tab.s, `document.querySelector('[data-node="k-uses"] iframe').contentWindow.eval(${JSON.stringify(`parent.postMessage({ type: 'sh:inplace', id: 'app/uses', boot: window.__mvBoot, hmrTs: ${hmrTs}, applyMs: 30000, applied: 'unknown', noAfterUpdate: true }, location.origin), 1`)})`)
    const line = await until(() => eachPage(reloads(), tab.page).find((l) => l.kind === 'inplace' && l.hmrTs === hmrTs))
    expect(line).toMatchObject({ node: 'k-uses', frame: 'app/uses', fetched: true, applied: 'unknown', applyMs: 30000, noAfterUpdate: true })
  }, 60_000)

  it('a self-accepting component: inplace in the frame that imports it, nothing in the one that does not', async () => {
    if (!browser) return
    await allReady(tab.s, ['k-uses', 'k-plain'])
    const since = Date.now()
    put('src/Button.tsx', button('button v2'))
    await browser.until(tab.s, `${docText('k-uses')}.includes('button v2')`, 30_000)
    const change = await until(() => reloads().find((l) => l.ts >= since && l.kind === 'change' && l.file === 'src/Button.tsx'))
    expect(change.inPlaceN).toBeGreaterThanOrEqual(1)
    const line = await until(() => eachPage(reloads(), tab.page).find((l) => l.kind === 'inplace' && l.hmrTs === change.hmrTs))
    expect(line).toMatchObject({ node: 'k-uses', frame: 'app/uses', fetched: true, applied: 'unknown' })
    expect(line.applyMs).toEqual(expect.any(Number))
    expect(line.nextObservedCommitMs).toEqual(expect.any(Number))
    expect(line.nextObservedCommitMs).toBeLessThan(2000)
    await sleep(2500)                                            // past the wait of any other frame's report
    const all = eachPage(reloads(), tab.page).filter((l) => l.kind === 'inplace' && l.hmrTs === change.hmrTs)
    expect(all.map((l) => l.node)).toEqual(['k-uses'])
  }, 60_000)

  it('an update whose import throws is applied: false, and has no commit to claim', async () => {
    if (!browser) return
    const since = Date.now()
    put('src/Button.tsx', `throw new Error('boom at import')\nexport function Button() { return <button>never</button> }\n`)
    const change = await until(() => reloads().find((l) => l.ts >= since && l.kind === 'change' && l.file === 'src/Button.tsx'))
    const line = await until(() => eachPage(reloads(), tab.page).find((l) => l.kind === 'inplace' && l.hmrTs === change.hmrTs))
    expect(line).toMatchObject({ node: 'k-uses', fetched: true, applied: false })
    expect(line).not.toHaveProperty('nextObservedCommitMs')
    // the console is the frame's own again: the watch lasts one update
    expect(await browser.eval(tab.s, `document.querySelector('[data-node="k-uses"] iframe').contentWindow.console.error.toString().includes('Failed to reload')`)).toBe(false)
    const back = Date.now()
    put('src/Button.tsx', button('button v3'))
    const ok = await until(() => reloads().find((l) => l.ts >= back && l.kind === 'change' && l.file === 'src/Button.tsx'))
    const after = await until(() => eachPage(reloads(), tab.page).find((l) => l.kind === 'inplace' && l.hmrTs === ok.hmrTs))
    expect(after.applied).toBe('unknown')                        // the failure is not carried over
  }, 60_000)

  it('an update only the registry accepts writes no inplace line', async () => {
    if (!browser) return
    const before = eachPage(reloads(), tab.page).filter((l) => l.kind === 'inplace').length
    const since = Date.now()
    put('design/scenes/kit/one.tsx', frame('one v3'))
    const j = await until(() => joined('design/scenes/kit/one.tsx', since))
    await until(() => readyFor(tab.page, 'k-one', j.revision))
    await sleep(2500)
    expect(eachPage(reloads(), tab.page).filter((l) => l.kind === 'inplace')).toHaveLength(before)
  }, 60_000)

  it('`applied` is never true, and (page, seq) names one record across both logs', async () => {
    if (!browser) return
    const inplace = reloads().filter((l) => l.kind === 'inplace')
    expect(inplace.length).toBeGreaterThan(0)
    for (const l of inplace) expect(l.applied === 'unknown' || l.applied === false).toBe(true)
    const shell = eachPage(reloads(), tab.page).map((l) => l.seq as number), own = eachPage(pageLines(), tab.page).map((l) => l.seq as number)
    expect(new Set([...shell, ...own]).size).toBe(shell.length + own.length)
  })
})

describe('the shell\'s lines (#13, #16)', () => {
  it('node keys go in parts of 256, and a missing node is counted as held, never as a redraw to wait for', async () => {
    if (!browser) return
    const tab = await open('#/b/lone')
    await allReady(tab.s, ['k-lone'])
    const ghosts = `Array.from({ length: 300 }, (_, i) => ({ key: 'ghost-' + i, frame: 'kit/ghost', x: 0, y: 300000 + i, w: 10, h: 10, status: 'loading', missing: true }))`
    await browser.eval(tab.s, `(() => { const st = window.__mvStore; st.setState({ nodes: [...st.getState().nodes, ...${ghosts}] }); st.getState().invalidateFrames(['kit/ghost'], '1:777', {}); return 1 })()`)
    const inv = await until(() => invalidatedFor(tab.page, '1:777'))
    expect(inv).toMatchObject({ asked: 1, offBoard: 0, onBoard: 300, awake: 0, asleep: 0, held: { missing: 300 }, parts: 2 })
    await until(() => nodesFor(tab.page, '1:777').length === 300)
    const parts = eachPage(reloads(), tab.page).filter((l) => l.kind === 'invalidated-nodes' && l.revision === '1:777')
    expect(parts.map((l) => [l.part, l.parts, l.nodes.length])).toEqual([[1, 2, 256], [2, 2, 44]])
    await close(tab)
  }, 60_000)

  it('a page that reloaded itself coming back says so, and a reload by hand after it does not', async () => {
    if (!browser) return
    const tab = await open('#/b/lone')
    await allReady(tab.s, ['k-lone'])
    const reloadAs = async (before: string, script: string) => {
      await browser!.eval(tab.s, `(() => { ${script} location.reload(); return 1 })()`).catch(() => {})
      const page: string = await browser!.until(tab.s, `window.__mvRecorder && window.__mvRecorder.page !== ${JSON.stringify(before)} && window.__mvRecorder.page`, 30_000)
      return { page, boot: await until(() => eachPage(reloads(), page).find((l) => l.kind === 'shell-boot')) }
    }
    // what the page before it leaves when its canvas comes back (api.ts keepOverReload)
    const back = await reloadAs(tab.page, `sessionStorage.setItem('mv-resumed:' + window.__mvRecorder.ws, JSON.stringify({ at: Date.now(), outcome: 'saved' }));`)
    expect(back.boot).toMatchObject({ nav: 'reload', resumed: true })
    const plain = await reloadAs(back.page, '')
    expect(plain.boot.nav).toBe('reload')
    expect(plain.boot).not.toHaveProperty('resumed')
    await close({ s: tab.s })
  }, 60_000)
})

describe('delivery (#7, #16)', () => {
  it('a 503 is tried again, and what lands is written once', async () => {
    if (!browser) return
    const tab = await open('#/b/lone')
    const b = await batches(tab.s, (n) => (n === 0 ? 503 : undefined))
    await allReady(tab.s, ['k-lone'])
    await until(() => b.seen.length >= 2, 15_000, 'a second attempt')
    expect(b.seen[0].status).toBe(503)
    expect(b.seen[1].records.map((r) => r.seq)).toEqual(b.seen[0].records.map((r) => r.seq))
    const boots = await until(() => { const x = eachPage(reloads(), tab.page).filter((l) => l.kind === 'shell-boot'); return x.length ? x : null })
    expect(boots).toHaveLength(1)
    await b.stop()
    await close(tab)
  }, 60_000)

  it('what never lands is counted: a dropped line, with how many', async () => {
    if (!browser) return
    const tab = await open('#/b/lone')
    const b = await batches(tab.s, (n) => (n < 3 ? 503 : undefined))
    await allReady(tab.s, ['k-lone'])
    await until(() => b.seen.length >= 3, 20_000, 'three attempts')
    const lost = b.seen[0].records.length
    expect(lost).toBeGreaterThan(0)
    await b.stop()
    await browser.eval(tab.s, `window.__mvStore.getState().invalidateFrames(['kit/lone'], '1:999', {}), 1`)   // one more line to carry the count
    const dropped = await until(() => eachPage(reloads(), tab.page).find((l) => l.kind === 'dropped'))
    expect(dropped.n).toBe(lost)
    expect(eachPage(reloads(), tab.page).filter((l) => l.kind === 'shell-boot')).toHaveLength(0)   // lost, and said so
    await close(tab)
  }, 60_000)

  it('leaving under the 2 s a line waits: it still reaches the log', async () => {
    if (!browser) return
    const tab = await open('#/b/main?f=kit/one')
    await browser.until(tab.s, `${nodeOf('k-away')}?.status === 'ready'`, 30_000)
    await until(() => eachPage(reloads(), tab.page).some((l) => l.kind === 'shell-boot'))     // the first batch is gone
    const since = Date.now()
    put('design/scenes/kit/away.tsx', frame('away v2'))
    await browser.until(tab.s, `${nodeOf('k-away')}?.stale === true`, 15_000)
    await browser.go(tab.s, 'about:blank')                       // under the 2 s its line would wait
    const j = await until(() => joined('design/scenes/kit/away.tsx', since))
    await until(() => invalidatedFor(tab.page, j.revision), 10_000, 'the line sent on the way out')
    await close(tab)
  }, 60_000)

  it('at pagehide: keepalive, this log\'s 8 KB at most, and what does not fit counted in the last line that does', async () => {
    if (!browser) return
    // the sends as the page makes them: `pagehide` fired by hand, so the path is this one and no `visibilitychange`'s
    const SPY = `(() => {
      if (window.parent !== window) return
      window.__sends = []
      const orig = window.fetch
      window.fetch = function (url, init) {
        if (String(url).includes('/perf/reload')) window.__sends.push({ keepalive: init?.keepalive === true, body: String(init?.body ?? '') })
        return orig.apply(this, arguments)
      }
    })()`
    const tab = await open('#/b/lone', [SPY])
    await allReady(tab.s, ['k-lone'])
    await browser.until(tab.s, 'window.__sends.length > 0', 15_000)      // the first batch is gone: what follows is all that waits
    await sleep(200)
    const out = await browser.eval(tab.s, `(() => {
      const before = window.__sends.length, st = window.__mvStore.getState()
      for (let i = 0; i < 300; i++) st.invalidateFrames(['kit/lone'], '1:' + (1000 + i), {})
      window.dispatchEvent(new Event('pagehide'))
      return window.__sends.slice(before)
    })()`)
    expect(out).toHaveLength(1)
    expect(out[0].keepalive).toBe(true)
    expect(Buffer.byteLength(out[0].body)).toBeLessThanOrEqual(RELOAD_OUTBOX.keepaliveBytes)
    const records: Line[] = JSON.parse(out[0].body).records
    const counted = records.filter((r) => r.kind === 'dropped')
    expect(counted).toHaveLength(1)
    expect(records.at(-1)!.kind).toBe('dropped')
    expect(counted[0].n).toBeGreaterThan(0)
    expect(records.length - 1 + counted[0].n).toBe(600)                  // every line it had: sent, or counted
    const seqs = records.filter((r) => r.kind !== 'dropped').map((r) => r.seq as number)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))                // the oldest first
    await until(() => eachPage(reloads(), tab.page).find((l) => l.kind === 'dropped' && l.n === counted[0].n), 10_000, 'the count reaching the log')
    await close(tab)
  }, 60_000)
})

describe('the level (#57, #58)', () => {
  it('core: 0.29\'s lines and nothing spec 30 adds - still delivered, one request each', async () => {
    if (!browser) return
    const s = await browser.tab({ width: 1400, height: 900 })
    opened.push(s)
    const b = await batches(s, () => undefined)
    await browser.go(s, `${ORIGIN}/?mvrecorder=core#/b/main?f=kit/one`)
    const tab = { s, page: await browser.until(s, 'window.__mvRecorder?.page', 30_000) as string }
    await browser.until(tab.s, `${nodeOf('k-one')}?.status === 'ready'`, 30_000)
    const since = Date.now()
    put('design/scenes/kit/one.tsx', frame('one core'))
    await browser.until(tab.s, `${docText('k-one')}.includes('one core')`, 30_000)
    await until(() => eachPage(reloads(), tab.page).find((l) => l.kind === 'ready' && l.ts >= since && l.cause === 'job'))
    const mine = eachPage(reloads(), tab.page)
    expect(mine.find((l) => l.kind === 'ready' && l.cause === 'job')).not.toHaveProperty('revisions')
    expect(mine.find((l) => l.kind === 'shell-boot')).not.toHaveProperty('nav')
    expect(mine.filter((l) => l.kind === 'invalidated' || l.kind === 'invalidated-nodes' || l.kind === 'inplace')).toEqual([])
    const load = await until(() => eachPage(pageLines(), tab.page).find((l) => l.kind === 'load'))
    expect(load).not.toHaveProperty('trigger')
    expect(b.seen.length).toBeGreaterThanOrEqual(2)
    expect(b.seen.every((x) => x.records.length === 1)).toBe(true)   // as 0.29: no Outbox
    await b.stop()
    await close(tab)
  }, 60_000)
})

describe('why a board loaded again (R2)', () => {
  const boardFile = () => join(root, 'design/boards/feat.json')
  const loads = (page: string) => eachPage(pageLines(), page).filter((l) => l.kind === 'load')
  const newest = (page: string, trigger: string, n = 1) => { const x = loads(page).filter((l) => l.trigger === trigger); return x.length >= n ? x.at(-1)! : null }
  const clean = (s: string) => browser!.until(s, `(() => { const st = window.__mvStore.getState(); return st.board === 'feat' && !st.dirty && !!st.boardHash && st.nodes.every((n) => n.status === 'ready') })()`, 30_000)

  it('a page\'s first load says first; a status change by a second page is a candidate, with that page', async () => {
    if (!browser) return
    const a = await open('#/b/feat'), b = await open('#/b/feat')
    await clean(a.s); await clean(b.s)
    const first = await until(() => loads(a.page)[0])
    expect(first).toMatchObject({ cause: 'boot', trigger: 'first' })
    expect(first).not.toHaveProperty('writer')
    const statusAt = Date.now()
    expect(await browser.eval(b.s, `window.__mvStore.getState().setBoardStatus('feat', 'paused').then((r) => r.ok)`)).toBe(true)
    const disk = await until(() => newest(a.page, 'disk'))
    expect(disk).toMatchObject({ cause: 'disk-reload', writer: 'candidate' })
    expect(disk.candidates).toHaveLength(1)
    expect(disk.candidates[0].page).toBe(b.page)
    expect(disk.candidates[0].cmds).toEqual(expect.any(Array))

    // the same bytes written back by an editor within 10 s: a matching hash proves matching bytes, not the writer. Driven
    // by what page A shows, never by page.jsonl's 2 s batches: this must stay inside the 10 s, and it says so if it does not
    const shown = () => browser!.eval(a.s, 'window.__mvStore.getState().boardHash') as Promise<string>
    const written = readFileSync(boardFile(), 'utf8')
    const h0 = await shown()
    const diskFrom = (at: number) => loads(a.page).filter((l) => l.trigger === 'disk' && l.ts >= at)
    const plainAt = Date.now()
    writeFileSync(boardFile(), written.replace('"paused"', '"archived"'))     // an editor: a plain write the server never saw
    await browser.until(a.s, `window.__mvStore.getState().boardHash !== ${JSON.stringify(h0)}`, 8_000)
    const backAt = Date.now()
    expect(backAt - statusAt).toBeLessThan(WRITE_MATCH_MS - 3_000)
    writeFileSync(boardFile(), written)                                        // the page's bytes, from the editor
    await browser.until(a.s, `window.__mvStore.getState().boardHash === ${JSON.stringify(h0)}`, 8_000)
    expect(Date.now() - statusAt).toBeLessThan(WRITE_MATCH_MS)                 // inside the window, or this proves nothing
    const back = await until(() => diskFrom(backAt).at(-1), 8_000, 'the bytes written back')
    const plain = diskFrom(plainAt).filter((l) => l.ts < backAt).at(-1)!
    expect(plain.writer).toBe('unknown')
    expect(plain).not.toHaveProperty('candidates')
    expect(back.writer).toBe('candidate')                                      // only a candidate: nothing here calls it proven
    expect(back.candidates[0].page).toBe(b.page)
    await close(a); await close(b)
  }, 90_000)

  it('the command ids a write names reach the load that reads it', async () => {
    if (!browser) return
    const a = await open('#/b/feat')
    await clean(a.s)
    const before = loads(a.page).filter((l) => l.trigger === 'disk').length
    const CMD = 'c0ffee000001', OTHER = 'abcdef012345'
    const status = await browser.eval(a.s, `fetch('/__mv/api/boards/status', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': document.cookie.match(/mv_c=([\\w-]+)/)[1], 'x-mv-page': '${OTHER}', 'x-mv-cmds': '${CMD};n=3' }, body: JSON.stringify({ name: 'feat', status: 'backlog' }) }).then((r) => r.status)`)
    expect(status).toBe(200)
    const disk = await until(() => { const x = loads(a.page).filter((l) => l.trigger === 'disk'); return x.length > before ? x.at(-1)! : null })
    expect(disk.writer).toBe('candidate')
    expect(disk.candidates).toEqual([{ page: OTHER, cmds: [CMD], n: 3 }])
    await close(a)
  }, 60_000)

  it('a page\'s own board writes name it: `x-mv-page` on the save, and no other request', async () => {
    if (!browser) return
    const a = await open('#/b/feat')
    await clean(a.s)
    const seen: { url: string; page?: string; method: string }[] = []
    const off = browser.on((m) => {
      if (m.method !== 'Network.requestWillBeSent' || m.sessionId !== a.s) return
      const { url, method, headers } = m.params.request
      if (/\/__mv\/api\//.test(url)) seen.push({ url, method, page: headers['x-mv-page'] })
    })
    await browser.send('Network.enable', {}, a.s)
    await browser.eval(a.s, `window.__mvStore.getState().moveNode('k-feat', 40, 40), 1`)
    await until(() => seen.some((x) => x.method === 'PUT'), 8_000, 'the save')
    const save = seen.find((x) => x.method === 'PUT')!
    expect(save.url).toMatch(/\/boards\/feat$/)
    expect(save.page).toBe(a.page)
    expect(seen.filter((x) => x.method === 'GET' || /perf\//.test(x.url)).every((x) => x.page === undefined)).toBe(true)
    off()
    await close(a)
  }, 60_000)

  it('a 409 on a save reads the board again: save-conflict', async () => {
    if (!browser) return
    const a = await open('#/b/feat')
    await clean(a.s)
    await browser.eval(a.s, `window.__mvStore.getState().moveNode('k-feat', 90, 90), 1`)   // dirty: its save waits 500 ms
    writeFileSync(boardFile(), JSON.stringify({ ...JSON.parse(readFileSync(boardFile(), 'utf8')), title: 'edited under it' }, null, 2) + '\n')
    const conflict = await until(() => newest(a.page, 'save-conflict'), 15_000, 'a save-conflict load')
    expect(conflict.cause).toBe('disk-reload')
    await close(a)
  }, 60_000)

  it('a cut keeps what was ready: partial times, and how many of the visible', async () => {
    if (!browser) return
    const s = await browser.tab({ width: 1400, height: 900 })
    opened.push(s)
    const h = await hold(s, ['*kit/hang.tsx*'])
    await browser.go(s, `${ORIGIN}/#/b/pair`)
    const page = await browser.until(s, 'window.__mvRecorder?.page', 30_000)
    await browser.until(s, `${nodeOf('k-pre')}?.status === 'ready'`, 30_000)
    await until(() => h.paused() > 0, 15_000, 'the held frame')
    await browser.eval(s, `window.__mvStore.getState().switchBoard('lone'), 1`)
    const cut = await until(() => eachPage(pageLines(), page).find((l) => l.kind === 'cut' && l.reason === 'switch' && l.frames === 2))
    expect(cut.ready).toBe(1)
    expect(cut.allReadyMs).toEqual(expect.any(Number))
    expect(cut.visibleReady).toBeLessThanOrEqual(1)
    if (cut.visibleReady) expect(cut.visibleReadyMs).toEqual(expect.any(Number))
    else expect(cut).not.toHaveProperty('visibleReadyMs')
    await h.release()
    await browser.closeTab(s).catch(() => {})
    opened.splice(opened.indexOf(s), 1)
  }, 60_000)

  it('the watchdog\'s silence is a line: retry, then gave-up, each naming its navigation', async () => {
    if (!browser) return
    const s = await browser.tab({ width: 1400, height: 900 })
    opened.push(s)
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: FAST_WATCHDOG }, s)
    const h = await hold(s, ['*kit/lone.tsx*'])
    await browser.go(s, `${ORIGIN}/#/b/lone`)
    const page = await browser.until(s, 'window.__mvRecorder?.page', 30_000)
    const lines = await until(() => { const x = eachPage(reloads(), page).filter((l) => l.kind === 'watchdog'); return x.length >= 2 ? x : null }, 20_000, 'two watchdog lines')
    expect(lines.map((l) => l.action)).toEqual(['retry', 'gave-up'])
    expect(lines.every((l) => l.node === 'k-lone' && l.frame === 'kit/lone')).toBe(true)
    expect(lines[1].nav).toBe(lines[0].nav + 1)                   // the retry is a navigation of its own
    await sleep(1500)
    expect(eachPage(reloads(), page).filter((l) => l.kind === 'watchdog')).toHaveLength(2)   // bounded: no third
    await h.release()
    await browser.closeTab(s).catch(() => {})
    opened.splice(opened.indexOf(s), 1)
  }, 60_000)
})
