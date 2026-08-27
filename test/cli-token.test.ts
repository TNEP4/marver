import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { claimInvite, cliTokenProblem, createInvite, issueDeviceSession, MIN_CLI_TOKEN, operatorUser, provisionFromMarverId, sessionUser, signIn } from '../src/server/auth.ts'
import { collabHandler } from '../src/server/collab.ts'
import { collabFileFor, connectToken, loadCollab, saveCollab } from '../src/server/sync.ts'

/** Read a credential file the way the code does, for assertions about the destination. */
const readCollab = (file: string) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

/**
 * The CLI's credential on a canvas that gates on Marver ID.
 *
 * `comments connect` authenticates with a password, and an identity account has
 * none by design - so before this the whole CLI surface (invite, revoke, and the
 * comment sync the agent loop runs on) had no reachable credential on exactly
 * the canvases this release is about.
 *
 * It is an environment variable and not a page for a reason recorded in 2d0850c:
 * authored frames run same-origin, so anything a browser can mint, a frame can
 * mint silently and carry off. These tests hold that line as much as they hold
 * the feature - several of them exist only to prove the credential cannot be had
 * by asking the canvas nicely.
 */

const ISSUER = 'https://id.example.test'
const SECRET = 'a-secret-long-enough-to-be-honoured-01'
let dir = ''

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mv-cli-')) })
afterEach(() => {
  // The credential now lives outside the project, so tidying the temp dir is no
  // longer enough to leave no trace.
  rmSync(collabFileFor(dir), { force: true })
  rmSync(dir, { recursive: true, force: true })
  delete process.env.MARVER_CLI_TOKEN
  // Gate mode is read from the environment, so a test that sets it and dies
  // would otherwise hand the next one a canvas in the wrong mode.
  delete process.env.MARVER_ID_ISSUER
})

/** An owner of the kind that has no password - the one that used to be stuck. */
const identityOwner = (email = 'owner@example.test') => {
  const out = provisionFromMarverId(dir, { email, subject: 'sub-1', issuer: ISSUER }, { ownerEmail: email })
  if (!out) throw new Error('provisioning failed - the test setup is wrong, not the code')
  return out
}
const member = (email = 'member@example.test') => {
  const { token } = createInvite(dir, email)
  return claimInvite(dir, token, { password: 'a-long-enough-password', name: 'Member' })
}

describe('cliTokenProblem - what boot and the matcher both consult', () => {
  it('passes a generated hex secret', () => {
    expect(cliTokenProblem('a'.repeat(48))).toBeNull()
    expect(cliTokenProblem(SECRET)).toBeNull()
  })

  it('treats unset as a choice rather than a mistake', () => {
    expect(cliTokenProblem('')).toBeNull()
  })

  it('refuses surrounding whitespace instead of trimming it', () => {
    // Boot used to trim before checking while `comments connect` sent the shell's
    // value as-is, so a quoted-with-spaces value started a canvas that then
    // refused the operator's own token, with nothing anywhere saying why.
    expect(cliTokenProblem(` ${SECRET} `)).toMatch(/whitespace/)
    expect(cliTokenProblem(`${SECRET}\n`)).toMatch(/whitespace/)
    expect(cliTokenProblem('   ')).toMatch(/whitespace/)
  })

  it('refuses a secret under the floor', () => {
    expect(cliTokenProblem('x'.repeat(MIN_CLI_TOKEN - 1))).toMatch(/too short/)
  })

  it('refuses characters an Authorization header cannot carry', () => {
    expect(cliTokenProblem('abcd+efgh/ijklmnopqrstuvwxyz012345==')).toMatch(/cannot travel/)
  })
})

