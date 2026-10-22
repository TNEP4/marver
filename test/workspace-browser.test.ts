import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { makeProject, startDev, stopDev, workspaceOf, type Dev } from './project.ts'

/**
 * A page left open after its canvas stopped (spec 28 A1.11), in a REAL browser: canvas A stops with an
 * unsaved move; project B - the same board file, the same frame ids, the same HTML frame path - takes
 * its port; A comes back. The old tab keeps what it holds and says the canvas stopped, sends nothing to
 * B but the question "is my canvas back?", is never reloaded into B, and its frames and play stage never
 * run B's code. When A answers again the same document saves the move, then reloads. Along the way,
 * every request the shell sends names its workspace. A page that cannot reload when A answers (a capture
 * recording, words not sent) works as live meanwhile, still sees the next stop, and reloads once nothing
 * holds it. Skips without Chrome.
 */

const PORT = 8700 + Math.floor(Math.random() * 300)
const ORIGIN = `http://localhost:${PORT}`
const BANNER = 'This canvas stopped - your unsaved edits are kept in this tab'

const board = JSON.stringify({ version: 1, name: 'main', auto: false, nodes: [
  { key: 'n-home', frame: 'app/home', x: 0, y: 0, w: 390, h: 844 },
  { key: 'n-page', frame: 'app/page', x: 600, y: 0, w: 390, h: 844 },
] }, null, 2) + '\n'
const project = (who: string) => makeProject(`mv-ws-${who.toLowerCase()}-`, {
  'design/scenes/app/home.tsx': `export const meta = { title: 'Home', viewport: 'mobile' }
;(window as any).__who = '${who}'
export default () => <main style={{ minHeight: '100vh', background: '#0b5' }}><h1 id="who">${who}</h1></main>
`,
  'design/scenes/app/page.html': `<!doctype html><html><head><title>Page</title></head><body><h1 id="who">${who}</h1><script>window.__who = '${who}'</script></body></html>\n`,
  'design/boards/main.json': board,
  'design/boards/other.json': JSON.stringify({ version: 1, name: 'other', auto: false, nodes: [{ key: 'o-home', frame: 'app/home', x: 0, y: 0, w: 390, h: 844 }] }, null, 2) + '\n',
  'public/sw.js': `self.addEventListener('fetch', () => {})\n`,
})

let rootA = '', rootB = ''
let WS_A = ''
let a: Dev | null = null, b: Dev | null = null
let browser: Browser | null = null

beforeAll(async () => {
  rootA = project('A')
  rootB = project('B')
  WS_A = workspaceOf(rootA)
  browser = await Browser.launch()
}, 60_000)

