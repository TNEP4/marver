import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { workspaceId } from '../src/server/workspace.ts'
import { UNSAVED_WHY, WHY } from '../src/shared/app-api.ts'

/**
 * The marver package's side of the Mac app (spec 28 A2.9, A2.14 #9, #13, #15, #18, #23, #26; v1.12 r1 #1, v1.13 r2
 * #1), against a REAL `marver dev` and a REAL Chrome whose page gets a fake `window.marverApp` before any script runs.
 * The fake records every call and stands in for the canvas preload as the contract freezes it: nothing reaches "main"
 * before an admission, and each admission replays the latest hello, theme, busy and menu - hello first - stamped with
 * its `doc`. Checked: hello first with the shell's PAGE_ID, then theme, busy and menu, each whole; busy by its enum,
 * for every reason; the theme of play; the menu's items, their keys in their hints, and a click doing what the key
 * does; a resume reconcile on `shown`; every microphone track stopped on `untrusted`. In every browser, as A2.9 means
 * them to change it: the camera over a reload, the one beforeunload (a real reload asks; the page's own does not), the
 * glass opaque under Reduce Transparency and Increase Contrast. Everything else is 0.27.0's shell where there is no
 * bridge: in Chrome nothing of the bridge runs. The slot file lists `bridge` and the shell's name, and the dev logo is
 * proved with the slot file's key. Skips the browser cases without Chrome.
 */

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>\n'
const FRAME = (t: string) => `export const meta = { title: '${t}', viewport: 'mobile' }\nexport default () => <main style={{ padding: 24 }}><h1>${t}</h1></main>\n`
const DOC = `import { Doc, Md } from '@marver-design/marver/content'
export const meta = { title: 'Notes', viewport: 'laptop' }
export default () => (
  <Doc>
${Array.from({ length: 6 }, (_, i) => `    <Md>{${JSON.stringify(`## Part ${i + 1}\n\nA paragraph long enough to wrap across lines in a document-width frame, so its height is real.`)}}</Md>`).join('\n')}
  </Doc>
)
`

let root = ''
let bin = ''
let dev: Dev | null = null
let browser: Browser | null = null
let ws = ''
const tabs: string[] = []

beforeAll(async () => {
  // Live Jam on (its menu items), with an agent that never runs: a `claude` that exits
  bin = realpathSync(mkdtempSync(join(tmpdir(), 'mv-bridge-bin-')))
  writeFileSync(join(bin, 'claude'), '#!/usr/bin/env node\nprocess.exit(1)\n')
  chmodSync(join(bin, 'claude'), 0o755)
  root = fixtureRoot('mv-bridge-', {
    'design/config.ts': `export default { share: { name: 'Bridge canvas' } }\n`,
    'design/logo.svg': SVG,
    'design/scenes/demo/one.tsx': FRAME('One'),
    'design/scenes/demo/two.tsx': FRAME('Two'),
    'design/scenes/demo/doc.tsx': DOC,
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', order: 0, auto: false, nodes: [
      { key: 'n-one', frame: 'demo/one', x: 0, y: 0, w: 390, h: 844 },
      { key: 'n-two', frame: 'demo/two', x: 2400, y: 1400, w: 390, h: 844 },
      { key: 'n-doc', frame: 'demo/doc', x: 600, y: 0 },
    ] }),
  })
  ws = workspaceId(root)
  dev = await startDev(root, { env: { PATH: `${bin}:${process.env.PATH}` } })
  browser = await Browser.launch(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
}, 120_000)

/** A tab kept across one describe's cases; every other closes after its case - a window left open can cover the next
 *  one's, and Chrome then calls that page hidden (no animation frames: the camera never moves) */