describe('operatorUser', () => {
  it('refuses a secret the environment holds with whitespace around it', () => {
    identityOwner()
    process.env.MARVER_CLI_TOKEN = ` ${SECRET} `
    // Neither spelling works, which is the point: the canvas refused to boot on
    // this value, so nothing should quietly honour it at request time either.
    expect(operatorUser(dir, SECRET)).toBeNull()
    expect(operatorUser(dir, ` ${SECRET} `)).toBeNull()
  })

  it('resolves to the canvas owner when the secret matches', () => {
    const { user } = identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    expect(operatorUser(dir, SECRET)?.email).toBe(user.email)
  })

  it('is the door for an account that cannot sign in at all', () => {
    const { user } = identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    // The precondition of the whole feature.
    expect(signIn(dir, user.email, 'anything')).toBeNull()
    expect(operatorUser(dir, SECRET)).not.toBeNull()
  })

  it('refuses a secret that does not match', () => {
    identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    expect(operatorUser(dir, `${SECRET}x`)).toBeNull()
    expect(operatorUser(dir, SECRET.slice(0, -1))).toBeNull()
    expect(operatorUser(dir, '')).toBeNull()
  })

  it('is off when the environment says nothing', () => {
    identityOwner()
    // No variable, no credential - an empty secret must never match an empty
    // presented token, which is the shape this kind of bug always takes.
    expect(operatorUser(dir, '')).toBeNull()
    expect(operatorUser(dir, SECRET)).toBeNull()
  })

  it('ignores a secret too short to be worth honouring', () => {
    identityOwner()
    const weak = 'x'.repeat(MIN_CLI_TOKEN - 1)
    process.env.MARVER_CLI_TOKEN = weak
    expect(operatorUser(dir, weak)).toBeNull()
  })

  it('ignores a secret an Authorization header could not carry', () => {
    identityOwner()
    // `openssl rand -base64` emits '+' and '/', and both the gate and the API
    // parse the header with [\w-]+. Honouring such a secret here would mean the
    // canvas booted, accepted the value in one place, and refused it in two.
    const base64ish = 'abcd+efgh/ijklmnopqrstuvwxyz012345=='
    process.env.MARVER_CLI_TOKEN = base64ish
    expect(base64ish.length).toBeGreaterThanOrEqual(MIN_CLI_TOKEN)
    expect(operatorUser(dir, base64ish)).toBeNull()
  })

  it('names nobody on a canvas that has no owner yet', () => {
    process.env.MARVER_CLI_TOKEN = SECRET
    // An empty store: the credential is valid and has nobody to act as, which
    // must read as "no" rather than as some default authority.
    expect(operatorUser(dir, SECRET)).toBeNull()
  })

  it('ends the sessions it minted when the secret rotates', () => {
    identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    const issued = issueDeviceSession(dir, SECRET)!
    expect(sessionUser(dir, issued.token)).not.toBeNull()

    // The operator's only revocation lever. `comments revoke` cannot help here -
    // the store refuses to remove its last owner - so if rotation did not end
    // these, a leaked collab.json would be good for thirty days with no recourse.
    process.env.MARVER_CLI_TOKEN = `${SECRET}-rotated`
    expect(sessionUser(dir, issued.token)).toBeNull()
  })

  it('does not end ordinary sessions when the secret rotates', () => {
    const { session } = identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    issueDeviceSession(dir, SECRET)
    process.env.MARVER_CLI_TOKEN = `${SECRET}-rotated`
    // Rotation is aimed at the credential the operator handed out, not at the
    // people signed in to the canvas in their browsers.
    expect(sessionUser(dir, session)).not.toBeNull()
  })

  it('acts as the owner by ROLE, not by whoever sits first in the store', () => {
    const { user } = identityOwner()
    member('member@example.test')
    // Put the member first, so that "the owner" and "users[0]" disagree. Without
    // this the test passes against a lookup that just takes the first record -
    // which is a different thing that happens to be right in the easy case.
    const file = join(dir, 'auth.json')
    const store = JSON.parse(readFileSync(file, 'utf8'))
    store.users.reverse()
    expect(store.users[0].role).toBe('member')
    writeFileSync(file, JSON.stringify(store))

    process.env.MARVER_CLI_TOKEN = SECRET
    expect(operatorUser(dir, SECRET)?.email).toBe(user.email)
    expect(operatorUser(dir, SECRET)?.role).toBe('owner')
  })
})