afterAll(async () => {
  browser?.close()
  await stopDev(a, PORT).catch(() => {})
  await stopDev(b, PORT).catch(() => {})
  rmSync(rootA, { recursive: true, force: true })
  rmSync(rootB, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Every request a tab sends, as the browser sent it (headers included), with the frame it came from. */
interface Sent { url: string; path: string; method: string; type: string; frame: string; headers: Record<string, string> }
function record(br: Browser, s: string): { sent: Sent[]; stop: () => void } {
  const sent: Sent[] = []
  const stop = br.on((m) => {
    if (m.sessionId !== s || m.method !== 'Network.requestWillBeSent') return
    const u = new URL(m.params.request.url)
    if (u.origin !== ORIGIN) return
    const headers = Object.fromEntries(Object.entries(m.params.request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
    sent.push({ url: u.pathname + u.search, path: u.pathname, method: m.params.request.method, type: m.params.type, frame: m.params.frameId, headers })
  })
  return { sent, stop }
}
const iframeText = (s: string, key: string) => browser!.eval(s, `document.querySelector('[data-node="${key}"] iframe')?.contentDocument?.body?.innerText ?? ''`)
const iframeWho = (s: string, key: string) => browser!.eval(s, `document.querySelector('[data-node="${key}"] iframe')?.contentWindow?.__who ?? null`)
/** with MARVER_SHOT_DIR set, a picture of the tab as it stands */
async function shot(s: string, name: string) {
  if (!process.env.MARVER_SHOT_DIR) return
  const out = await browser!.send('Page.captureScreenshot', { format: 'png' }, s)
  writeFileSync(join(process.env.MARVER_SHOT_DIR, `workspace-${name}.png`), Buffer.from(out.data, 'base64'))
}
const stageText = (s: string) => browser!.eval(s, `document.querySelector('.sh-play iframe')?.contentDocument?.body?.innerText ?? ''`)

describe('a canvas that stops, another project on its port, the canvas back', () => {
  it('keeps the old tab, its edits and its frames away from the other project, then saves into its own', async (ctx) => {
    if (!browser) return ctx.skip()
    a = await startDev(rootA, PORT)

    // ---- A is live: every request the shell sends names A -----------------------------------------
    const s = await browser.tab({ width: 1400, height: 900 })
    await browser.send('Network.enable', {}, s)
    const live = record(browser, s)
    await browser.go(s, `${ORIGIN}/#/b/main`)
    await browser.until(s, `document.querySelectorAll('.sh-node').length === 2`, 30_000)
    await browser.until(s, `(() => { const t = (k) => document.querySelector('[data-node="' + k + '"] iframe')?.contentDocument?.getElementById('who')?.textContent; return t('n-home') === 'A' && t('n-page') === 'A' })()`, 30_000)
    const main = (await browser.send('Page.getFrameTree', {}, s)).frameTree.frame.id as string
    // what a person does: move a frame (the board PUT), flip the theme, open another board and come back
    const x0 = await browser.eval(s, `__mvStore.getState().nodes.find((n) => n.key === 'n-home').x`)
    await browser.eval(s, `__mvStore.getState().moveNode('n-home', ${x0} + 10, 0)`)
    await browser.until(s, `!__mvStore.getState().dirty`, 10_000)
    await browser.eval(s, `__mvStore.getState().setTheme(__mvStore.getState().viewTheme === 'dark' ? 'light' : 'dark')`)
    await browser.until(s, `!__mvStore.getState().dirty`, 10_000)
    await browser.eval(s, `location.hash = '#/b/other'`)
    await browser.until(s, `__mvStore.getState().board === 'other' && document.querySelectorAll('.sh-node').length === 1`, 20_000)
    await browser.eval(s, `location.hash = '#/b/main'`)
    await browser.until(s, `__mvStore.getState().board === 'main' && document.querySelectorAll('.sh-node').length === 2`, 20_000)
    await browser.until(s, `document.querySelector('[data-node="n-page"] iframe')?.contentDocument?.getElementById('who')?.textContent === 'A'`, 30_000)
    // the play stage, in a second tab: its document runs the project's frames too
    const p = await browser.tab({ width: 1200, height: 800 })
    await browser.send('Network.enable', {}, p)
    const played = record(browser, p)
    await browser.go(p, `${ORIGIN}/#/p/main?at=app/home`)
    await browser.until(p, `document.querySelector('.sh-play iframe')?.contentDocument?.getElementById('who')?.textContent === 'A'`, 30_000)
    await wait(1000)
    live.stop(); played.stop()

    // the audit: the API and the manifest by header (an <img> by its URL), documents by their URL
    const api = [...live.sent, ...played.sent].filter((r) => r.path.startsWith('/__mv/api/') || r.path === '/design/manifest.json')
    expect(api.length).toBeGreaterThan(10)
    for (const r of api) expect(r.headers['x-mv-ws'] ?? (r.url.includes(`ws=${WS_A}`) ? WS_A : null), `${r.method} ${r.url}`).toBe(WS_A)
    for (const path of ['/__mv/api/boards', '/__mv/api/folders', '/__mv/api/sizes', '/__mv/api/boards/main', '/__mv/api/boards/other', '/design/manifest.json', '/__mv/api/policy', '/__mv/api/update']) {
      expect(api.some((r) => r.path === path), `${path} was asked`).toBe(true)
    }
    expect(api.some((r) => r.method === 'PUT' && r.path === '/__mv/api/boards/main'), 'the board save').toBe(true)
    const docs = [...live.sent, ...played.sent].filter((r) => r.type === 'Document' && r.path !== '/')
    expect(docs.map((r) => r.path)).toEqual(expect.arrayContaining(['/__mv/frame/', '/design/scenes/app/page.html', '/__mv/stage/']))
    for (const r of docs) expect(new URL(r.url, ORIGIN).searchParams.get('ws'), r.url).toBe(WS_A)

    // ---- A stops: the banner, an edit kept, nothing sent ------------------------------------------
    await browser.eval(s, `window.__mark = 1`)
    await browser.eval(p, `window.__mark = 1`)
    await stopDev(a, PORT); a = null
    await browser.until(s, `__mvLink.getState().link === 'down' && document.querySelector('.sh-stopped')?.textContent === ${JSON.stringify(BANNER)}`, 5_000)
    const x1 = await browser.eval(s, `__mvStore.getState().nodes.find((n) => n.key === 'n-home').x`)
    await browser.eval(s, `__mvStore.getState().moveNode('n-home', ${x1} + 120, 0)`)
    expect(await browser.eval(s, `__mvStore.getState().dirty`)).toBe(true)
    await wait(1200)   // past the save's debounce: it holds, the edit stays dirty here
    expect(await browser.eval(s, `__mvStore.getState().dirty`)).toBe(true)
    // and leaving it by hand (a reload, a close) asks first: the edits are only here
    const asks = `(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })()`
    expect(await browser.eval(s, asks)).toBe(true)

    // ---- B takes the port: refused, never reloaded into it, its broadcasts never reach the page ---------
    const away = record(browser, s)
    b = await startDev(rootB, PORT)
    const boardB = readFileSync(join(rootB, 'design', 'boards', 'main.json'), 'utf8')
    await browser.until(s, `__mvLink.getState().link === 'elsewhere'`, 5_000)
    await wait(3000)
    expect(await browser.eval(s, `window.__mark`)).toBe(1)   // the same document: Vite never reloaded it into B
    expect(await browser.eval(p, `window.__mark`)).toBe(1)
    expect(await browser.eval(s, `document.querySelector('.sh-stopped')?.textContent`)).toBe(BANNER)
    expect(await browser.eval(s, `__mvStore.getState().save()`)).toBe(false)
    expect(await browser.eval(s, `__mvStore.getState().dirty`)).toBe(true)
    // the same request, sent raw by the page, is refused by B's guard before any write
    const raw = await browser.eval(s, `(async () => { const st = __mvStore.getState(); const r = await fetch('/__mv/api/boards/main', { method: 'PUT', headers: { 'x-mv-ws': ${JSON.stringify(WS_A)}, 'content-type': 'application/json', 'x-test-raw': '1' }, body: JSON.stringify({ board: JSON.parse(${JSON.stringify(board)}), baseHash: st.boardHash, mustExist: true }) }); return { status: r.status, body: await r.json() } })()`)
    expect(raw).toEqual({ status: 409, body: { error: 'another workspace' } })
    // B broadcasts a new frame: the page's live socket stays closed, so it never hears of it
    writeFileSync(join(rootB, 'design', 'scenes', 'app', 'extra.tsx'), `export const meta = { title: 'Extra' }\nexport default () => <h1>B extra</h1>\n`)
    await wait(1500)
    expect(await browser.eval(s, `__mvStore.getState().manifest.frames.map((f) => f.id).includes('app/extra')`)).toBe(false)
    expect(readFileSync(join(rootB, 'design', 'boards', 'main.json'), 'utf8')).toBe(boardB)

    // ---- the frames and the stage: their own Vite client reloads them into B's "another canvas" page ----
    await browser.until(s, `(() => { const t = (k) => document.querySelector('[data-node="' + k + '"] iframe')?.contentDocument?.body?.innerText ?? ''; return t('n-home').includes('belongs to another canvas') && t('n-page').includes('belongs to another canvas') })()`, 10_000)
    await browser.until(p, `(document.querySelector('.sh-play iframe')?.contentDocument?.body?.innerText ?? '').includes('belongs to another canvas')`, 10_000)
    for (const key of ['n-home', 'n-page']) expect(await iframeWho(s, key), key).toBeNull()
    await shot(s, 'stopped'); await shot(p, 'stopped-play')
    // reloaded by the shell, and by hand: still the page, never B's frame
    await browser.eval(s, `__mvStore.getState().reloadFrame('n-page')`)
    await wait(800)
    await browser.eval(s, `document.querySelector('[data-node="n-home"] iframe').contentWindow.location.reload()`)
    await wait(1500)
    for (const key of ['n-home', 'n-page']) {
      expect(await iframeText(s, key), key).toContain('belongs to another canvas')
      expect(await iframeWho(s, key), key).toBeNull()
    }
    expect(await stageText(p)).toContain('belongs to another canvas')
    expect(await browser.eval(p, `document.querySelector('.sh-play iframe')?.contentWindow?.__who ?? null`)).toBeNull()
    away.stop()
    // the shell itself sent B one question only: "is my canvas back?" (the raw PUT above was the test's)
    const fromShell = away.sent.filter((r) => r.frame === main && !r.headers['x-test-raw'])
    expect(fromShell.length).toBeGreaterThan(0)
    expect([...new Set(fromShell.map((r) => r.path))]).toEqual(['/__mv/api/hello'])

    // ---- the race a save can lose: one sent as the socket dropped reaches B, and B's marked refusal comes back
    // through the helper as "stopped" - never as the board save's own 409, which would load B's board here ----
    const raced = record(browser, s)
    const race = await browser.eval(s, `(async () => {
      __mvLink.setState({ link: 'live' })
      const st = __mvStore.getState()
      st.moveNode('n-home', st.nodes.find((n) => n.key === 'n-home').x + 30, 0)
      const want = __mvStore.getState().nodes.find((n) => n.key === 'n-home').x
      const ok = await __mvStore.getState().save()
      const after = __mvStore.getState(), l = __mvLink.getState()
      return { ok, dirty: after.dirty, kept: after.nodes.find((n) => n.key === 'n-home').x === want, x: want, disk: after.toasts.some((t) => /changed on disk/.test(t.text)), link: l.link, shown: l.shown }
    })()`)
    raced.stop()
    expect(raced.sent.some((r) => r.frame === main && r.method === 'PUT' && r.path === '/__mv/api/boards/main' && r.headers['x-mv-ws'] === WS_A), 'the save reached B').toBe(true)
    expect(race).toEqual({ ok: false, dirty: true, kept: true, x: expect.any(Number), disk: false, link: 'elsewhere', shown: true })
    expect(race.x).toBeCloseTo(x1 + 150, 0)
    expect(await browser.eval(s, `document.querySelector('.sh-stopped')?.textContent`)).toBe(BANNER)
    expect(readFileSync(join(rootB, 'design', 'boards', 'main.json'), 'utf8')).toBe(boardB)

    // ---- A is back: the same document saves the move, then reloads ---------------------------------
    await stopDev(b, PORT); b = null
    a = await startDev(rootA, PORT)
    const moved = race.x
    const t0 = Date.now()
    let saved = -1
    while (Date.now() - t0 < 15_000) {
      saved = JSON.parse(readFileSync(join(rootA, 'design', 'boards', 'main.json'), 'utf8')).nodes.find((n: any) => n.key === 'n-home').x
      if (saved === Math.round(moved)) break
      await wait(200)
    }
    expect(saved).toBe(Math.round(moved))
    await browser.until(s, `window.__mark === undefined && !!window.__mvStore && document.querySelectorAll('.sh-node').length === 2`, 15_000)
    await browser.until(s, `!document.querySelector('.sh-stopped') && __mvLink.getState().link === 'live'`, 5_000)
    expect(await browser.eval(s, `__mvStore.getState().nodes.find((n) => n.key === 'n-home').x`)).toBe(Math.round(moved))
    expect(await browser.eval(s, asks)).toBe(false)
    await browser.until(s, `document.querySelector('[data-node="n-page"] iframe')?.contentDocument?.getElementById('who')?.textContent === 'A'`, 30_000)
    await browser.until(p, `window.__mark === undefined && document.querySelector('.sh-play iframe')?.contentDocument?.getElementById('who')?.textContent === 'A'`, 30_000)

    // ---- and no service worker ever registers on a canvas -------------------------------------------
    const sw = await browser.eval(s, `navigator.serviceWorker.register('/sw.js').then(() => 'registered', (e) => 'refused: ' + e.message)`)
    expect(sw).toMatch(/^refused: .*403/)
  }, 240_000)

  it('back while a capture records: the page works as live, still sees a stop, brings its frames back, and reloads once nothing holds it', async (ctx) => {
    if (!browser) return ctx.skip()
    await stopDev(b, PORT); b = null
    a ??= await startDev(rootA, PORT)
    const s = await browser.tab({ width: 1400, height: 900 })
    await browser.go(s, `${ORIGIN}/#/b/main`)
    await browser.until(s, `(() => { const t = (k) => document.querySelector('[data-node="' + k + '"] iframe')?.contentDocument?.getElementById('who')?.textContent; return t('n-home') === 'A' && t('n-page') === 'A' })()`, 30_000)
    await browser.eval(s, `__mvJamCapture.getState().start()`)
    await browser.until(s, `!!__mvJamCapture.getState().current`, 5_000)
    await browser.eval(s, `window.__mark = 2`)

    // the canvas restarts under the recording: it comes back, saves - and the page stays, saying it will reload
    await stopDev(a, PORT); a = null
    await browser.until(s, `__mvLink.getState().link === 'down' && !!document.querySelector('.sh-stopped')`, 5_000)
    a = await startDev(rootA, PORT)
    await browser.until(s, `__mvLink.getState().link === 'live' && !document.querySelector('.sh-stopped') && __mvStore.getState().toasts.some((t) => t.text.includes('reloads once nothing is in progress'))`, 15_000)
    await wait(2500)
    expect(await browser.eval(s, `window.__mark`)).toBe(2)
    expect(await browser.eval(s, `!!__mvJamCapture.getState().current`)).toBe(true)
    // live meanwhile: an edit reaches the disk
    const x = await browser.eval(s, `__mvStore.getState().nodes.find((n) => n.key === 'n-home').x`)
    await browser.eval(s, `__mvStore.getState().moveNode('n-home', ${x} + 40, 0)`)
    const onDisk = () => JSON.parse(readFileSync(join(rootA, 'design', 'boards', 'main.json'), 'utf8')).nodes.find((n: any) => n.key === 'n-home').x
    const t0 = Date.now()
    while (Date.now() - t0 < 10_000 && onDisk() !== Math.round(x + 40)) await wait(200)
    expect(onDisk()).toBe(Math.round(x + 40))

    // a second stop is seen though Vite's socket never came back: the banner, and saves held
    await stopDev(a, PORT); a = null
    await browser.until(s, `__mvLink.getState().link === 'down' && document.querySelector('.sh-stopped')?.textContent === ${JSON.stringify(BANNER)}`, 8_000)
    expect(await browser.eval(s, `__mvStore.getState().save()`)).toBe(false)
    // another project takes the port meanwhile: the frames' own Vite client reloads them into its "another
    // canvas" page, which runs no script - nothing brings them back by itself
    b = await startDev(rootB, PORT)
    await browser.until(s, `__mvLink.getState().link === 'elsewhere'`, 5_000)
    const stranded = `['n-home', 'n-page'].every((k) => (document.querySelector('[data-node="' + k + '"] iframe')?.contentDocument?.body?.innerText ?? '').includes('belongs to another canvas'))`
    await browser.until(s, stranded, 10_000)
    await stopDev(b, PORT); b = null
    // something takes the port and never answers (a server half up, hung): the question it gets is a miss
    // after 2 s, so none hangs for good - the page still sees its canvas come back
    const held: Socket[] = []
    const hung = createServer((c) => { held.push(c) })
    await new Promise<void>((r) => hung.listen({ port: PORT, host: '::' }, () => r()))
    try {
      await wait(3000)
      expect(held.length, 'the page asked the hung server').toBeGreaterThan(0)
      expect(await browser.eval(s, `!!document.querySelector('.sh-stopped')`)).toBe(true)
      hung.close()   // no longer listening; the connections it took stay open, unanswered
      await wait(300)
      a = await startDev(rootA, PORT)
      await browser.until(s, `__mvLink.getState().link === 'live' && !document.querySelector('.sh-stopped')`, 15_000)
    } finally { for (const c of held) c.destroy(); hung.close() }
    expect(await browser.eval(s, `window.__mark`)).toBe(2)
    // the page stays, so it brings its stranded frames back itself: reloaded in place, on A
    await browser.until(s, `(() => { const t = (k) => document.querySelector('[data-node="' + k + '"] iframe')?.contentDocument?.getElementById('who')?.textContent; return t('n-home') === 'A' && t('n-page') === 'A' })()`, 15_000)

    // words typed and not sent (a comment, a Jam edit - here a field of the page's own) hold the reload too
    await browser.eval(s, `(() => { const t = document.createElement('textarea'); t.id = 'typed'; document.body.appendChild(t); t.value = 'not sent yet'; t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    // the capture ends and seals: what still holds the page is the words
    await browser.eval(s, `__mvJamCapture.getState().end()`)
    await browser.until(s, `!Object.keys(__mvJamCapture.getState().caps).length`, 60_000)
    await wait(2500)
    expect(await browser.eval(s, `window.__mark`)).toBe(2)
    // sent (the field empties): nothing holds the page any more, and it reloads on its own canvas
    await browser.eval(s, `(() => { const t = document.getElementById('typed'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    await browser.until(s, `window.__mark === undefined && !!window.__mvStore && document.querySelectorAll('.sh-node').length === 2`, 15_000)
    await browser.until(s, `__mvLink.getState().link === 'live' && !document.querySelector('.sh-stopped')`, 5_000)
    expect(await browser.eval(s, `__mvStore.getState().nodes.find((n) => n.key === 'n-home').x`)).toBe(Math.round(x + 40))
  }, 240_000)

  it('words typed while the resume save waits on the server hold the reload: asked again right before it', async (ctx) => {
    if (!browser) return ctx.skip()
    await stopDev(b, PORT); b = null
    a ??= await startDev(rootA, PORT)
    const s = await browser.tab({ width: 1400, height: 900 })
    await browser.go(s, `${ORIGIN}/#/b/main`)
    await browser.until(s, `(() => { const t = (k) => document.querySelector('[data-node="' + k + '"] iframe')?.contentDocument?.getElementById('who')?.textContent; return t('n-home') === 'A' && t('n-page') === 'A' })()`, 30_000)
    await browser.eval(s, `window.__mark = 3`)
    // the canvas stops with an edit only this tab holds
    await stopDev(a, PORT); a = null
    await browser.until(s, `__mvLink.getState().link === 'down' && !!document.querySelector('.sh-stopped')`, 5_000)
    const x = await browser.eval(s, `__mvStore.getState().nodes.find((n) => n.key === 'n-home').x`)
    await browser.eval(s, `__mvStore.getState().moveNode('n-home', ${x} + 70, 0)`)
    // the board save the resume makes waits on the server until the test lets it through
    await browser.eval(s, `(() => {
      const real = window.fetch.bind(window)
      let open; const gate = new Promise((r) => { open = r }); window.__open = open
      window.fetch = (url, init) => {
        if (init?.method === 'PUT' && String(url).includes('/api/boards/main')) { window.__held = true; return gate.then(() => real(url, init)) }
        return real(url, init)
      }
      return 1
    })()`)
    a = await startDev(rootA, PORT)
    await browser.until(s, `window.__held === true && __mvLink.getState().link === 'resuming'`, 15_000)
    // typed meanwhile - after the words were last asked about, before the save answers
    await browser.eval(s, `(() => { const t = document.createElement('textarea'); t.id = 'typed-late'; document.body.appendChild(t); t.value = 'typed while it saved'; t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    await browser.eval(s, `window.__open()`)
    const onDisk = () => JSON.parse(readFileSync(join(rootA, 'design', 'boards', 'main.json'), 'utf8')).nodes.find((n: any) => n.key === 'n-home').x
    const t0 = Date.now()
    while (Date.now() - t0 < 10_000 && onDisk() !== Math.round(x + 70)) await wait(200)
    expect(onDisk()).toBe(Math.round(x + 70))
    // saved, and the page stays: the words are still here
    await wait(2500)
    expect(await browser.eval(s, `window.__mark`)).toBe(3)
    expect(await browser.eval(s, `document.getElementById('typed-late')?.value`)).toBe('typed while it saved')
    expect(await browser.eval(s, `__mvLink.getState().link`)).toBe('live')
    // sent (the field empties): nothing holds it, and it reloads on its own canvas
    await browser.eval(s, `(() => { const t = document.getElementById('typed-late'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    await browser.until(s, `window.__mark === undefined && !!window.__mvStore && document.querySelectorAll('.sh-node').length === 2`, 15_000)
    expect(await browser.eval(s, `__mvStore.getState().nodes.find((n) => n.key === 'n-home').x`)).toBe(Math.round(x + 70))
  }, 240_000)
})