const kept = new Set<string>()
const closeTabs = async (all = false) => {
  for (const s of [...tabs]) if (all || !kept.has(s)) { tabs.splice(tabs.indexOf(s), 1); kept.delete(s); await browser?.closeTab(s).catch(() => {}) }
}
afterEach(() => closeTabs())
afterAll(async () => {
  await closeTabs(true)
  browser?.close()
  await dev?.stop()
  for (const d of [root, bin]) if (d) rmSync(d, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The fake bridge, run at document start: the preload's contract, recorded. `cfg.on` false: no bridge at all (Chrome). */
type Fake = { on: boolean; v?: number; reopen?: boolean; partial?: boolean; mic?: boolean; stallTicket?: boolean; ws?: string }
const FAKE = (cfg: Fake) => `(() => {
  const cfg = ${JSON.stringify(cfg)}
  const realFetch = window.fetch.bind(window)
  const fetched = []
  const json = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }))
  window.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input)
    fetched.push(url)
    // the microphone's case: a speech engine that is ready, and an audio connection that opens (no model needed)
    if (cfg.mic && url.includes('/__mv/api/jam/voice')) return json({ state: 'ready', mb: 1 })
    // stallTicket: the audio ticket's request waits until the case lets it go (the page itself stays responsive)
    if (cfg.mic && cfg.stallTicket && url.includes('/__mv/api/jam/audio-ticket')) return new Promise((r) => { window.__releaseTicket = () => { r(new Response(JSON.stringify({ ticket: 't' }), { status: 200, headers: { 'content-type': 'application/json' } })); return 1 } })
    if (cfg.mic && url.includes('/__mv/api/jam/audio-ticket')) return json({ ticket: 't' })
    return realFetch(input, init)
  }
  const tracks = []
  if (cfg.mic) {
    try { localStorage.setItem('mv-jam-voice:' + cfg.ws, 'yes') } catch {}
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); tracks.push(...s.getTracks()); return s }
    const Real = window.WebSocket
    class FakeAudio { constructor(url) { this.url = url; this.readyState = 0; this.binaryType = 'blob'; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen() }, 0) } send() {} close() { this.readyState = 3 } }
    window.WebSocket = new Proxy(Real, { construct(t, args) { return String(args[0]).includes('/jam/audio') ? new FakeAudio(args[0]) : new t(...args) } })
  }
  window.__fakeTracks = () => tracks.map((t) => t.kind + ':' + t.readyState)
  window.__fakeFetched = fetched
  if (!cfg.on) return
  const log = [], sent = []
  let doc = null
  const held = {}
  const appState = new Set(), menuClick = new Set()
  const copy = (p) => JSON.parse(JSON.stringify(p))
  const send = (ch, p) => { if (doc) sent.push([ch, copy(p), doc]) }
  const say = (ch) => (p) => { log.push([ch, copy(p)]); held[ch] = copy(p); send(ch, p) }
  const api = { v: cfg.v ?? 1, topInset: 0, reopen: !!cfg.reopen, hello: say('hello'), theme: say('theme'), busy: say('busy'),
    onAppState: (fn) => { appState.add(fn); return () => appState.delete(fn) },
    onMenuClick: (fn) => { menuClick.add(fn); return () => menuClick.delete(fn) } }
  if (!cfg.partial) api.menu = say('menu')
  window.marverApp = Object.freeze(api)
  window.__fake = {
    log, sent,
    /** main admits this document: what the page said is replayed, the latest of each, hello first */
    admit(d) { doc = d; for (const ch of ['hello', 'theme', 'busy', 'menu']) if (ch in held) sent.push([ch, held[ch], d]); return sent.length },
    state(s) { for (const fn of appState) fn(s); return appState.size },
    click(id) { for (const fn of menuClick) fn({ id }); return menuClick.size },
    listeners: () => appState.size + menuClick.size,
    last: (ch) => { for (let i = log.length - 1; i >= 0; i--) if (log[i][0] === ch) return log[i][1]; return null },
    all: (ch) => log.filter((x) => x[0] === ch).map((x) => x[1]),
  }
})()`

const scripts = new Map<string, string>()
async function fake(s: string, cfg: Fake) {
  const was = scripts.get(s)
  if (was) await browser!.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: was }, s)
  const { identifier } = await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE({ ws, ...cfg }) }, s)
  scripts.set(s, identifier)
}
/** A tab of its own (its own storage), the fake installed, the canvas loaded on `hash` and its board shown. */
async function open(cfg: Fake, hash = '#/b/main'): Promise<string> {
  const s = await browser!.tab({ width: 1400, height: 900 })
  tabs.push(s)
  if (cfg.mic) await browser!.grant(s, dev!.origin, ['audioCapture'])
  await fake(s, cfg)
  await load(s, hash)
  return s
}
const booted = `!!window.__mvStore && __mvStore.getState().nodes.length === 3 && __mvStore.getState().nodes.every((n) => n.status === 'ready')`
async function load(s: string, hash: string) {
  await browser!.go(s, 'about:blank')
  await browser!.go(s, `${dev!.origin}/${hash}`)
  await browser!.until(s, booted, 30_000)
  await browser!.send('Page.bringToFront', {}, s)
}
const ev = (s: string, js: string) => browser!.eval(s, js)
const until = (s: string, js: string, ms = 10_000) => browser!.until(s, js, ms)
/** heights written, the board saved: nothing in flight, so each case starts at rest */
const atRest = (s: string) => until(s, `!__mvApp.busy().busy && !__mvStore.getState().dirty`, 15_000)
const scale = (s: string): Promise<number> => ev(s, `(() => { const v = __mvJamCanvas.view(); return Math.round(document.querySelector('.sh-canvas').clientWidth / v.w * 1000) / 1000 })()`)
const skip = (ctx: { skip: () => void }) => { if (!browser) ctx.skip() }
const busyRight = (b: { busy: boolean; unsaved: boolean; why: string[] }) =>
  b.busy === b.why.length > 0 && b.unsaved === b.why.some((w) => (UNSAVED_WHY as readonly string[]).includes(w)) &&
  new Set(b.why).size === b.why.length && b.why.every((w, i) => WHY.indexOf(w as never) >= 0 && (i === 0 || WHY.indexOf(b.why[i - 1] as never) < WHY.indexOf(w as never)))

