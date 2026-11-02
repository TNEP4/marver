/**
 * scripts/release.mjs end to end against fakes (spec 28 A5.1 #33): a fake GitHub (drafts, publishing, the repository's
 * immutability, immutability after a publish, prereleases, tags, asset digests, anonymous and authenticated reads, the
 * `latest` redirect's lag) and a fake notary (In Progress, Accepted, Invalid, a timeout, a history), with the real lock,
 * git, ditto and hdiutil on a small bundle (test/harness/release-world.ts). Every phase, every resume point and every
 * operator command; nothing reaches Apple or GitHub, and no window opens (DMGs mount with -nobrowse).
 *
 * A world is prepared once per block and restored, at the same path, before each case (`snap`/`restore`).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { REPOS, T, assetNames, takeLock } from '../../scripts/release.mjs'
import { Crash, gitIn, makeWorld, said, type Snap, type World } from '../harness/release-world.ts'

const P = REPOS.production
const TR = REPOS.test
const PROD_FEED = 'https://github.com/TNEP4/marver-app/releases/latest/download/releases.json'
const MIN = 60_000
const HOUR = 3600_000
const V = '1.0.0'
const N = assetNames(V)

const draftOf = (w: World, v = V, repo = P) => w.gh.find(repo, v)[0]!
const stateDir = (w: World, v = V, app = w.app) => join(app, '.release', v)
const ok = async (w: World, argv: string[], o?: { app?: string }) => { const r = await w.run(argv, o); expect(r.code, said(w)).toBe(0); return r }
const stops = async (w: World, argv: string[], match: RegExp, o?: { app?: string }) => {
  const r = await w.run(argv, o)
  expect(r.code, said(w)).toBe(1)
  expect(r.stop).toMatch(match)
  return r
}
const accept = (w: World, v = V) => ok(w, [v, `--accept=${w.evidence(v)}`])
/** Nic commits the record (#11 step 14) before the next release, whose preflight wants a clean tree */
const commitRecord = (w: World, v = V) => {
  gitIn(w.repo, ['add', join('app', 'releases', `${v}.json`)])
  gitIn(w.repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `release: app ${v}`])
  gitIn(w.repo, ['push', '-q'])
}
/** the shared record as a crash left it, written by hand */
const writeShared = (w: World, rec: unknown) => writeFileSync(join(w.home, `${P.replace('/', '-')}.json`), JSON.stringify(rec, null, 2))

