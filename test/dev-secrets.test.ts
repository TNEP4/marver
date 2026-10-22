import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { init } from '../src/cli/init.ts'
import { agentEnv } from '../src/server/jam/daemon.ts'
import { isFileLoadingAllowed } from 'vite'
import { dev, FS_DENY, registryDeny } from '../src/server/dev.ts'
import { collabFileFor } from '../src/server/sync.ts'

/**
 * `marver dev` puts the repository on the web so frames can import from it, and
 * the repository is where the canvas keeps its credential.
 *
 * design/.local/collab.json holds a live session for the published canvas.
 * Authored frames run SAME-ORIGIN, so before the deny rule in dev.ts any frame
 * could `fetch('/design/.local/collab.json')` and carry that credential off - the
 * same extraction 2d0850c pulled the device flow over, reached by reading a file.
 *
 * Driven against a real Vite server on purpose. The interesting question is not
 * what the config object says, it is what the server actually hands out, and only
 * one of those two can be asserted by reading `dev.ts`.
 */

let root = ''
let server: Awaited<ReturnType<typeof dev>> | null = null
let base = ''

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // realpath, or the whole suite passes for the wrong reason: on macOS the temp
  // dir is /var/... which resolves to /private/var/..., Vite compares resolved
  // paths against fs.allow, and EVERYTHING under an unresolved root 403s - deny
  // rule or no deny rule.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mv-devsec-')))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host', type: 'module', devDependencies: {} }))
  init(root, { mode: 'studio', demo: true })
  // The file that matters: a real credential, written the real way.
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  // A credential of the shape an OLDER marver left behind. `dev` migrates this
  // out of the repository on boot, which is asserted below - so the guards are
  // tested against a file that stays put instead.
  writeFileSync(join(root, 'design', '.local', 'collab.json'),
    JSON.stringify({ url: 'https://canvas.example.test', token: 'a-live-session-token' }))
  // Something else private in the same directory, which nothing moves.
  writeFileSync(join(root, 'design', '.local', 'note.txt'), 'PRIVATE-LOCAL-CONTENT')
  writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Nic' }))
  // The files Vite denies by DEFAULT. They are planted because `fs.deny` replaces
  // that default list rather than extending it - so adding one rule of our own
  // silently re-exposed every one of these, a far bigger hole than the one closed.
  writeFileSync(join(root, '.env'), 'SECRET_FROM_ENV=dotenv-value')
  writeFileSync(join(root, '.env.production'), 'SECRET_FROM_ENV=dotenv-prod-value')
  writeFileSync(join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=npmrc-value')
  writeFileSync(join(root, 'server.pem'), '-----BEGIN PRIVATE KEY----- pem-value')
  writeFileSync(join(root, 'server.key'), 'key-file-value')
  writeFileSync(join(root, '.dev.vars'), 'CLOUDFLARE=devvars-value')
  // The bypass a glob cannot see: `fs.deny` matches the path ASKED FOR, then Vite
  // stats and streams whatever it resolves to. A repository can ship this.
  symlinkSync(join(root, 'design', '.local', 'note.txt'), join(root, 'leak.json'))
  symlinkSync(join(root, 'design', '.local'), join(root, 'design', 'shortcut'))
  // public/ is mapped onto / by Vite, and Vite skips its own deny checks for public
  // files entirely - so this spelling stayed reachable after the first realpath fix.
  mkdirSync(join(root, 'public'), { recursive: true })
  symlinkSync(join(root, 'design', '.local', 'note.txt'), join(root, 'public', 'pub-leak.json'))
  // Vite derives candidates: /derived resolves to derived/index.html.
  mkdirSync(join(root, 'derived'), { recursive: true })
  symlinkSync(join(root, 'design', '.local', 'note.txt'), join(root, 'derived', 'index.html'))
  symlinkSync(join(root, 'design', '.local', 'note.txt'), join(root, 'suffixed.html'))
  writeFileSync(join(root, 'public', 'ok.txt'), 'a public file that must still serve')
  server = await dev(root)
  const addr = server?.httpServer?.address() as any
  // Vite binds ::1 here, so the hostname has to be one that resolves to both -
  // 127.0.0.1 gets a flat ECONNREFUSED and reads like the server never started.
  base = `http://localhost:${addr.port}`
}, 120_000)