const MENU = [
  ['fit-all', 'view', 'Fit All', '⇧1'], ['fit-selection', 'view', 'Fit Selection', '⇧2'], ['actual-size', 'view', 'Actual Size', '⇧0'],
  ['play', 'view', 'Play', 'P'], ['hide-ui', 'view', 'Hide UI', 'H'], ['tidy', 'view', 'Tidy', 'T'], ['comments', 'view', 'Comments', 'C'],
  ['pins', 'view', 'Pins', '⇧C'], ['notes', 'view', 'Notes', 'N'], ['laser', 'view', 'Laser', 'L'], ['inspect', 'view', 'Inspect', '⌥L'],
  ['theme', 'view', 'Theme', 'D'], ['session', 'jam', 'Session', 'J'], ['capture', 'jam', 'Capture', 'S'], ['lane', 'jam', 'The Lane', 'Q'],
  ['next-review', 'jam', 'Next to Review', 'V'],
] as const
const CHECKBOXES = ['hide-ui', 'comments', 'pins', 'notes', 'laser', 'inspect', 'session', 'capture', 'lane']

describe('the slot file and the logo, for the app (A2.14 #15, #23; A2.4)', () => {
  const slotFile = () => {
    const dir = join(process.env.MARVER_HOME!, 'running')
    for (const f of readdirSync(dir)) {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (r.port === dev!.port) return r
    }
    throw new Error('no slot file for the canvas')
  }

  it('0.27.1 lists the bridge, and the name the shell shows (share.name)', () => {
    expect(slotFile()).toMatchObject({ state: 'ready', features: ['bridge'], name: 'Bridge canvas', ws })
  })

  it('GET /__mv/logo is proved with the slot file\'s key - on a 200 and a 304 - and the workspace guard runs first', async () => {
    const f = slotFile()
    const nonce = randomBytes(24).toString('base64url')
    const sig = createHmac('sha256', Buffer.from(f.key, 'base64url')).update(`logo|${nonce}|${f.port}`).digest('base64url')
    const r = await fetch(`${dev!.origin}/__mv/logo`, { headers: { 'x-mv-nonce': nonce } })
    expect([r.status, r.headers.get('content-type'), r.headers.get('x-mv-instance'), r.headers.get('x-mv-proof'), await r.text()])
      .toEqual([200, 'image/svg+xml', f.instance, sig, SVG])
    const again = await fetch(`${dev!.origin}/__mv/logo`, { headers: { 'x-mv-nonce': nonce, 'if-none-match': r.headers.get('etag')! } })
    expect([again.status, again.headers.get('x-mv-proof')]).toEqual([304, sig])
    // the document's proof is another message: a logo proof never passes for the shell's document
    expect(sig).not.toBe(createHmac('sha256', Buffer.from(f.key, 'base64url')).update(`doc|${nonce}|${f.port}`).digest('base64url'))
    const other = await fetch(`${dev!.origin}/__mv/logo`, { headers: { 'x-mv-ws': 'f'.repeat(16) } })
    expect([other.status, other.headers.get('x-mv-elsewhere')]).toEqual([409, '1'])
  })
})