describe('release.mjs (A5.1 #11, #33)', { timeout: 300_000 }, () => {
  let w: World
  let fresh: Snap, ready: Snap, accepted: Snap
  beforeAll(async () => {
    w = makeWorld(V)
    fresh = w.snap()
    await ok(w, [V])
    ready = w.snap()
    await accept(w)
    accepted = w.snap()
  }, 300_000)
  afterAll(() => w.cleanup())

  describe('the whole order', () => {
    beforeEach(() => w.restore(fresh))

    it('prepares to awaiting-acceptance, accepts the draft\'s bytes, publishes once, checks public and records', async () => {
      await ok(w, [V])
      const s = w.state(V)
      for (const step of ['preflight', 'freeze', 'build', 'app-hashed', 'app-zipped', 'notarize-app', 'staple-app', 'zip', 'dmg-built', 'dmg-signed', 'dmg-accepted', 'dmg-stapled', 'dmg', 'verify', 'feed', 'draft', 'upload', 'check-draft']) {
        expect(s.steps[step], step).toBeTruthy()
      }
      expect(s.steps.publish).toBeUndefined()
      expect(s.source.sha).toBe(gitIn(w.repo, ['rev-parse', 'HEAD']))
      expect(said(w)).toMatch(/awaiting-acceptance/)
      expect(said(w)).toContain(s.files[N.dmg].sha256)
      // the build: never ad-hoc, never without the smoke, never a known failure, the production feed, into the state
      expect(w.builds).toEqual([{ adhoc: false, smoke: true, tamper: false, knownFail: [], feed: PROD_FEED, into: stateDir(w) }])
      // one private draft with the three assets, its tag to be made on the releases repo's main
      const d = draftOf(w)
      expect(d).toMatchObject({ draft: true, name: `Marver ${V}`, target_commitish: s.release.tagTarget })
      expect(d.body).toContain(s.steps.freeze.notes.text)
      expect(d.body).toContain(s.source.sha)
      expect(d.assets.map((a) => a.name).sort()).toEqual([N.dmg, N.zip, N.feed].sort())
      expect(w.notary.submits()).toEqual([expect.stringMatching(/^submit Marver-1\.0\.0-app-[0-9a-f]{12}\.zip$/), expect.stringMatching(/^submit Marver-1\.0\.0-dmg-[0-9a-f]{12}\.dmg$/)])
      expect(w.shared()).toMatchObject({ owner: { version: V, state: stateDir(w) }, pending: null, watch: [] })
      // the feed's exact bytes (#9)
      const feed = readFileSync(join(stateDir(w), N.feed), 'utf8')
      expect(feed).toBe(`${JSON.stringify({ currentRelease: V, releases: [{ version: V, updateTo: { version: V, pub_date: new Date(s.steps.freeze.at).toISOString(),
        notes: '- **Updates arrive by themselves.** Needs a canvas on marver 0.29.0.', name: V, url: 'https://github.com/TNEP4/marver-app/releases/download/v1.0.0/Marver-darwin-arm64-1.0.0.zip' } }] }, null, 2)}\n`)

      await accept(w)
      expect(w.state(V).accepted).toMatchObject({ by: 'Release Test', zip: s.files[N.zip].sha256, dmg: s.files[N.dmg].sha256 })
      await ok(w, [V, '--publish'])
      expect(w.gh.publishCalls()).toHaveLength(1)
      expect(draftOf(w)).toMatchObject({ draft: false, prerelease: false, immutable: true })
      const rec = w.record(V)
      expect(rec).toMatchObject({ v: 1, version: V, status: 'published', kind: 'production', repo: P, tag: 'v1.0.0', companion: '0.29.0', immutable: true,
        tagTarget: s.release.tagTarget, source: s.source, acceptance: { by: 'Release Test' }, smokeReport: 'smoke-1.json', dr: s.steps.freeze.dr })
      expect(rec.assets).toEqual([N.zip, N.dmg, N.feed].map((name) => ({ name, bytes: s.files[name].bytes, sha256: s.files[name].sha256 })))
      expect(rec.notary).toEqual(s.notary)
      expect(rec.check.latest).toMatchObject({ owner: V, agreeing: T.latestAgree })
      expect(w.shared()).toEqual({ v: 1, owner: null, pending: null, watch: [] })
      expect(w.state(V).steps.final.status).toBe('published')
      // run again: nothing to do, nothing sent
      await ok(w, [V, '--resume'])
      expect(said(w)).toMatch(/ended published/)
      expect(w.gh.publishCalls()).toHaveLength(1)
    })
  })

  describe('interrupted between a side effect and its record (r1 #4; r2 #3)', () => {
    beforeEach(() => w.restore(fresh))

    it('a submission Apple kept, its id lost: the next run finds it in history and submits nothing', async () => {
      w.notary.crashAfterSubmit = 1
      await expect(w.run([V])).rejects.toThrow(Crash)
      expect(w.state(V).pending).toMatchObject({ what: 'notary-submit', kind: 'app' })
      expect(w.state(V).notary.app).toEqual([])
      await ok(w, [V])
      expect(w.notary.submits().filter((c) => c.includes('-app-'))).toHaveLength(1)
      expect(w.state(V).notary.app).toEqual([w.notary.subs[0]!.id])
      expect(said(w)).toMatch(/found in history/)
    })

    it('two submissions found: duplicate, both recorded, the first Accepted taken', async () => {
      w.notary.crashAfterSubmit = 1
      w.notary.plan.app = ['Invalid']
      await expect(w.run([V])).rejects.toThrow(Crash)
      // the same bytes submitted again by a run that died too (S1: history lists both under one name)
      w.clock.advance(MIN)
      w.notary.subs.push({ id: 'second-submission', name: w.notary.subs[0]!.name, createdDate: new Date(w.clock.now()).toISOString(), status: 'Accepted' })
      await ok(w, [V])
      const s = w.state(V)
      expect(s.notary.app).toEqual([w.notary.subs[0]!.id, 'second-submission'])
      expect(s.steps['notarize-app'].id).toBe('second-submission')
      expect(said(w)).toMatch(/duplicate/)
      expect(w.notary.submits().filter((c) => c.includes('-app-'))).toHaveLength(1)
      expect(existsSync(join(stateDir(w), `logs/notary-${w.notary.subs[0]!.id}.json`))).toBe(true)
    })

    it('the DMG signed, unrecorded: the clone deleted and signed again, before its submission only', async () => {
      w.tools.crashAfter.add('sign-dmg')
      await expect(w.run([V])).rejects.toThrow(Crash)
      expect(w.state(V).pending).toMatchObject({ what: 'sign', output: 'Marver-signed.dmg' })
      expect(w.notary.submits().filter((c) => c.includes('-dmg-'))).toHaveLength(0)
      await ok(w, [V])
      expect(w.tools.calls.filter((c) => c === 'sign Marver-signed.dmg')).toHaveLength(2)
      expect(w.notary.submits()).toHaveLength(2)
      expect(w.builds).toHaveLength(1)
    })

    it('the app stapled, unrecorded: the copy deleted and stapled again from the unchanged built app - no rebuild, no submission', async () => {
      w.tools.crashAfter.add('staple-app')
      await expect(w.run([V])).rejects.toThrow(Crash)
      expect(w.state(V).pending).toMatchObject({ what: 'staple', input: 'Marver.app', output: 'stapled/Marver.app' })
      await ok(w, [V])
      expect(w.tools.calls.filter((c) => c === 'staple Marver.app')).toHaveLength(2)
      expect(w.builds).toHaveLength(1)
      expect(w.notary.submits().filter((c) => c.includes('-app-'))).toHaveLength(1)
    })

    it('the DMG stapled, unrecorded: the clone deleted and stapled again - no new submission', async () => {
      w.tools.crashAfter.add('staple-dmg')
      await expect(w.run([V])).rejects.toThrow(Crash)
      expect(w.state(V).pending).toMatchObject({ what: 'staple', input: 'Marver-signed.dmg', output: N.dmg })
      await ok(w, [V])
      expect(w.tools.calls.filter((c) => c === `staple ${N.dmg}`)).toHaveLength(2)
      expect(w.notary.submits()).toHaveLength(2)
      expect(w.builds).toHaveLength(1)
    })

    it('the draft made, unrecorded: adopted, never a second', async () => {
      w.gh.crashAfter.add('createDraft')
      await expect(w.run([V])).rejects.toThrow(Crash)
      expect(w.state(V).release).toBeUndefined()
      await ok(w, [V])
      expect(w.gh.calls.filter((c) => c === 'createDraft')).toHaveLength(1)
      expect(w.gh.find(P, V)).toHaveLength(1)
      expect(said(w)).toMatch(/adopted/)
    })

    it('an asset uploaded, unrecorded: reconciled by its digest, never uploaded twice', async () => {
      w.gh.crashAfter.add('uploadAsset')
      await expect(w.run([V])).rejects.toThrow(Crash)
      await ok(w, [V])
      const uploads = w.gh.calls.filter((c) => c.startsWith('uploadAsset'))
      expect(uploads).toHaveLength(3)
      expect(new Set(uploads).size).toBe(3)
      expect(draftOf(w).assets).toHaveLength(3)
    })
  })

  describe('from awaiting-acceptance', () => {
    beforeEach(() => w.restore(ready))

    it('a second run while one holds the repository\'s lock stops at once, touching nothing', async () => {
      const lock = takeLock(join(w.home, `${P.replace('/', '-')}.lock`))
      try {
        await stops(w, [V, '--resume'], /another release run holds/)
        expect(w.gh.calls).toEqual([])
      } finally { lock.release() }
    })

    it('before the publish, another HEAD, an unclean tree or a recorded file changed stops the run', async () => {
      writeFileSync(join(w.repo, 'notes.txt'), 'x\n')
      await stops(w, [V, '--resume'], /tree is not clean/)
      gitIn(w.repo, ['add', 'notes.txt'])
      gitIn(w.repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'later'])
      await stops(w, [V, '--resume'], /HEAD is [0-9a-f]{12}, and this release froze/)
      await stops(w, [V, '--publish'], /HEAD is/)
      gitIn(w.repo, ['reset', '-q', '--hard', 'HEAD~1'])
      writeFileSync(join(stateDir(w), N.feed), '{}\n')
      await stops(w, [V, '--resume'], /releases\.json changed/)
      expect(w.gh.publishCalls()).toEqual([])
    })

    it('a draft holding a wrong asset is repaired, an extra one deleted, with the same bytes - the acceptance still holds', async () => {
      const d = w.gh.repo(P).releases.find((r) => r.tag_name === `v${V}`)!
      const feed = d.assets.find((a) => a.name === N.feed)!
      feed.bytes = Buffer.from('{"tampered":true}\n')
      feed.digest = `sha256:${'0'.repeat(64)}`
      d.assets.push({ ...feed, id: 99999, name: 'notes.txt' })
      await ok(w, [V, '--resume'])
      expect(said(w)).toMatch(/repairing/)
      const s = w.state(V)
      expect(draftOf(w).assets.map((a) => [a.name, a.digest]).sort()).toEqual([N.dmg, N.feed, N.zip].sort().map((n) => [n, `sha256:${s.files[n].sha256}`]))
      expect(w.gh.calls.filter((c) => c.startsWith('deleteAsset'))).toHaveLength(2)
      await accept(w)
      await ok(w, [V, '--publish'])
      expect(w.record(V).status).toBe('published')
    })

    it('--abandon before the publish: the order ends with the folder; nothing deleted on GitHub; the next version starts', async () => {
      await ok(w, [V, '--abandon'])
      expect(existsSync(stateDir(w))).toBe(false)
      expect(w.shared()).toMatchObject({ owner: null, pending: null })
      expect(draftOf(w).draft).toBe(true)
      expect(said(w)).toMatch(/nothing deleted on GitHub/)
      w.bump('1.0.1')
      await ok(w, ['1.0.1'])
      expect(w.state('1.0.1').steps['check-draft']).toBeTruthy()
    })

    it('--abandon is refused once GitHub shows the release published, whatever the local state', async () => {
      w.gh.applyPublish(P, draftOf(w).id)
      await stops(w, [V, '--abandon'], /published on GitHub: --abandon is refused/)
      expect(existsSync(stateDir(w))).toBe(true)
    })

    it('one release per repository: another worktree, same version or another, stops at once naming the owning folder', async () => {
      const other = w.worktree('wt2')
      const before = w.gh.calls.length
      await stops(w, [V], new RegExp(`owned by ${V.replace(/\./g, '\\.')}'s release in ${stateDir(w).replace(/[.]/g, '\\.')}`), { app: other })
      await stops(w, ['1.0.1'], /owned by 1\.0\.0's release/, { app: other })
      expect(w.gh.calls.slice(before).filter((c) => !['releases', 'release'].includes(c))).toEqual([])
      expect(w.gh.find(P, V)).toHaveLength(1)
    })

    it('a production --publish without an acceptance is refused', async () => {
      await stops(w, [V, '--publish'], /no acceptance/)
      expect(w.gh.publishCalls()).toEqual([])
    })

    it('an acceptance naming other bytes, or with a required check missing or failed, is refused - matching hashes alone admit nothing', async () => {
      await stops(w, [V, `--accept=${w.evidence(V, { dmg: 'ab'.repeat(32) })}`], /dmg: (ab)+ is not the state's/)
      const s = w.state(V)
      const pass = JSON.parse(readFileSync(w.evidence(V), 'utf8')).checks
      await stops(w, [V, `--accept=${w.evidence(V, { checks: { ...pass, 'live-picture': 'fail' } })}`], /live-picture is fail/)
      const { 'install-matrix': _, ...missing } = pass
      await stops(w, [V, `--accept=${w.evidence(V, { checks: missing })}`], /install-matrix is missing/)
      await stops(w, [V, `--accept=${w.evidence(V, { google: 'maybe' })}`], /google/)
      expect(w.state(V).accepted).toBeUndefined()
      expect(s.files[N.dmg]).toBeTruthy()
    })

    it('immutability turned off between preflight and the publish: the publish is never attempted', async () => {
      await accept(w)
      w.gh.repo(P).immutable = false
      await stops(w, [V, '--publish'], /immutability is off/)
      expect(w.gh.publishCalls()).toEqual([])
      expect(w.shared().pending).toBeNull()
    })

    it('a release shipped meanwhile above this one: the floor, read again, refuses the publish (r2 #7)', async () => {
      await accept(w)
      w.gh.publishNew(P, '1.0.1')
      await stops(w, [V, '--publish'], /not above the version floor 1\.0\.1/)
      expect(w.gh.publishCalls()).toEqual([])
    })
  })

  describe('after the publish', () => {
    beforeEach(() => w.restore(accepted))

    it('the publish lands and the run dies before its record: the next run finds it published and goes to check-public, never publishing twice', async () => {
      w.gh.crashAfter.add('publish')
      await expect(w.run([V, '--publish'])).rejects.toThrow(Crash)
      expect(w.state(V).pending).toMatchObject({ what: 'publish' })
      expect(w.shared().pending).toMatchObject({ version: V })
      await ok(w, [V, '--publish'])
      expect(w.gh.publishCalls()).toHaveLength(1)
      expect(w.record(V).status).toBe('published')
      expect(w.shared()).toMatchObject({ owner: null, pending: null })
    })

    it('check-public timing out records check-failed; resumed in any checkout state, it records again and builds, signs and uploads nothing', async () => {
      w.gh.latestLagMs = 100 * HOUR
      await stops(w, [V, '--publish'], /check-failed/)
      expect(w.record(V).status).toBe('check-failed')
      expect(w.shared().owner).toMatchObject({ version: V })
      expect(gitIn(w.repo, ['status', '--porcelain'])).toMatch(/app\/releases\//)
      // the record uncommitted: the tree is unclean, and it never stops check-public
      await stops(w, [V, '--resume'], /check-failed/)
      // committed: HEAD moved
      gitIn(w.repo, ['add', '-A'])
      gitIn(w.repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'release: app 1.0.0 (check-failed)'])
      w.gh.latestLagMs = 70_000
      await ok(w, [V, '--resume'])
      expect(w.record(V).status).toBe('published')
      expect(w.builds).toEqual([])
      expect(w.tools.calls).toEqual([])
      expect(w.gh.calls.filter((c) => /^(uploadAsset|createDraft|deleteAsset)/.test(c))).toEqual([])
      expect(w.gh.publishCalls()).toHaveLength(1)
    })

    it('superseded: a newer release owns latest during check-public - the artifacts checked, never claimed published', async () => {
      w.gh.after.tagCommit = () => { delete w.gh.after.tagCommit; w.gh.publishNew(P, '1.0.1') }
      await ok(w, [V, '--publish'])
      expect(w.record(V)).toMatchObject({ status: 'superseded', check: { latest: { owner: '1.0.1' }, problems: [] } })
      expect(w.shared().owner).toBeNull()
    })

    it('superseded on a later resume, after a check-public that timed out', async () => {
      w.gh.latestLagMs = 100 * HOUR
      await stops(w, [V, '--publish'], /check-failed/)
      w.gh.publishNew(P, '1.0.1')
      w.gh.latestLagMs = 70_000
      await ok(w, [V, '--resume'])
      expect(w.record(V).status).toBe('superseded')
    })

    it('published, but reading immutable: false: withdrawn at once, its record written as withdrawn, the step failing', async () => {
      w.gh.after.immutable = () => { delete w.gh.after.immutable; w.gh.repo(P).immutable = false }
      await stops(w, [V, '--publish'], /published mutable: it is withdrawn/)
      expect(draftOf(w)).toMatchObject({ draft: false, prerelease: true, immutable: false })
      expect(w.record(V)).toMatchObject({ status: 'withdrawn', reason: expect.stringMatching(/immutable: false/), immutable: false })
      expect(w.shared()).toMatchObject({ owner: null })
      expect(w.state(V).steps.final.status).toBe('withdrawn')
    })

    it('an artifact check that keeps failing: --withdraw ends it, interrupted and run again; the version stays the floor and the next one ships', async () => {
      w.gh.after.release = () => { if (w.gh.repo(P).tags.has('v1.0.0')) w.gh.repo(P).tags.set('v1.0.0', 'b'.repeat(40)) }
      await stops(w, [V, '--publish'], /check-failed/)
      await stops(w, [V, '--resume'], /the tag v1\.0\.0 is on b+/)
      w.gh.after = {}
      w.gh.crashAfter.add('markPrerelease')
      await expect(w.run([V, '--withdraw'])).rejects.toThrow(Crash)
      expect(w.state(V).pending).toMatchObject({ what: 'withdraw' })
      // a resume in its place never checks public meanwhile (it would write check-failed over the withdrawal)
      await stops(w, [V, '--resume'], /a withdrawal of v1\.0\.0 is under way: .*--withdraw finishes it/)
      await ok(w, [V, '--withdraw'])
      expect(w.gh.calls.filter((c) => c.startsWith('markPrerelease'))).toHaveLength(1)
      expect(w.record(V)).toMatchObject({ status: 'withdrawn', reason: expect.stringMatching(/the tag v1\.0\.0 is on b+/) })
      expect(w.shared()).toMatchObject({ owner: null, watch: [] })
      // the record written and the run cut before its final: run again, it picks up
      const sh = w.shared()
      writeShared(w, { ...sh, owner: { version: V, state: stateDir(w), at: 1 } })
      const st = w.state(V)
      delete st.steps.final
      writeFileSync(join(stateDir(w), 'state.json'), JSON.stringify(st))
      await ok(w, [V, '--withdraw'])
      expect(w.shared().owner).toBeNull()
      // still the floor: 1.0.0 can never ship again; 1.0.1 can
      w.bump('1.0.1')
      await ok(w, ['1.0.1'])
      expect(w.state('1.0.1').steps.preflight.floor).toBe(V)
    })
  })

  describe('an uncertain publish (r5 #1; r6 #2; r7)', () => {
    beforeEach(() => w.restore(accepted))

    it('only observed; --republish waits 10 min and refuses without immutability, then sends once; the held request lands later and changes nothing', async () => {
      w.gh.holdNextPublish = true
      await expect(w.run([V, '--publish'])).rejects.toThrow(Crash)
      expect(draftOf(w).draft).toBe(true)
      for (const argv of [[V, '--resume'], [V, '--publish'], ['1.0.1']]) {
        const r = await stops(w, argv, /is not settled: GitHub still shows a draft/)
        expect(r.stop).toMatch(/--settle-published[\s\S]*--republish[\s\S]*--settle-unpublished/)
      }
      expect(w.gh.publishCalls()).toHaveLength(1)
      await stops(w, [V, '--republish'], /allowed from/)
      w.clock.advance(11 * MIN)
      w.gh.repo(P).immutable = false
      await stops(w, [V, '--republish'], /immutability is off/)
      expect(w.gh.publishCalls()).toHaveLength(1)
      w.gh.repo(P).immutable = true
      await ok(w, [V, '--republish'])
      expect(w.gh.publishCalls()).toHaveLength(2)
      expect(w.record(V).status).toBe('published')
      // a newer release ships; then the held request lands: legacy keeps latest on the newer one
      w.bump('1.0.1')
      await ok(w, ['1.0.1'])
      await accept(w, '1.0.1')
      await ok(w, ['1.0.1', '--publish'])
      w.gh.landHeld()
      expect(w.gh.apiLatest(P)).toBe('1.0.1')
      w.clock.advance(10 * MIN)
      expect(w.gh.anonLatest(P)).toBe('1.0.1')
    })

    it('--settle-published records a publish the operator saw, and refuses while GitHub shows a draft', async () => {
      w.gh.holdNextPublish = true
      await expect(w.run([V, '--publish'])).rejects.toThrow(Crash)
      await stops(w, [V, '--settle-published'], /still shows a draft: refused/)
      w.gh.landHeld()
      await ok(w, [V, '--settle-published'])
      expect(w.record(V).status).toBe('published')
      expect(w.shared()).toMatchObject({ owner: null, pending: null })
    })

    it('the residual risk: settled unpublished after 24 h, abandoned, the draft left; the request lands; the next startup stops naming --withdraw, which ends it; nothing deleted', async () => {
      w.gh.holdNextPublish = true
      await expect(w.run([V, '--publish'])).rejects.toThrow(Crash)
      await stops(w, [V, '--settle-unpublished'], /allowed from/)
      w.clock.advance(24 * HOUR + MIN)
      await ok(w, [V, '--settle-unpublished'])
      expect(w.shared()).toMatchObject({ pending: null, watch: [{ version: V, releaseId: draftOf(w).id }] })
      await ok(w, [V, '--abandon'])
      expect(w.shared().watch).toHaveLength(1)
      w.gh.landHeld()
      w.bump('1.0.1')
      await stops(w, ['1.0.1'], /1\.0\.0 was settled unpublished .* GitHub now shows it published[\s\S]*1\.0\.0 --withdraw/)
      await ok(w, [V, '--withdraw'])
      expect(w.record(V)).toMatchObject({ status: 'withdrawn', unavailable: expect.arrayContaining(['the acceptance']) })
      expect(draftOf(w)).toMatchObject({ draft: false, prerelease: true })
      expect(w.shared()).toMatchObject({ watch: [] })
      commitRecord(w)
      await ok(w, ['1.0.1'])
      expect(w.gh.find(P, V)).toHaveLength(1)
    })

    it('republished after a settle: the watch entry retired, the next startup raising no alarm', async () => {
      w.gh.holdNextPublish = true
      await expect(w.run([V, '--publish'])).rejects.toThrow(Crash)
      w.clock.advance(24 * HOUR + MIN)
      await ok(w, [V, '--settle-unpublished'])
      expect(w.state(V).steps['settled-unpublished']).toBeTruthy()
      await ok(w, [V, '--republish'])
      expect(w.record(V).status).toBe('published')
      expect(w.shared()).toMatchObject({ owner: null, pending: null, watch: [] })
      w.gh.landHeld()
      w.bump('1.0.1')
      await ok(w, ['1.0.1'])
    })

    it('republished after a settle, the run cut after the publish and before the entry is retired: the next startup reconciles it, no alarm', async () => {
      w.gh.holdNextPublish = true
      await expect(w.run([V, '--publish'])).rejects.toThrow(Crash)
      w.clock.advance(24 * HOUR + MIN)
      await ok(w, [V, '--settle-unpublished'])
      w.gh.crashAfter.add('publish')
      await expect(w.run([V, '--republish'])).rejects.toThrow(Crash)
      expect(w.shared().watch).toEqual([{ version: V, releaseId: draftOf(w).id, republishing: true }])
      const from = w.lines.length
      await ok(w, [V, '--resume'])
      expect(w.lines.slice(from).join('\n')).not.toMatch(/STOPPED|--withdraw/)
      expect(w.record(V).status).toBe('published')
      expect(w.shared().watch).toEqual([])
    })

    it('--abandon is refused while a publish is unsettled; a request landing between its read and its end deletes nothing and is found by watch', async () => {
      w.gh.holdNextPublish = true
      await expect(w.run([V, '--publish'])).rejects.toThrow(Crash)
      await stops(w, [V, '--abandon'], /not settled/)
      w.clock.advance(24 * HOUR + MIN)
      await ok(w, [V, '--settle-unpublished'])
      w.gh.after.releases = () => { delete w.gh.after.releases; w.gh.landHeld() }
      await ok(w, [V, '--abandon'])
      expect(draftOf(w).draft).toBe(false)
      expect(w.gh.find(P, V)).toHaveLength(1)
      expect(w.shared().watch).toHaveLength(1)
      await stops(w, [V], /--withdraw/)
    })
  })

  describe('lost state (r6 #3)', () => {
    beforeEach(() => w.restore(ready))
    const lose = () => rmSync(stateDir(w), { recursive: true, force: true })

    it('published: --withdraw from GitHub\'s identity alone, interrupted and run again; the record lists what is unavailable; the next version\'s preflight passes', async () => {
      w.gh.applyPublish(P, draftOf(w).id)
      lose()
      w.bump('1.0.1')
      await stops(w, ['1.0.1'], /folder .* is missing[\s\S]*published: .*1\.0\.0 --withdraw/)
      w.gh.crashAfter.add('markPrerelease')
      await expect(w.run([V, '--withdraw'])).rejects.toThrow(Crash)
      expect(w.shared().owner).toMatchObject({ version: V })
      await ok(w, [V, '--withdraw'])
      const rec = w.record(V)
      expect(rec).toMatchObject({ status: 'withdrawn', acceptance: null, notary: null, source: null, unavailable: expect.arrayContaining(['the acceptance', 'the recorded hashes', 'the notary ids']) })
      expect(rec.assets.every((a: { githubDigest: string }) => a.githubDigest.startsWith('sha256:'))).toBe(true)
      expect(w.shared()).toMatchObject({ owner: null })
      await stops(w, ['1.0.1'], /tree is not clean: \?\? app\/releases\/1\.0\.0\.json/)
      commitRecord(w)
      await ok(w, ['1.0.1'])
    })

    it('a draft with no publish sent: --clear-owner; interrupted after its final, the next startup finishes it', async () => {
      lose()
      await stops(w, [V], /no publish sent: .*--clear-owner/)
      await stops(w, [V, '--abandon'], /--clear-owner/)
      // cut after `final` was written: the next startup clears the owner
      writeShared(w, { ...w.shared(), owner: { ...w.shared().owner, final: 'abandoned' } })
      w.bump('1.0.1')
      await ok(w, ['1.0.1'])
      expect(said(w)).toMatch(/ended abandoned: the repository is free/)
      expect(draftOf(w).draft).toBe(true)
    })

    it('a draft with no publish sent: --clear-owner frees the repository and deletes nothing', async () => {
      lose()
      await ok(w, [V, '--clear-owner'])
      expect(w.shared()).toMatchObject({ owner: null })
      expect(draftOf(w).draft).toBe(true)
      await ok(w, [V, '--clear-owner'])
      expect(said(w)).toMatch(/no owner: nothing to clear/)
    })

    it('a draft with an unsettled publish: refused until --settle-unpublished, then --clear-owner', async () => {
      w.restore(accepted)
      w.gh.holdNextPublish = true
      await expect(w.run([V, '--publish'])).rejects.toThrow(Crash)
      lose()
      const r = await stops(w, ['1.0.1'], /not settled/)
      expect(r.stop).not.toMatch(/--republish/)
      await stops(w, [V, '--clear-owner'], /not settled/)
      w.clock.advance(24 * HOUR + MIN)
      await ok(w, [V, '--settle-unpublished'])
      await ok(w, [V, '--clear-owner'])
      expect(w.shared()).toMatchObject({ owner: null, pending: null, watch: [{ version: V }] })
      w.bump('1.0.1')
      await ok(w, ['1.0.1'])
    })

    it('GitHub unreadable: the repository stays reserved', async () => {
      lose()
      w.gh.unreadable = true
      await stops(w, ['1.0.1'], /stays reserved/)
      await stops(w, [V, '--clear-owner'], /stays reserved/)
      expect(w.shared().owner).toMatchObject({ version: V })
    })
  })

  describe('abandon (r5 #2, #3)', () => {
    beforeEach(() => w.restore(ready))

    it('abandons cleanly after a moved HEAD, an unclean tree, a missing artifact and a changed hash', async () => {
      const cases: (() => void)[] = [
        () => { writeFileSync(join(w.repo, 'later.txt'), 'x'); gitIn(w.repo, ['add', '-A']); gitIn(w.repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'later']) },
        () => writeFileSync(join(w.repo, 'untracked.txt'), 'x'),
        () => rmSync(join(stateDir(w), N.zip)),
        () => writeFileSync(join(stateDir(w), N.feed), '{}'),
      ]
      for (const make of cases) {
        w.restore(ready)
        make()
        await ok(w, [V, '--abandon'])
        expect(existsSync(stateDir(w))).toBe(false)
        expect(w.shared().owner).toBeNull()
      }
    })

    it('interrupted after each of its steps, the next run finishes it, never pointing at a deleted folder', async () => {
      const sh = w.shared()
      const st = w.state(V)
      const putState = (s: unknown) => writeFileSync(join(stateDir(w), 'state.json'), JSON.stringify(s))
      // after the journal
      writeShared(w, { ...sh, owner: { ...sh.owner, abandoning: 1 } })
      putState({ ...st, steps: { ...st.steps, abandoning: { at: 1 } } })
      await stops(w, [V, '--resume'], /being abandoned/)
      await ok(w, [V, '--abandon'])
      expect(existsSync(stateDir(w))).toBe(false)
      // after the final: the next run's startup clears the owner; the folder still says abandoning
      w.restore(ready)
      writeShared(w, { ...sh, owner: { ...sh.owner, abandoning: 1, final: 'abandoned' } })
      putState({ ...st, steps: { ...st.steps, abandoning: { at: 1 } } })
      await stops(w, [V], /being abandoned/)
      expect(w.shared().owner).toBeNull()
      await ok(w, [V, '--abandon'])
      expect(existsSync(stateDir(w))).toBe(false)
      // after the owner is cleared, before the folder goes
      w.restore(ready)
      writeShared(w, { ...sh, owner: null })
      putState({ ...st, steps: { ...st.steps, abandoning: { at: 1 } } })
      await ok(w, [V, '--abandon'])
      expect(existsSync(stateDir(w))).toBe(false)
    })
  })

  describe('preflight', () => {
    beforeEach(() => w.restore(fresh))

    it('the version floor: a withdrawn 1.2.0, latest at 1.0.0, a candidate 1.1.0 - refused', async () => {
      w.gh.seed(P, '1.0.0')
      w.gh.seed(P, '1.2.0', { prerelease: true })
      w.bump('1.1.0')
      await stops(w, ['1.1.0'], /1\.1\.0 is not above the version floor 1\.2\.0/)
      expect(existsSync(stateDir(w, '1.1.0'))).toBe(false)
      expect(w.shared()).toBeNull()
    })

    it('immutability off: refused before anything is made', async () => {
      w.gh.repo(P).immutable = false
      await stops(w, [V], /immutability is off/)
      expect(w.builds).toEqual([])
      expect(w.gh.calls).not.toContain('createDraft')
    })

    it('refuses an unclean tree, a commit not pushed, a branch other than main, a package version, a section undated or naming no companion on npm', async () => {
      writeFileSync(join(w.repo, 'x.txt'), 'x')
      await stops(w, [V], /tree is not clean/)
      rmSync(join(w.repo, 'x.txt'))
      w.bump('1.0.1', { push: false })
      await stops(w, ['1.0.1'], /not pushed/)
      await stops(w, [V], /package\.json's version is 1\.0\.1/)
      gitIn(w.repo, ['push', '-q'])
      gitIn(w.repo, ['checkout', '-q', '-b', 'feature'])
      await stops(w, ['1.0.1'], /on feature: a production release is made from marver's main/)
      gitIn(w.repo, ['checkout', '-q', 'main'])
      w.bump('1.0.2', { companion: '0.30.0' })
      await stops(w, ['1.0.2'], /the companion marver 0\.30\.0 is not published on npm/)
      writeFileSync(join(w.app, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.2 - unreleased\n\n- x on marver 0.29.0\n')
      gitIn(w.repo, ['add', '-A'])
      gitIn(w.repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'undated'])
      gitIn(w.repo, ['push', '-q'])
      await stops(w, ['1.0.2'], /a release's is "## 1\.0\.2 - YYYY-MM-DD", dated/)
      await stops(w, ['0.99.1'], /a candidate's number/)
      expect(w.builds).toEqual([])
    })

    it('signing continuity (#8): an app whose signature does not satisfy the committed DR stops at its first check, and nothing is uploaded', async () => {
      w.tools.dr = 'identifier "design.marver.app" and anchor apple generic and certificate leaf[subject.OU] = ANOTHERTEAM'
      await stops(w, [V], /the stapled app fails its checks: it does not satisfy the designated requirement[\s\S]*its own DR is "identifier \\"design\.marver\.app\\" .*ANOTHERTEAM"/)
      expect(w.state(V).steps['staple-app']).toBeUndefined()
      expect(w.gh.calls).not.toContain('createDraft')
    })

    it('notarisation stops on Invalid with the issues, and waits again after a timeout without submitting again', async () => {
      w.notary.waitTimeouts = 1
      await stops(w, [V], /not finished .*run again to keep waiting/)
      await ok(w, [V])
      expect(w.notary.submits()).toHaveLength(2)
      w.restore(fresh)
      w.notary.plan.app = ['Invalid']
      await stops(w, [V], /Apple did not accept[\s\S]*signature of the binary is invalid/)
      await stops(w, [V], /Apple did not accept/)
      expect(w.notary.submits()).toHaveLength(1)
    })
  })
})

describe('release.mjs, code review round 2 (A5.1 #10, #11)', { timeout: 300_000 }, () => {
  let w: World
  let accepted: Snap
  beforeAll(async () => {
    w = makeWorld(V)
    await ok(w, [V])
    await accept(w)
    accepted = w.snap()
  }, 300_000)
  afterAll(() => w.cleanup())
  beforeEach(() => w.restore(accepted))
  /** an uncertain publish of `v`, settled unpublished 24 h on: the release watched */
  const settled = async (v = V) => {
    w.gh.holdNextPublish = true
    await expect(w.run([v, '--publish'])).rejects.toThrow(Crash)
    w.clock.advance(24 * HOUR + MIN)
    await ok(w, [v, '--settle-unpublished'])
  }

  it('#1 a crash between the local final and the shared one: the next run finishes the shared final and frees the repository', async () => {
    await ok(w, [V, '--publish'])
    expect(w.state(V).steps.final.status).toBe('published')
    // the shared record as the crash left it: the owner unfinished
    writeShared(w, { ...w.shared(), owner: { version: V, state: stateDir(w), at: 1 } })
    await ok(w, [V, '--resume'])
    expect(w.shared().owner).toBeNull()
  })

  it('#2 a republication cut before its request, then abandoned: the flag cleared, a late original publish still raises the alarm', async () => {
    await settled()
    // --republish cut after it marked the watch and before its request: the shared record as the crash left it
    const sh = w.shared()
    writeShared(w, { ...sh, watch: sh.watch.map((e: object) => ({ ...e, republishing: true })) })
    await ok(w, [V, '--abandon'])
    expect(w.shared().watch).toEqual([{ version: V, releaseId: draftOf(w).id }])
    w.gh.landHeld()
    await stops(w, ['1.0.1'], /1\.0\.0 was settled unpublished .* GitHub now shows it published/)
  })

  it('#2 the same with the owner\'s folder lost: --clear-owner clears the flag too', async () => {
    await settled()
    const sh = w.shared()
    writeShared(w, { ...sh, watch: sh.watch.map((e: object) => ({ ...e, republishing: true })) })
    rmSync(stateDir(w), { recursive: true, force: true })
    await ok(w, [V, '--clear-owner'])
    expect(w.shared()).toMatchObject({ owner: null, watch: [{ version: V, releaseId: draftOf(w).id }] })
    expect(w.shared().watch[0].republishing).toBeUndefined()
    w.gh.landHeld()
    await stops(w, ['1.0.1'], /1\.0\.0 was settled unpublished .* GitHub now shows it published/)
  })

  it('#3 two late publications: each --withdraw goes past the other\'s alarm, which stays', async () => {
    await settled()
    await ok(w, [V, '--abandon'])
    w.bump('1.0.1')
    await ok(w, ['1.0.1'])
    await accept(w, '1.0.1')
    await settled('1.0.1')
    await ok(w, ['1.0.1', '--abandon'])
    w.gh.landHeld()
    await stops(w, ['1.0.2'], /settled unpublished/)
    await ok(w, [V, '--withdraw'])
    expect(w.shared().watch).toEqual([{ version: '1.0.1', releaseId: draftOf(w, '1.0.1').id }])
    await ok(w, ['1.0.1', '--withdraw'])
    expect(w.shared().watch).toEqual([])
    expect([draftOf(w).prerelease, draftOf(w, '1.0.1').prerelease]).toEqual([true, true])
  })

  it('#4 settled unpublished: --resume advises --republish, --publish refuses naming it, --republish publishes and retires the watch', async () => {
    await settled()
    const from = w.lines.length
    await ok(w, [V, '--resume'])
    const out = w.lines.slice(from).join('\n')
    expect(out).toMatch(/--republish/)
    expect(out).not.toMatch(/--publish\b/)
    await stops(w, [V, '--publish'], /settled unpublished[\s\S]*--republish/)
    expect(w.gh.publishCalls()).toHaveLength(1)
    await ok(w, [V, '--republish'])
    expect(w.record(V).status).toBe('published')
    expect(w.shared()).toMatchObject({ owner: null, pending: null, watch: [] })
  })

  it('#6 a download that throws: a mutable release is still withdrawn, and a failed check still records check-failed', async () => {
    w.gh.after.immutable = () => { delete w.gh.after.immutable; w.gh.repo(P).immutable = false }
    w.gh.anonGetThrows = 1000
    await stops(w, [V, '--publish'], /published mutable: it is withdrawn/)
    expect(w.record(V)).toMatchObject({ status: 'withdrawn' })
    expect(draftOf(w).prerelease).toBe(true)
    w.restore(accepted)
    w.gh.anonGetThrows = 1000
    await stops(w, [V, '--publish'], /check-failed/)
    expect(w.record(V)).toMatchObject({ status: 'check-failed', check: { problems: expect.arrayContaining([expect.stringMatching(/could not be read: .*aborted due to timeout/)]) } })
    w.gh.anonGetThrows = 0
    await ok(w, [V, '--resume'])
    expect(w.record(V).status).toBe('published')
  })

  it('#6 a read that throws once is read again, as a refused one is', async () => {
    w.gh.anonGetThrows = 1
    await ok(w, [V, '--publish'])
    expect(w.record(V).status).toBe('published')
  })

  it('#7 the draft\'s identity is checked again just before the publish: its tag, title, target, body and prerelease flag', async () => {
    type Draft = { tag_name: string; name: string; target_commitish: string; body: string; prerelease: boolean }
    const edits: ((d: Draft) => void)[] = [
      (d) => { d.tag_name = 'v0.9.0' }, (d) => { d.name = 'Marver 1.0' }, (d) => { d.target_commitish = 'c'.repeat(40) },
      (d) => { d.body = 'edited by hand' }, (d) => { d.prerelease = true },
    ]
    for (const edit of edits) {
      w.restore(accepted)
      edit(w.gh.repo(P).releases.find((r) => r.tag_name === `v${V}`)!)
      await stops(w, [V, '--publish'], /the draft .* is not this release's/)
      expect(w.gh.publishCalls()).toEqual([])
    }
  })
})

describe('release.mjs --test (A5.1 #4, #31, #43)', { timeout: 300_000 }, () => {
  let w: World
  beforeAll(() => { w = makeWorld('0.99.1', { test: true }) })
  afterAll(() => w.cleanup())

  it('a candidate on any branch, the test feed, published with no acceptance and recorded as a candidate', async () => {
    w.gh.seed(TR, '0.90.2')
    await ok(w, ['0.99.1', '--test'])
    expect(w.builds[0]).toMatchObject({ feed: 'https://github.com/TNEP4/marver-app-test/releases/latest/download/releases.json' })
    expect(said(w)).toMatch(/needs no acceptance/)
    await stops(w, ['0.99.1'], /is a --test release: run it with --test/)
    await ok(w, ['0.99.1', '--publish', '--test'])
    expect(w.record('0.99.1')).toMatchObject({ status: 'published', kind: 'candidate', repo: TR, acceptance: null })
    expect(w.gh.find(P, '0.99.1')).toEqual([])
    expect(w.shared(true)).toMatchObject({ owner: null })
  })
})
