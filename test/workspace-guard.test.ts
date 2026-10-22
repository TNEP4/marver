import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeProject, startDev, stopDev, workspaceOf, type Dev } from './project.ts'

/**
 * Every request names its workspace (spec 28 A1.11), on the wire: a REAL dev server, plain requests.
 * The guard answers first - before /api/update (its own middleware), the API, the frame-host and stage
 * routes, Vite's file serving and its HTML - so a page left open after its canvas stopped never reads or
 * writes another project. A request naming no workspace is served as before; a service worker's script
 * is refused on every path; /api/poster is a POST.
 */

const PORT = 8400 + Math.floor(Math.random() * 300)
const OTHER = 'ffffffffffffffff'

let root = ''
let dev: Dev | null = null
let WS = ''
const at = (path: string, init?: RequestInit) => fetch(`${dev!.origin}${path}`, init)

beforeAll(async () => {
  root = makeProject('mv-wsguard-', {
    'design/scenes/app/home.tsx': `export const meta = { title: 'Home', viewport: 'mobile' }\nexport default () => <main><h1>Home</h1></main>\n`,
    'design/scenes/app/page.html': `<!doctype html><html><head><title>Page</title></head><body><h1>Page</h1><script>window.__who = 'here'</script></body></html>\n`,
    'design/boards/main.json': JSON.stringify({ version: 1, name: 'main', auto: false, nodes: [{ key: 'h', frame: 'app/home', x: 0, y: 0, w: 390, h: 844 }] }, null, 2) + '\n',
    'public/sw.js': `self.addEventListener('fetch', () => {})\n`,
  })
  WS = workspaceOf(root)
  dev = await startDev(root, PORT)
}, 120_000)

afterAll(async () => {
  await stopDev(dev, PORT).catch(() => {})
  rmSync(root, { recursive: true, force: true })
})

const refused = async (r: Response) => {
  expect(r.status).toBe(409)
  expect(r.headers.get('x-mv-elsewhere')).toBe('1')
  expect(r.headers.get('content-type')).toMatch(/application\/json/)
  expect(r.headers.get('set-cookie')).toBeNull()   // nothing of this server ran: not even the cookie prime
  expect(await r.json()).toEqual({ error: 'another workspace' })
}
const anotherCanvas = async (r: Response) => {
  expect(r.status).toBe(409)
  expect(r.headers.get('content-type')).toMatch(/text\/html/)
  const html = await r.text()
  expect(html).toContain('This frame belongs to another canvas')
  expect(html).not.toMatch(/<script/i)   // no Vite client: a frame that lands here stops reloading itself
}