describe('with the app\'s bridge (A2.9)', () => {
  let s = ''
  beforeAll(async () => { if (browser) { s = await open({ on: true }); kept.add(s) } }, 60_000)
  afterAll(async () => { kept.delete(s); await closeTabs() })

  it('hello first - its version, the board its link names, the PAGE_ID the recorder stamps - then theme, busy and menu, whole, at boot', async (ctx) => {
    skip(ctx)
    const log = await ev(s, `__fake.log.slice(0, 4)`)
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
    const page = await ev(s, `__mvRecorder.page`)
    expect(page).toBe(await ev(s, `__mvApp.page`))
    expect(log[0]).toEqual(['hello', { version: pkg, board: 'main', page }])
    expect(page).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(log[1]).toEqual(['theme', { dark: false }])
    // the first mv:busy at boot (v1.13 r2 #1): the app's record is unknown for one turn at most
    expect(log[2]).toEqual(['busy', { busy: false, unsaved: false, why: [] }])
    expect(log[3][0]).toBe('menu')
    // the View and Jam items, each key in its hint (shown in the item's name, never an accelerator)
    const menu = await ev(s, `__fake.last('menu')`)
    expect(menu.map((m: any) => [m.id, m.group, m.label, m.hint])).toEqual(MENU.map((m) => [...m]))
    for (const m of menu) {
      expect(m.id).toMatch(/^[a-z][a-z0-9-]{0,31}$/)
      expect(m.label.length).toBeLessThanOrEqual(48)
      expect(m.hint.length).toBeLessThanOrEqual(8)
      expect('checked' in m, m.id).toBe(CHECKBOXES.includes(m.id))
    }
    expect(menu.length).toBeLessThanOrEqual(40)
    expect(Object.fromEntries(menu.filter((m: any) => 'checked' in m).map((m: any) => [m.id, m.checked]))).toEqual({
      'hide-ui': false, comments: false, pins: true, notes: true, laser: false, inspect: false, session: false, capture: false, lane: false,
    })
  })

  it('admission: nothing reaches main before it; then the latest of each, hello first, under that doc; later messages as they come', async (ctx) => {
    skip(ctx)
    await atRest(s)   // the Doc's heights written: no busy report comes in between
    expect(await ev(s, `__fake.sent.length`)).toBe(0)
    // said before the admission: the dark theme
    await ev(s, `__mvStore.setState({ viewTheme: 'dark' }), 1`)
    await until(s, `__fake.last('theme').dark === true`)
    expect(await ev(s, `__fake.sent.length`)).toBe(0)
    await ev(s, `__fake.admit('doc-0123456789abcdef')`)
    const sent = await ev(s, `__fake.sent`)
    expect(sent.map((x: any) => [x[0], x[2]])).toEqual(['hello', 'theme', 'busy', 'menu'].map((c) => [c, 'doc-0123456789abcdef']))
    expect(sent[1][1]).toEqual({ dark: true })
    // after it, each message as it comes, under the same doc (the frames taking the light theme may re-measure: a
    // busy report can come too)
    const themes = `__fake.sent.filter((x) => x[0] === 'theme')`
    await ev(s, `__mvStore.setState({ viewTheme: 'light' }), 1`)
    await until(s, `${themes}.length === 2`)
    expect(await ev(s, `${themes}[1]`)).toEqual(['theme', { dark: false }, 'doc-0123456789abcdef'])
    expect(await ev(s, `__fake.sent.every((x) => x[2] === 'doc-0123456789abcdef')`)).toBe(true)
    // no second hello in a document's life; a change that changes nothing says nothing
    await ev(s, `__mvStore.setState({ viewTheme: 'light' }), 1`)
    await wait(200)
    expect(await ev(s, `__fake.all('hello').length`)).toBe(1)
    expect(await ev(s, `${themes}.length`)).toBe(2)
    await atRest(s)
  })

  it('the theme is the ground under the strip: play is dark whatever the view theme (A2.14 #26) - and the menu\'s Play opens it', async (ctx) => {
    skip(ctx)
    expect(await ev(s, `__fake.last('theme')`)).toEqual({ dark: false })
    await ev(s, `__fake.click('play')`)
    await until(s, `!!__mvStore.getState().play`)
    await until(s, `__fake.last('theme').dark === true`)
    await ev(s, `__mvStore.getState().setPlay(null), 1`)
    await until(s, `!__mvStore.getState().play && __fake.last('theme').dark === false`)
  })

  it('busy follows every reason by its enum - unsaved for the first five - and each report holds together (A2.14 #18)', async (ctx) => {
    skip(ctx)
    await atRest(s)
    // the Doc's heights were measured at load and written: unsaved until then
    expect(await ev(s, `__fake.all('busy').some((b) => b.why.includes('heights') && b.unsaved)`)).toBe(true)
    const last = `__fake.last('busy')`
    const is = (why: string[]) => until(s, `JSON.stringify(${last}.why) === ${JSON.stringify(JSON.stringify(why))}`)
    // an agent at work: busy, not unsaved
    await ev(s, `__mvStore.getState().setWorking(['demo/one']), 1`)
    await is(['agent'])
    expect(await ev(s, last)).toEqual({ busy: true, unsaved: false, why: ['agent'] })
    await ev(s, `__mvStore.getState().setWorking([]), 1`)
    await is([])
    // a board edit: unsaved until its save lands
    await ev(s, `(() => { const n = __mvStore.getState().nodes.find((x) => x.key === 'n-one'); __mvStore.getState().moveNode('n-one', n.x + 40, n.y); return 1 })()`)
    await is(['board-unsaved'])
    expect(await ev(s, last)).toEqual({ busy: true, unsaved: true, why: ['board-unsaved'] })
    await is([])
    // words typed and not sent - and gone with their field (no hook of their own: looked at again within a second)
    await ev(s, `(() => { const i = document.createElement('input'); i.id = 'words'; document.body.appendChild(i); i.focus(); return 1 })()`)
    await browser!.send('Input.insertText', { text: 'not sent yet' }, s)
    await is(['typing'])
    await ev(s, `document.getElementById('words').remove(), 1`)
    await is([])
    // a capture recording, then one sealed and not taken by the server
    await ev(s, `__mvJamCapture.getState().start(), 1`)
    await until(s, `${last}.why.includes('capture-recording')`)
    expect(await ev(s, `${last}.unsaved`)).toBe(true)
    await ev(s, `__mvJamCapture.getState().drop(), 1`)
    await until(s, `!${last}.why.includes('capture-recording')`)
    await ev(s, `__mvJamCapture.setState({ unsent: ['c-1'] }), 1`)
    await is(['capture-unsent'])
    await ev(s, `__mvJamCapture.setState({ unsent: [] }), 1`)
    await is([])
    // a Jam session: busy, not unsaved
    await ev(s, `__mvJamQueue.setState({ session: { id: 'ses-1', since: Date.now() } }), 1`)
    await is(['jam-session'])
    expect(await ev(s, `${last}.unsaved`)).toBe(false)
    await ev(s, `__mvJamQueue.setState({ session: null }), 1`)
    await is([])
    // two at once, in the contract's order
    await ev(s, `(__mvStore.getState().setWorking(['demo/two']), __mvJamCapture.setState({ unsent: ['c-2'] }), 1)`)
    await is(['capture-unsent', 'agent'])
    await ev(s, `(__mvStore.getState().setWorking([]), __mvJamCapture.setState({ unsent: [] }), 1)`)
    await is([])
    // every report main got held together: busy is any reason, unsaved any of the first five, each once, in order
    const all = await ev(s, `__fake.all('busy')`)
    expect(all.length).toBeGreaterThan(10)
    for (const b of all) expect(busyRight(b), JSON.stringify(b)).toBe(true)
    // and never the same report twice in a row
    for (let i = 1; i < all.length; i++) expect(JSON.stringify(all[i]), `report ${i}`).not.toBe(JSON.stringify(all[i - 1]))
  }, 60_000)

  it('a menu item does what its key does, and its mark follows the page - also with a text field focused; an unknown id does nothing', async (ctx) => {
    skip(ctx)
    const checked = (id: string) => `__fake.last('menu').find((m) => m.id === '${id}').checked`
    await ev(s, `__fake.click('hide-ui')`)
    await until(s, `document.body.classList.contains('sh-hide-ui') && ${checked('hide-ui')} === true`)
    await ev(s, `__fake.click('hide-ui')`)
    await until(s, `!document.body.classList.contains('sh-hide-ui') && ${checked('hide-ui')} === false`)
    await ev(s, `__fake.click('comments')`)
    await until(s, `__mvComments.getState().commentMode && ${checked('comments')} === true`)
    await ev(s, `__fake.click('comments')`)
    await until(s, `!__mvComments.getState().commentMode && ${checked('comments')} === false`)
    // ⌥L: inspect, the laser's other mode
    await ev(s, `__fake.click('inspect')`)
    await until(s, `__mvStore.getState().laser && __mvStore.getState().laserInspect && ${checked('inspect')} === true && ${checked('laser')} === false`)
    await ev(s, `__fake.click('laser')`)
    await until(s, `__mvStore.getState().laser && !__mvStore.getState().laserInspect && ${checked('laser')} === true && ${checked('inspect')} === false`)
    await ev(s, `__fake.click('laser')`)
    await until(s, `!__mvStore.getState().laser`)
    // ⇧1 with a field holding the focus: the person chose the item
    await ev(s, `__mvJamCanvas.zoomTo(1.37), 1`)
    await wait(600)
    expect(await scale(s)).toBeCloseTo(1.37, 2)
    await ev(s, `(() => { const i = document.createElement('input'); i.id = 'focus-here'; document.body.appendChild(i); i.focus(); return 1 })()`)
    await ev(s, `__fake.click('fit-all')`)
    await wait(600)
    expect(await scale(s)).not.toBeCloseTo(1.37, 2)
    await ev(s, `document.getElementById('focus-here').remove(), 1`)
    const before = await ev(s, `JSON.stringify([__fake.log.length, document.body.className, __mvStore.getState().laser])`)
    await ev(s, `(__fake.click('nope'), __fake.click(''), __fake.click('Fit-All'), 1)`)
    await wait(300)
    expect(await ev(s, `JSON.stringify([__fake.log.length, document.body.className, __mvStore.getState().laser])`)).toBe(before)
    await atRest(s)
  }, 60_000)

  it('shown: a resume reconcile - marks, working, the Jam queue, the board\'s hash; a board changed on disk loads again, never over an edit', async (ctx) => {
    skip(ctx)
    await atRest(s)
    await ev(s, `(__fakeFetched.length = 0, __fake.state('hidden'))`)
    await wait(500)
    expect(await ev(s, `__fakeFetched.filter((u) => u.includes('/__mv/api/'))`)).toEqual([])
    await ev(s, `__fake.state('shown')`)
    await until(s, `['/__mv/api/marks', '/__mv/api/work', '/__mv/api/jam/queue', '/__mv/api/boards/main'].every((p) => __fakeFetched.some((u) => new URL(u, location.href).pathname === p))`)
    // the hash it holds is not the file's: the board loads again
    await ev(s, `__mvStore.setState({ boardHash: 'stale' }), 1`)
    await ev(s, `__fake.state('shown')`)
    await until(s, `__mvStore.getState().boardHash !== 'stale'`)
    // an edit held here: never reloaded under it
    await ev(s, `(__fakeFetched.length = 0, __mvStore.setState({ boardHash: 'stale', dirty: true }), __fake.state('shown'))`)
    await wait(1000)
    expect(await ev(s, `__mvStore.getState().boardHash`)).toBe('stale')
    expect(await ev(s, `__fakeFetched.some((u) => u.includes('/__mv/api/boards/main'))`)).toBe(false)
    await ev(s, `(__mvStore.setState({ dirty: false }), __mvStore.getState().boot(), 1)`)
    await until(s, `__mvStore.getState().boardHash !== 'stale'`)
  }, 60_000)
})