/** Drive collabHandler the way boards.test.ts drives apiMiddleware. */
function drive(method: string, path: string, headers: Record<string, string> = {}, body: unknown = {}) {
  const handler = collabHandler(dir, join(dir, 'dist'))
  const req: any = {
    method, url: `/__mv/api/${path}`,
    // JSON declared explicitly: the reader refuses anything else, because a
    // cross-site form can post text/plain but cannot forge this header.
    headers: { host: 'localhost:4199', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    _cbs: {} as Record<string, (arg?: unknown) => void>,
    _pending: method === 'POST' ? Buffer.from(JSON.stringify(body)) : undefined,
    // Deliver the body once the handler has subscribed to BOTH events. Firing it
    // on a bare queueMicrotask raced the handler's own awaits and delivered to
    // nobody, which surfaced as a 400 that looked like a validation bug.
    on(ev: string, cb: (arg?: unknown) => void) {
      this._cbs[ev] = cb
      if (ev === 'end' && this._pending !== undefined) {
        const raw = this._pending
        this._pending = undefined
        queueMicrotask(() => { this._cbs.data?.(raw); this._cbs.end?.() })
      }
      return this
    },
    destroy() { /* body-limit path - unused here */ },
  }
  const res: any = {
    statusCode: 0, headers: {} as Record<string, string>, body: '',
    setHeader(k: string, v: string) { this.headers[k] = v }, end(s?: string) { this.body = s ?? ''; this._done?.() },
  }
  const done = new Promise<{ status: number; json: any; handled: boolean }>((resolve) => {
    res._done = () => resolve({ status: res.statusCode, json: safeParse(res.body), handled: true })
    void handler(req, res, new URL(`http://localhost:4199/__mv/api/${path}`))
      .then((handled) => { if (!handled) resolve({ status: 404, json: null, handled: false }) })
  })
  return done
}
const safeParse = (s: string) => { try { return JSON.parse(s) } catch { return null } }

describe('the operator credential through the API', () => {
  const csrf = { cookie: 'mv_c=tok', 'x-mv-c': 'tok' }

  it('trades itself for a session, which is all it can do', async () => {
    const { user } = identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    const r = await drive('POST', 'cli-session', { authorization: `Bearer ${SECRET}` })
    expect(r.status).toBe(200)
    expect(r.json.user.email).toBe(user.email)
    expect(sessionUser(dir, r.json.token)?.email).toBe(user.email)
  })

  it('is NOT a session itself - it can do nothing else', async () => {
    identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    // The narrowing that matters: the secret opens one door, and every other
    // route resolves its caller with sessionUser alone. A leaked secret is still
    // bad, but it is bad in exactly one place rather than everywhere.
    expect((await drive('GET', 'me', { authorization: `Bearer ${SECRET}` })).status).toBe(401)
    // 403 rather than 401: the invite route answers "owner only" to a caller it
    // cannot identify, which is the pre-existing shape and not worth changing.
    const invite = await drive('POST', 'invite', { authorization: `Bearer ${SECRET}` }, { email: 'guest@example.test' })
    expect(invite.status).toBe(403)
  })

  it('the session it issues can do the work identity mode could not', async () => {
    identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    const { json: issued } = await drive('POST', 'cli-session', { authorization: `Bearer ${SECRET}` })
    const r = await drive('POST', 'invite', { authorization: `Bearer ${issued.token}` }, { email: 'guest@example.test' })
    expect(r.status).toBe(200)
    expect(typeof r.json.token).toBe('string')
  })

  /**
   * The invite response says which gate it was issued behind.
   *
   * Only the server knows - the CLI cannot see the canvas's environment - and
   * the instructions it prints are opposite in the two modes. On the pilot the
   * CLI told the operator to forward a claim link "plus the canvas password" on
   * a canvas that has no password and where serve.ts keeps `auth/claim` behind
   * `!idIssuer`, so the link is bolted shut on purpose.
   */
  it('tells the CLI which gate the invite was issued behind', async () => {
    identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    const { json: issued } = await drive('POST', 'cli-session', { authorization: `Bearer ${SECRET}` })
    const auth = { authorization: `Bearer ${issued.token}` }

    process.env.MARVER_ID_ISSUER = ISSUER
    const id = await drive('POST', 'invite', auth, { email: 'id-guest@example.test' })
    expect(id.json.idMode).toBe(true)

    delete process.env.MARVER_ID_ISSUER
    const pw = await drive('POST', 'invite', auth, { email: 'pw-guest@example.test' })
    expect(pw.json.idMode).toBe(false)
    // The token still travels in both: identity mode makes the link inert, not
    // absent, and revoking still has to be able to reason about the invite.
    expect(typeof pw.json.token).toBe('string')
    expect(typeof id.json.token).toBe('string')
  })

  it('refuses when the environment holds no secret', async () => {
    identityOwner()
    const r = await drive('POST', 'cli-session', { authorization: `Bearer ${SECRET}` })
    expect(r.status).toBe(401)
  })

  it('refuses on a canvas nobody owns yet, and mints nothing', async () => {
    process.env.MARVER_CLI_TOKEN = SECRET
    const r = await drive('POST', 'cli-session', { authorization: `Bearer ${SECRET}` })
    expect(r.status).toBe(401)
    expect(issueDeviceSession(dir, SECRET)).toBeNull()
  })

  it('cannot be presented as a cookie, which is the position a frame can reach', async () => {
    identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    // Read from Authorization ONLY. A cookie is sent automatically by the browser,
    // and this is the one route where being reachable by ambient credentials would
    // matter - so the route simply does not look there.
    const r = await drive('POST', 'cli-session', { cookie: `mv_s=${SECRET}; mv_c=tok`, 'x-mv-c': 'tok' })
    expect(r.status).toBe(401)
  })

  it('cannot be minted by a signed-in session - only by the secret', async () => {
    const { session } = identityOwner()
    process.env.MARVER_CLI_TOKEN = SECRET
    // The whole reason this is not a page. A frame rides the viewer's session; if
    // a session could mint a device credential, a frame could mint one silently
    // and carry it off - which is why 2d0850c pulled the device flow.
    const r = await drive('POST', 'cli-session', { authorization: `Bearer ${session}` })
    expect(r.status).toBe(401)
  })
})

describe('comments connect --token', () => {
  let server: Server | null = null
  let base = ''
  let seen: { auth: string; method: string; url: string } | null = null
  const listen = (handler: Parameters<typeof createServer>[1]) => new Promise<void>((done) => {
    server = createServer((req, res) => {
      seen = { auth: String(req.headers.authorization ?? ''), method: req.method ?? '', url: req.url ?? '' }
      handler!(req, res)
    })
    server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server!.address() as any).port}`; done() })
  })
  /** A canvas that speaks the exchange: hands back a session, never the secret. */
  const exchanging = (session = 'issued-session-token') => listen((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ token: session, exp: Date.now() + 1000, user: { email: 'owner@example.test', name: 'Owner' } }))
  })
  afterEach(() => { server?.close(); server = null; seen = null })

  it('trades the secret for a session and persists only the session', async () => {
    await exchanging('a-fresh-session')
    await connectToken(dir, base, SECRET)
    expect(seen!.method).toBe('POST')
    expect(seen!.url).toBe('/__mv/api/cli-session')
    expect(seen!.auth).toBe(`Bearer ${SECRET}`)
    const saved = loadCollab(dir)
    // The load-bearing assertion of this whole round: the operator's secret must
    // not be what ends up in a file that lives in a repo for years.
    expect(saved?.token).toBe('a-fresh-session')
    expect(saved?.token).not.toBe(SECRET)
    expect(saved?.email).toBe('owner@example.test')
    expect(saved?.url).toBe(base)
  })

  it('keeps the credential OUT of the repository', async () => {
    await exchanging('a-fresh-session')
    await connectToken(dir, base, SECRET)
    // The reason this moved: `marver dev` serves the repository, and two rounds
    // of path guards each closed one way to read a file inside it and were each
    // followed by another. Nothing serves the home directory.
    expect(existsSync(join(dir, 'design', '.local', 'collab.json'))).toBe(false)
    expect(collabFileFor(dir).startsWith(dir)).toBe(false)
    expect(readFileSync(collabFileFor(dir), 'utf8')).toContain('a-fresh-session')
  })

  it('moves a credential an older marver left in the repository', () => {
    const legacy = join(dir, 'design', '.local', 'collab.json')
    mkdirSync(join(dir, 'design', '.local'), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ url: 'https://old.test', token: 'legacy-session' }))

    // Read it, so nobody is signed out by an upgrade...
    expect(loadCollab(dir)?.token).toBe('legacy-session')
    // ...and do not leave it there, because that is the exposure being fixed.
    expect(existsSync(legacy)).toBe(false)
    expect(loadCollab(dir)?.token).toBe('legacy-session')
  })

  it('moves a credential an older marver left in the repository', () => {
    // NOTE: this asserts the move, not the mechanism. It cannot prove the EXDEV
    // case - $HOME and the temp dir are on one filesystem here, so a rename would
    // pass too. The copy is deliberate anyway: those two paths are routinely on
    // different filesystems in the field, and renameSync answers EXDEV there.
    const legacy = join(dir, 'design', '.local', 'collab.json')
    mkdirSync(join(dir, 'design', '.local'), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ url: 'https://old.test', token: 'legacy-session' }))
    expect(loadCollab(dir)?.token).toBe('legacy-session')
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(collabFileFor(dir), 'utf8')).toContain('legacy-session')
  })

  it('keeps the legacy copy when what is at the destination is not usable', () => {
    // "The destination exists" is not the same as "the move happened". A
    // truncated or half-written file there would turn the tidy-up into a lockout,
    // so the only credential is kept until a real one is proven to be in place.
    mkdirSync(dirname(collabFileFor(dir)), { recursive: true })
    writeFileSync(collabFileFor(dir), '{ this is not json')
    const legacy = join(dir, 'design', '.local', 'collab.json')
    mkdirSync(join(dir, 'design', '.local'), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ url: 'https://old.test', token: 'the-only-copy' }))

    // The credential survives and the junk is replaced. What must NOT happen is
    // the early return that treats a corrupt destination as proof the move
    // already happened - that deletes the only usable copy.
    expect(loadCollab(dir)?.token).toBe('the-only-copy')
    expect(readCollab(collabFileFor(dir))?.token).toBe('the-only-copy')
    expect(existsSync(legacy)).toBe(false)
  })

  it('clears a leftover legacy copy when the real one already exists', () => {
    saveCollab(dir, { url: 'https://new.test', token: 'current-session' })
    const legacy = join(dir, 'design', '.local', 'collab.json')
    mkdirSync(join(dir, 'design', '.local'), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ url: 'https://old.test', token: 'stale-session' }))

    // The current credential wins, and the stale one does not get to sit in a
    // served directory just because the move already happened once.
    expect(loadCollab(dir)?.token).toBe('current-session')
    expect(existsSync(legacy)).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('keeps the old credential when the new one cannot be written', () => {
    // The ordering guarantee, tested against a home directory that genuinely
    // refuses writes. Deleting the legacy copy first would turn "your home is
    // read-only" into "your only credential is gone" - so the write has to prove
    // itself before anything is tidied away.
    const legacy = join(dir, 'design', '.local', 'collab.json')
    mkdirSync(join(dir, 'design', '.local'), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ url: 'https://old.test', token: 'the-only-copy' }))

    const home = mkdtempSync(join(tmpdir(), 'mv-home-'))
    const realHome = process.env.HOME
    process.env.HOME = home
    try {
      // The PARENT is locked, so creating the canvases directory fails - a
      // failure saveCollab cannot undo by chmodding its own directory back open.
      mkdirSync(join(home, '.marver'), { recursive: true })
      chmodSync(join(home, '.marver'), 0o500)
      expect(() => saveCollab(dir, { url: 'https://new.test', token: 'replacement' })).toThrow()
      expect(existsSync(legacy)).toBe(true)
      expect(JSON.parse(readFileSync(legacy, 'utf8')).token).toBe('the-only-copy')
    } finally {
      chmodSync(join(home, '.marver'), 0o700)
      rmSync(home, { recursive: true, force: true })
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome
    }
  })

  it('writes the credential readable only by its owner, even over an existing file', async () => {
    // A collab.json that arrived world-readable - from an older marver, or a
    // checkout - must not stay that way: writeFileSync's mode only applies on
    // create, which is exactly the case a test has to pin.
    saveCollab(dir, { url: 'http://old.test', token: 'old' })
    chmodSync(collabFileFor(dir), 0o644)
    await exchanging()
    await connectToken(dir, base, SECRET)
    expect(statSync(collabFileFor(dir)).mode & 0o777).toBe(0o600)
  })

  it('names every likely cause when the canvas refuses, and writes nothing', async () => {
    await listen((_req, res) => { res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end('{"error":"no"}') })
    await expect(connectToken(dir, base, SECRET)).rejects.toThrow(/would not accept that token/)
    await expect(connectToken(dir, base, SECRET)).rejects.toThrow(/owner has signed in|has the owner signed in/i)
    expect(loadCollab(dir)).toBeNull()
  })

  it('reads a gate page as a refused token, not as a broken canvas', async () => {
    // The gate answers HTML to a caller it does not recognise, and a wrong secret
    // never becomes one - so HTML here is the ordinary mistyped-secret case.
    // Reporting "is collaboration enabled?" sent people to check the wrong thing.
    await listen((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><html></html>') })
    await expect(connectToken(dir, base, SECRET)).rejects.toThrow(/would not accept that token/)
    expect(loadCollab(dir)).toBeNull()
  })

  it('says so plainly when the canvas is too old to have the route', async () => {
    await listen((_req, res) => { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end('{}') })
    await expect(connectToken(dir, base, SECRET)).rejects.toThrow(/older than 0\.11\.0/)
    expect(loadCollab(dir)).toBeNull()
  })

  it('refuses a token below the floor the canvas enforces, before asking', async () => {
    let hits = 0
    await listen((_req, res) => { hits++; res.end('{}') })
    await expect(connectToken(dir, base, 'x'.repeat(MIN_CLI_TOKEN - 1))).rejects.toThrow(/will not honour anything under/)
    expect(hits).toBe(0)
  })

  it('names an older canvas among the causes when it answers with its gate', async () => {
    // An identity-gated canvas older than 0.11.0 has no such route, so its gate
    // answers HTML with a 200 - indistinguishable from a mistyped secret. The
    // message has to carry both rather than confidently picking one.
    await listen((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<html></html>') })
    await expect(connectToken(dir, base, SECRET)).rejects.toThrow(/0\.11\.0 or newer/)
  })

  it('refuses base64 punctuation before making a request, and says what to run', async () => {
    let hits = 0
    await listen((_req, res) => { hits++; res.end('{}') })
    // The exact failure codex found: `openssl rand -base64 24` output is rejected
    // by the [\w-]+ header parsers, so it must never leave the CLI unremarked.
    await expect(connectToken(dir, base, 'abcd+efgh/ijklmnopqrstuvwxyz012345==')).rejects.toThrow(/openssl rand -hex 24/)
    await expect(connectToken(dir, base, 'has a space in it here padding padding')).rejects.toThrow(/Authorization header cannot carry/)
    await expect(connectToken(dir, base, '   ')).rejects.toThrow(/empty/)
    expect(hits).toBe(0)
  })

  it('trims a trailing slash off the canvas url', async () => {
    await exchanging()
    await connectToken(dir, `${base}/`, SECRET)
    expect(loadCollab(dir)?.url).toBe(base)
  })
})