describe('the workspace guard', () => {
  it('serves a request that names no workspace, or its own, as before', async () => {
    expect((await at('/__mv/api/boards')).status).toBe(200)
    expect((await at('/__mv/api/boards', { headers: { 'x-mv-ws': WS } })).status).toBe(200)
    const { board, sha256 } = await (await at('/__mv/api/boards/main', { headers: { 'x-mv-ws': WS } })).json()
    const moved = { ...board, nodes: [{ ...board.nodes[0], x: 40 }] }
    const put = await at('/__mv/api/boards/main', { method: 'PUT', headers: { 'x-mv-ws': WS, 'content-type': 'application/json' }, body: JSON.stringify({ board: moved, baseHash: sha256, mustExist: true }) })
    expect(put.status).toBe(200)
    expect(JSON.parse(readFileSync(join(root, 'design', 'boards', 'main.json'), 'utf8')).nodes[0].x).toBe(40)
  })

  it('refuses a request naming another workspace before reading or writing anything - the API, /api/update, the shell, the manifest', async () => {
    const before = readFileSync(join(root, 'design', 'boards', 'main.json'), 'utf8')
    const { sha256 } = await (await at('/__mv/api/boards/main')).json()
    const board = { ...JSON.parse(before), nodes: [] }
    await refused(await at('/__mv/api/boards', { headers: { 'x-mv-ws': OTHER } }))
    // the board file matches - the hash check alone would have let this write through
    await refused(await at('/__mv/api/boards/main', { method: 'PUT', headers: { 'x-mv-ws': OTHER, 'content-type': 'application/json' }, body: JSON.stringify({ board, baseHash: sha256, mustExist: true }) }))
    expect(readFileSync(join(root, 'design', 'boards', 'main.json'), 'utf8')).toBe(before)
    expect(readdirSync(join(root, 'design', 'boards')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    await refused(await at('/__mv/api/update', { headers: { 'x-mv-ws': OTHER } }))   // its middleware precedes the API's
    await refused(await at('/', { headers: { 'x-mv-ws': OTHER } }))
    await refused(await at('/design/manifest.json', { headers: { 'x-mv-ws': OTHER } }))
    await refused(await at('/__mv/api/hello', { headers: { 'x-mv-ws': OTHER } }))
    // present and not ours is enough: a malformed key is refused too
    await refused(await at('/__mv/api/boards', { headers: { 'x-mv-ws': 'nope' } }))
  })

  it('answers a document URL naming another workspace with the "another canvas" page - frame host, HTML frame, stage alike', async () => {
    await anotherCanvas(await at(`/__mv/frame/?id=app/home&theme=light&r=1&ws=${OTHER}`))
    await anotherCanvas(await at(`/design/scenes/app/page.html?theme=light&r=1&ws=${OTHER}`))
    await anotherCanvas(await at(`/__mv/stage/?at=app/home&theme=light&ws=${OTHER}`))
    // an <img> (a Jam picture) names it in its URL too: under the API, the JSON refusal
    await refused(await at(`/__mv/api/jam/picture?id=x&ws=${OTHER}`))
  })

  it('serves a document URL naming its own workspace, and one whose ws is not a workspace key, as before', async () => {
    const own = await at(`/__mv/frame/?id=app/home&theme=light&r=1&ws=${WS}`)
    expect(own.status).toBe(200)
    expect(await own.text()).toMatch(/<script/)
    const html = await at(`/design/scenes/app/page.html?theme=light&ws=${WS}`)
    expect(html.status).toBe(200)
    expect(await html.text()).toContain(`window.__who = 'here'`)
    // an authored frame's own ?ws= is the frame's business
    expect((await at('/design/scenes/app/page.html?ws=hello')).status).toBe(200)
  })

  it('GET /api/hello answers the workspace', async () => {
    const r = await at('/__mv/api/hello', { headers: { 'x-mv-ws': WS } })
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.json()).toEqual({ ok: true, ws: WS })
    expect(await (await at('/__mv/api/hello')).json()).toEqual({ ok: true, ws: WS })
  })

  it('refuses a service worker\'s script on every path: no service worker ever runs on a canvas', async () => {
    for (const path of ['/sw.js', '/design/scenes/app/page.html', '/__mv/api/boards', '/']) {
      const r = await at(path, { headers: { 'service-worker': 'script' } })
      expect(r.status, path).toBe(403)
    }
    expect((await at('/sw.js')).status).toBe(200)   // the file itself is still served as a file
  })

  it('the page reaches its server only through the one helper: every other transport is accounted for', () => {
    // a new request site that bypasses src/client/shell/api.ts would send no workspace - and a page left
    // open could write into whatever project took its port. Each exception says why it may.
    const allowed: Record<string, RegExp[]> = {
      'shell/api.ts': [/\bfetch\(url, /, /\bfetch\(`\$\{ROUTE\}\/api\/hello`/],                  // the helper itself, and its probe
      'shell/canvas/sleep.ts': [/\bfetch\(`\$\{ROUTE\}\/bakes\/\$\{BAKES\}\/index\.json`\)/],    // a published canvas's static textures
      'shell/comments-store.ts': [/new EventSource\(`\$\{ROUTE\}\/api\/events`\)/],              // published only: never opened in dev
      'shell/jam-voice.ts': [/new WebSocket\(/],                                                  // bound by its single-use ticket, asked through api()
      'content/video.tsx': [/\bfetch\(`\$\{ROUTE\}\/api\/policy`, \{ headers: named\(\) \}\)/, /\bfetch\(`\$\{ROUTE\}\/api\/poster`, \{ method: 'POST', headers: named\(/],   // a frame: names the workspace from its URL
      'content/img-lod.ts': [/\bfetch\(it\.src\)/],                                               // a frame's own image, never the API
    }
    const dir = join(import.meta.dirname, '..', 'src', 'client')
    const found: string[] = []
    for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
      if (!/\.(ts|tsx|js)$/.test(rel)) continue
      const file = rel.split('\\').join('/')
      readFileSync(join(dir, rel), 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/\b(?:fetch\(|navigator\.sendBeacon|XMLHttpRequest|new EventSource\(|new WebSocket\()/g)) {
          if (line.slice(0, m.index).endsWith('mv')) continue                                     // mvFetch(
          const at = line.slice(m.index)
          if (!(allowed[file] ?? []).some((re) => re.test(at))) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`)
        }
      })
    }
    expect(found).toEqual([])
  })

  it('/api/poster is a POST: the GET is gone, the POST is owner-gated and checks its clip', async () => {
    const get = await at('/__mv/api/poster?src=clip.mp4')
    expect(get.status).toBe(404)
    expect(await get.json()).toEqual({ error: 'unknown endpoint' })
    const json = { 'content-type': 'application/json', 'x-mv-ws': WS }
    expect((await at('/__mv/api/poster', { method: 'POST', headers: json, body: JSON.stringify({ src: 'clip.mp4' }) })).status).toBe(403)
    const gated = { ...json, cookie: 'mv_c=t0k3n', 'x-mv-c': 't0k3n' }
    const outside = await at('/__mv/api/poster', { method: 'POST', headers: gated, body: JSON.stringify({ src: '../x.mp4' }) })
    expect(outside.status).toBe(400)
    expect((await at('/__mv/api/poster', { method: 'POST', headers: gated, body: '{' })).status).toBe(400)
    // a clip that is not there: the request was read and judged (no poster is drawn from nothing)
    const missing = await at('/__mv/api/poster', { method: 'POST', headers: gated, body: JSON.stringify({ src: 'nothing.mp4' }) })
    expect(missing.status).toBe(404)
    expect(existsSync(join(root, 'design', 'assets', 'nothing.mp4.poster.png'))).toBe(false)
    // and another workspace's POST never reaches the route
    await refused(await at('/__mv/api/poster', { method: 'POST', headers: { ...gated, 'x-mv-ws': OTHER }, body: JSON.stringify({ src: 'clip.mp4' }) }))
  })
})