describe('untrusted: the page stops every microphone track it holds (A2.14 #13)', () => {
  it('a live microphone is stopped at once, the busy report drops it, and nothing opens it again in this document', async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, mic: true })
    await ev(s, `__mvJamVoiceTalk('ses-mic', performance.timeOrigin + performance.now()).then(() => 1)`)
    await until(s, `__mvJamVoice.getState().live === true`, 15_000)
    expect(await ev(s, `__fakeTracks()`)).toEqual(['audio:live'])
    await until(s, `__fake.last('busy').why.includes('microphone')`)
    expect(await ev(s, `__fake.state('untrusted')`)).toBe(1)
    await until(s, `__fakeTracks().every((t) => t === 'audio:ended') && !__mvJamVoice.getState().live`, 5_000)
    await until(s, `!__fake.last('busy').why.includes('microphone')`)
    // the next talk asks for nothing: the app refuses new access anyway, and the page no longer asks
    await ev(s, `__mvJamVoiceTalk('ses-2', performance.timeOrigin + performance.now()).then(() => 1)`)
    await wait(1500)
    expect(await ev(s, `[__fakeTracks().length, __mvJamVoice.getState().live]`)).toEqual([1, false])
  }, 60_000)

  it('a microphone still opening - its track live, its audio ticket\'s request stalled - is stopped in the same turn', async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, mic: true, stallTicket: true })
    void ev(s, `__mvJamVoiceTalk('ses-open', performance.timeOrigin + performance.now()).then(() => 1)`).catch(() => {})
    // the opening holds a live track and waits on the ticket; the page answers meanwhile
    await until(s, `__fakeTracks().includes('audio:live') && __fakeFetched.some((u) => u.includes('/__mv/api/jam/audio-ticket'))`, 15_000)
    expect(await ev(s, `__mvJamVoice.getState().live`)).toBe(false)
    // the track has ended by the time the app's message returns - not at the opening's next wait
    expect(await ev(s, `(__fake.state('untrusted'), __fakeTracks())`)).toEqual(['audio:ended'])
    // the ticket comes back late: the opening finds itself cancelled and opens nothing
    expect(await ev(s, `__releaseTicket()`)).toBe(1)
    await wait(1500)
    expect(await ev(s, `[__fakeTracks(), __mvJamVoice.getState().live]`)).toEqual([['audio:ended'], false])
  }, 60_000)
})