afterAll(async () => {
  await server?.close().catch(() => {})
  rmSync(collabFileFor(root), { force: true })
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const get = (path: string) => fetch(`${base}${path}`).then(async (r) => ({ status: r.status, body: await r.text() }))

describe('the dev server never serves design/.local', () => {
  it('has already moved the credential out of the repository', () => {
    // The real fix, and the reason the rest of this file is depth rather than
    // defence: `dev` calls loadCollab, which migrates any legacy credential to
    // ~/.marver/canvases. There is no longer a secret under the served root.
    expect(existsSync(join(root, 'design', '.local', 'collab.json'))).toBe(false)
    expect(readFileSync(collabFileFor(root), 'utf8')).toContain('a-live-session-token')
  })

  it('refuses anything else that is left in there', async () => {
    const r = await get('/design/.local/note.txt')
    expect(r.status).not.toBe(200)
    expect(r.body).not.toContain('PRIVATE-LOCAL-CONTENT')
  })

  it('refuses it through a traversal that resolves to the same file', async () => {
    // The deny list is matched against a path, so the interesting case is a path
    // that does not look like the one denied until it is resolved.
    for (const path of [
      '/design/boards/../.local/collab.json',
      '/design/.local/../.local/collab.json',
      '/design%2F.local%2Fcollab.json',
      '/@fs' + join(root, 'design', '.local', 'collab.json'),
    ]) {
      const r = await get(path)
      expect(r.body, `${path} leaked`).not.toContain('PRIVATE-LOCAL-CONTENT')
    }
  })

  it("does not trade Vite's own default deny list for its own rule", async () => {
    for (const [path, secret] of [
      ['/.env', 'dotenv-value'],
      ['/.env.production', 'dotenv-prod-value'],
      ['/.npmrc', 'npmrc-value'],
      ['/server.pem', 'pem-value'],
      ['/server.key', 'key-file-value'],
      ['/.dev.vars', 'devvars-value'],
    ]) {
      const r = await get(path)
      expect(r.body, `${path} was served`).not.toContain(secret)
    }
  })

  it('keeps the deny rule narrow enough not to break a host app', () => {
    // A blanket **/.local/** would also refuse a host application's own unrelated
    // .local directory. Nothing marver serves lives under design/.local, so the
    // rule names exactly that.
    expect(FS_DENY).toContain('**/design/.local/**')
    expect(FS_DENY).not.toContain('**/.local/**')
  })

  it('refuses a symlink that points into it, wherever the link sits', async () => {
    for (const path of ['/leak.json', '/design/shortcut/collab.json', '/pub-leak.json', '/derived', '/suffixed']) {
      const r = await get(path)
      expect(r.body, `${path} leaked`).not.toContain('PRIVATE-LOCAL-CONTENT')
      expect(r.status, `${path} was served`).not.toBe(200)
    }
  })

  it('refuses the local profile beside it', async () => {
    const r = await get('/design/.local/profile.json')
    expect(r.status).not.toBe(200)
  })

  it('still serves the design files the canvas needs', async () => {
    // The guard has to be narrow. A deny rule that also broke the canvas would be
    // caught in a second by anybody using it - but not by a test that only checks
    // that something, somewhere, was refused. (The shell itself is not asserted
    // here: this scaffold has no node_modules, so React does not resolve.)
    expect((await get('/design/manifest.json')).status).toBe(200)
    expect((await get('/design/config.ts')).status).toBe(200)
    // publicDir is guarded, not disabled.
    expect((await get('/ok.txt')).body).toContain('must still serve')
  })
})

describe('the registry is refused below the request guard too (A1.13 #5)', () => {
  // The request guard answers 403 before Vite sees a request (slots-dev.test.ts asks by every path). These
  // are the layers under it, asked directly: Vite's own fs.deny and Marver's `load`, which every module
  // id passes, however it was spelled - a MARVER_HOME inside the project is in the served root.
  let made = ''
  let inner = ''
  let key = ''
  let vite: Awaited<ReturnType<typeof dev>> | null = null
  const suiteHome = process.env.MARVER_HOME
  beforeAll(async () => {
    const r = made = realpathSync(mkdtempSync(join(tmpdir(), 'mv-devsec-home-')))
    writeFileSync(join(r, 'package.json'), JSON.stringify({ name: 'host', type: 'module', devDependencies: {} }))
    init(r, { mode: 'studio', demo: true })
    inner = join(r, '.mv-home')
    process.env.MARVER_HOME = inner
    vite = await dev(r)
    const slot = readdirSync(join(inner, 'running')).find((f) => /^slot-\d+\.json$/.test(f))!
    key = JSON.parse(readFileSync(join(inner, 'running', slot), 'utf8')).key
    inner = join(inner, 'running', slot.replace(/\.json$/, ''))   // the slot file, without its extension
  }, 120_000)
  afterAll(async () => {
    await vite?.close().catch(() => {})
    if (suiteHome === undefined) delete process.env.MARVER_HOME; else process.env.MARVER_HOME = suiteHome
    rmSync(made, { recursive: true, force: true })
  })

  it("is in Vite's fs.deny, by the path Vite checks", () => {
    expect(vite!.config.server.fs.deny).toEqual(expect.arrayContaining([...FS_DENY, ...registryDeny([join(inner, '..', '..')])]))
    expect(isFileLoadingAllowed(vite!.config, `${inner}.json`)).toBe(false)
  })

  it('no module id inside it loads, with any query', async () => {
    const rel = `/.mv-home/running/${inner.split('/').pop()}`
    for (const url of [`${rel}?import`, rel, `${rel}.json`, `${rel}.json?raw`, `${rel}.json?inline`, `${rel}.json?url`, `/@fs${inner}.json`, `/@fs${inner}?import`, `${inner}.json?raw`]) {
      const out = await vite!.transformRequest(url).then((t) => t?.code ?? '', (e: Error) => `refused: ${e.message}`)
      expect(out, url).not.toContain(key)
      expect(out, url).toMatch(/^refused: /)
    }
  })

  it("Marver's own load refuses it first", async () => {
    await expect(vite!.transformRequest(`/.mv-home/running/${inner.split('/').pop()}?import`)).rejects.toThrow('the canvas registry (~/.marver) is never served')
  })
})

describe('Live Jam agents do not inherit the operator credential', () => {
  it('withholds MARVER_CLI_TOKEN and passes everything else through', () => {
    const env = agentEnv({ PATH: '/usr/bin', HOME: '/home/nic', MARVER_CLI_TOKEN: 'the-operator-secret', ANTHROPIC_API_KEY: 'k' })
    // An agent runs somebody else's instructions. The operator credential opens
    // the PUBLISHED canvas, so handing it over turns a prompt injection in a
    // comment into a takeover of the canvas that comment was written on.
    expect(env.MARVER_CLI_TOKEN).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/nic')
    expect(env.ANTHROPIC_API_KEY).toBe('k')
  })

  it('does not mutate the environment it was handed', () => {
    const from = { MARVER_CLI_TOKEN: 'the-operator-secret' }
    agentEnv(from)
    expect(from.MARVER_CLI_TOKEN).toBe('the-operator-secret')
  })
})