describe('the camera over a reload (A2.9)', () => {
  it('a board opens where it was left - not when its link names a selection, unless the app reloaded it after a crash', async (ctx) => {
    skip(ctx)
    const s = await open({ on: false })
    await ev(s, `__mvJamCanvas.zoomTo(1.37), 1`)
    await wait(1600)   // settled, then a second
    const camera = JSON.parse(await ev(s, `localStorage.getItem('mv-camera:${ws}:main')`))
    expect(camera.scale).toBeCloseTo(1.37, 3)
    await load(s, '#/b/main')
    await wait(300)
    expect(await scale(s)).toBeCloseTo(1.37, 2)
    // a link that names a selection fits it
    await load(s, '#/b/main?n=n-two')
    await wait(300)
    expect(await ev(s, `__mvStore.getState().selection`)).toEqual(['n-two'])
    expect(await scale(s)).not.toBeCloseTo(1.37, 2)
    // the app reloaded the tab after a crash: the camera it had, the selection the link names
    await ev(s, `__mvJamCanvas.zoomTo(1.37), 1`)
    await wait(1600)
    await fake(s, { on: true, reopen: true })
    await load(s, '#/b/main?n=n-two')
    await wait(300)
    expect(await ev(s, `__mvStore.getState().selection`)).toEqual(['n-two'])
    expect(await scale(s)).toBeCloseTo(1.37, 2)
  }, 90_000)

  // the page hidden as Chrome hides it for a tab switch, or as the Mac app hides a tab it may then unload
  const HIDE = `(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); delete document.visibilityState; return 1 })()`

  it('written as the page hides or leaves, inside the second of quiet; mid-flight, where the flight was going; nothing pending, nothing (A3.8 #43)', async (ctx) => {
    skip(ctx)
    const key = `mv-camera:${ws}:main`
    const s = await open({ on: false })
    const stored = () => ev(s, `JSON.parse(localStorage.getItem('${key}') ?? 'null')`)
    // a move, then hidden 150 ms later: written at visibilitychange, a second early
    await ev(s, `__mvJamCanvas.zoomTo(0.61), 1`)
    await wait(1600)
    await ev(s, `localStorage.removeItem('${key}'), 1`)
    await ev(s, `__mvJamCanvas.zoomTo(1.37), 1`)
    await wait(400)   // landed (250 ms), the write still a second away
    expect(await stored()).toBe(null)
    await ev(s, HIDE)
    expect((await stored())?.scale).toBeCloseTo(1.37, 3)
    // hidden mid-flight: the landing, not where the animation was
    await ev(s, `localStorage.removeItem('${key}'), 1`)
    expect(await ev(s, `new Promise((r) => { __mvJamCanvas.zoomTo(0.5); setTimeout(() => { ${HIDE}; r(JSON.parse(localStorage.getItem('${key}') ?? 'null')) }, 60) })`)).toMatchObject({ scale: 0.5 })
    // nothing pending: a hide writes nothing
    await wait(1600)
    await ev(s, `localStorage.removeItem('${key}'), 1`)
    await ev(s, HIDE)
    expect(await stored()).toBe(null)
    // pagehide alone: a move, then the page leaves 150 ms later - the next load opens there. Chrome fires
    // visibilitychange to hidden as a page leaves too: stopped here before the shell hears it (a capturing listener on
    // window comes first), so it is the pagehide listener that writes the camera
    await ev(s, `__mvJamCanvas.zoomTo(1.21), 1`)
    await wait(400)
    await ev(s, `addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true), 1`)
    await browser!.go(s, 'about:blank')
    await load(s, '#/b/main')
    await wait(300)
    expect(await scale(s)).toBeCloseTo(1.21, 2)
  }, 90_000)
})

describe('the one beforeunload, in every browser (A2.9)', () => {
  it('a reload by hand asks while words wait - and the page\'s own reload (leaveNow) never does', async (ctx) => {
    skip(ctx)
    const s = await open({ on: false })
    await atRest(s)
    const dialogs: string[] = []
    let answer = false
    const off = browser!.on((m) => {
      if (m.method === 'Page.javascriptDialogOpening' && m.sessionId === s) {
        dialogs.push(m.params.type)
        void browser!.send('Page.handleJavaScriptDialog', { accept: answer }, s)
      }
    })
    try {
      // a gesture first: Chrome asks only on a page that had one since it loaded
      await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 500, button: 'left', clickCount: 1 }, s)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 500, button: 'left', clickCount: 1 }, s)
      // nothing held: no question
      await ev(s, `(window.__mark = 1, setTimeout(() => location.reload(), 0), 1)`)
      await until(s, `!window.__mark && ${booted}`, 30_000)
      expect(dialogs).toEqual([])
      await atRest(s)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 500, button: 'left', clickCount: 1 }, s)
      await browser!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 500, button: 'left', clickCount: 1 }, s)
      await ev(s, `(() => { const i = document.createElement('textarea'); i.id = 'words'; document.body.appendChild(i); i.focus(); return 1 })()`)
      await browser!.send('Input.insertText', { text: 'a comment not sent' }, s)
      expect(await ev(s, `__mvApp.asks()`)).toBe(true)
      await ev(s, `(window.__mark = 1, setTimeout(() => location.reload(), 0), 1)`)
      await until(s, `true`)
      await wait(1000)
      expect(dialogs).toEqual(['beforeunload'])
      expect(await ev(s, `window.__mark`)).toBe(1)   // stayed: the words are still here
      expect(await ev(s, `document.getElementById('words').value`)).toBe('a comment not sent')
      // the page's own reload (A1's resume, once what it held is saved) goes without asking itself
      await ev(s, `(__mvApp.leaveNow(() => setTimeout(() => location.reload(), 0)), 1)`)
      await until(s, `!window.__mark && ${booted}`, 30_000)
      expect(dialogs).toEqual(['beforeunload'])
    } finally { off(); answer = true }
  }, 90_000)
})

describe('the glass in every browser (A2.9, A2.13)', () => {
  it('Reduce Transparency and Increase Contrast make the glass opaque - the sidebar and the toolbar on --solid, in both themes (A2.9, A2.13)', async (ctx) => {
    skip(ctx)
    const s = await open({ on: false })
    const fills = `(() => { const bg = (q) => getComputedStyle(document.querySelector(q)).backgroundColor; return [bg('.sh-app > .sh-panel'), bg('.sh-app > nav.sh-pill')] })()`
    const solid = `getComputedStyle(document.querySelector('.sh-app')).getPropertyValue('--solid').trim()`
    const rgb = async (hex: string) => ev(s, `(() => { const d = document.createElement('div'); d.style.color = ${JSON.stringify(hex)}; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c })()`)
    const glass = await ev(s, fills)
    expect(glass[0]).toMatch(/^rgba\(/)   // glass: see-through
    for (const theme of ['light', 'dark']) {
      await ev(s, `__mvStore.setState({ viewTheme: '${theme}' }), 1`)
      for (const feature of [{ name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-contrast', value: 'more' }]) {
        await browser!.send('Emulation.setEmulatedMedia', { features: [feature] }, s)
        await wait(700)   // the shell eases its tokens over 0.4 s
        const want = await rgb(await ev(s, solid))
        expect(await ev(s, fills), `${theme} ${feature.name}`).toEqual([want, want])
      }
      await browser!.send('Emulation.setEmulatedMedia', { features: [] }, s)
      await wait(700)
      expect((await ev(s, fills))[0], theme).toMatch(/^rgba\(/)
    }
    // more contrast: the dimmer inks take the full one
    await browser!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] }, s)
    await wait(700)
    expect(await ev(s, `(() => { const st = getComputedStyle(document.querySelector('.sh-app')); return [st.getPropertyValue('--glass-ink-2'), st.getPropertyValue('--glass-ink-3')].map((v) => v.trim() === st.getPropertyValue('--glass-ink').trim()) })()`)).toEqual([true, true])
  }, 60_000)
})

describe('without the app: 0.27.0\'s shell, in Chrome', () => {
  it('no window.marverApp: nothing of the bridge runs - no busy-only reasons, no menu, no listeners - and the canvas works as before', async (ctx) => {
    skip(ctx)
    const s = await open({ on: false })
    expect(await ev(s, `[typeof window.marverApp, __mvApp.active, typeof window.__fake]`)).toEqual(['undefined', false, 'undefined'])
    await atRest(s)
    // what only the app hears is never registered: an agent at work, a session - nothing for beforeunload either
    await ev(s, `(__mvStore.getState().setWorking(['demo/one']), __mvJamQueue.setState({ session: { id: 's', since: Date.now() } }), 1)`)
    await wait(200)
    expect(await ev(s, `[__mvApp.busy(), __mvApp.asks()]`)).toEqual([{ busy: false, unsaved: false, why: [] }, false])
    await ev(s, `(__mvStore.getState().setWorking([]), __mvJamQueue.setState({ session: null }), 1)`)
    // the keys the menu would replay are the page's, as ever
    await browser!.press(s, 'h')
    expect(await ev(s, `document.body.classList.contains('sh-hide-ui')`)).toBe(true)
    await browser!.press(s, 'h')
    expect(await ev(s, `document.body.classList.contains('sh-hide-ui')`)).toBe(false)
  }, 60_000)

  it('a bridge of another version, or one missing a method, is no bridge: the shell says nothing to it and hears nothing', async (ctx) => {
    skip(ctx)
    for (const cfg of [{ on: true, v: 2 }, { on: true, partial: true }]) {
      const s = await open(cfg)
      await wait(300)
      expect(await ev(s, `[__mvApp.active, __fake.log.length, __fake.listeners()]`), JSON.stringify(cfg)).toEqual([false, 0, 0])
    }
  }, 60_000)
})

// last in the file: it adds frames to the canvas and takes them away again
describe('the app\'s own menu item (A2.4)', () => {
  let s = ''
  beforeAll(async () => { if (browser) s = await open({ on: true }) }, 60_000)

  it('the app\'s own Mark All as Seen (the tab\'s right-click, A2.4): every frame\'s "new" cleared, here and on disk; never an item of the menu', async (ctx) => {
    skip(ctx)
    const seenOnDisk = () => { try { return JSON.parse(readFileSync(join(root, 'design', '.local', 'seen.json'), 'utf8')).frames as Record<string, number> } catch { return {} } }
    // two frames changed on disk, neither on the board the page shows (nothing looks at them): new until seen
    writeFileSync(join(root, 'design/scenes/demo/three.tsx'), FRAME('Three'))
    writeFileSync(join(root, 'design/scenes/demo/four.tsx'), FRAME('Four'))
    const isNew = (id: string) => `(() => { const m = __mvStore.getState().marks; return !!m && (m.changed['${id}'] ?? 0) > (m.seen['${id}'] ?? 0) })()`
    try {
      await until(s, `${isNew('demo/three')} && ${isNew('demo/four')}`, 15_000)
      expect(await ev(s, `__fake.last('menu').some((m) => m.id === 'mark-all-seen')`)).toBe(false)
      expect(await ev(s, `__fake.click('mark-all-seen')`)).toBeGreaterThan(0)
      await until(s, `(() => { const m = __mvStore.getState().marks; return Object.keys(m.changed).every((id) => (m.changed[id] ?? 0) <= (m.seen[id] ?? 0)) })()`)
      const changed = await ev(s, `__mvStore.getState().marks.changed`) as Record<string, number>
      const end = Date.now() + 5000
      while (Date.now() < end && !(seenOnDisk()['demo/three'] >= changed['demo/three'] && seenOnDisk()['demo/four'] >= changed['demo/four'])) await wait(50)
      expect(seenOnDisk()['demo/three']).toBeGreaterThanOrEqual(changed['demo/three']!)
      expect(seenOnDisk()['demo/four']).toBeGreaterThanOrEqual(changed['demo/four']!)
    } finally {
      rmSync(join(root, 'design/scenes/demo/three.tsx'), { force: true })
      rmSync(join(root, 'design/scenes/demo/four.tsx'), { force: true })
      // the canvas has dropped them again before anything else runs on it
      await until(s, `!__mvStore.getState().manifest.frames.some((f) => f.id === 'demo/three' || f.id === 'demo/four')`, 15_000).catch(() => {})
    }
    await atRest(s)
  }, 60_000)

})
