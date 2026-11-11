/**
 * release.mjs's rules, one by one (spec 28 A5.1 #5-#11, #32's scripts line): the versions' agreement and the floor,
 * the CHANGELOG section and its companion, the feed's exact bytes, the release's body, the publish's serialised
 * payload, the assets' reconciliation, the notary's history and statuses, the acceptance evidence, the tree hash.
 * test/fake/release-flow.test.ts runs them together, with every resume point and operator command.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_IDS, REPOS, T, assetNames, changelogSection, cmpVersion, companionVersions, feedText, ghFieldsPayload, isCandidate,
  judgeEvidence, notaryAppName, notaryDmgName, notaryOutcome, publishArgs, reconcileAssets, releaseBody, requiredChecks, sha256,
  submissionsOf, treeHash, versionAgreement, versionFloor, NPM_NAME, waiversFor, highlightsOf, needsHighlights,
} from '../../scripts/release.mjs'

const V = '1.0.0'
const P = REPOS.production
const hex = (c: string) => c.repeat(64)

describe('one version everywhere (#5)', () => {
  const plist = { CFBundleShortVersionString: V, CFBundleVersion: V }
  const feed = JSON.parse(feedText({ version: V, pubDate: '2026-11-09T10:00:00.000Z', notes: 'n', repo: P }))
  it('agrees when every place says X.Y.Z', () => {
    expect(versionAgreement(V, { plist, feed, release: { tag_name: 'v1.0.0', name: 'Marver 1.0.0' }, zipName: 'Marver-darwin-arm64-1.0.0.zip', heading: '## 1.0.0 - 2026-11-09', repo: P })).toEqual([])
  })
  it('names each place that does not', () => {
    expect(versionAgreement(V, { plist: { CFBundleShortVersionString: V, CFBundleVersion: '1.0.1' } })).toEqual(['CFBundleVersion is "1.0.1"'])
    expect(versionAgreement(V, { feed: { ...feed, currentRelease: '1.0.1' } })).toEqual(['the feed\'s currentRelease is "1.0.1"'])
    expect(versionAgreement(V, { feed: { ...feed, releases: [{ ...feed.releases[0], updateTo: { ...feed.releases[0].updateTo, name: 'Marver 1.0.0' } }] } })).toEqual(['updateTo.name is "Marver 1.0.0"'])
    expect(versionAgreement(V, { feed: { ...feed, releases: [...feed.releases, ...feed.releases] } })).toEqual(['the feed holds 2 entries, not one'])
    expect(versionAgreement(V, { feed, repo: REPOS.test })).toEqual([expect.stringMatching(/^updateTo\.url is/)])
    expect(versionAgreement(V, { release: { tag_name: 'v1.0.0', name: 'Marver 1.0' } })).toEqual(['the release\'s title is "Marver 1.0"'])
    expect(versionAgreement(V, { zipName: 'Marver-darwin-arm64-1.0.zip', heading: '## 1.0.1 - 2026-11-09' })).toHaveLength(2)
  })
})

describe('the version floor (#5, r2 #7)', () => {
  it('is the highest version ever made public: tags and published releases, prereleases included, drafts never; latest never', () => {
    const releases = [
      { tag_name: 'v1.0.0', draft: false }, { tag_name: 'v1.2.0', draft: false, prerelease: true }, { tag_name: 'v1.3.0', draft: true },
    ]
    expect(versionFloor({ tags: [], releases })).toBe('1.2.0')
    expect(versionFloor({ tags: [{ name: 'v1.2.1' }], releases })).toBe('1.2.1')
    expect(versionFloor({ tags: ['v1.10.0', 'v1.9.9', 'latest', 'v2.0.0-rc.1'], releases: [] })).toBe('1.10.0')
    expect(versionFloor({ tags: [], releases: [{ tag_name: 'v1.3.0', draft: true }] })).toBeNull()
  })
  it('compares numerically, as NSNumericSearch does', () => {
    expect(cmpVersion('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(cmpVersion('0.99.1', '0.99.1')).toBe(0)
    expect(cmpVersion('v1.0.0', '1.0.1')).toBeLessThan(0)
  })
  it('candidates are 0.9x (#31, #43)', () => {
    expect(['0.90.0', '0.99.12'].map(isCandidate)).toEqual([true, true])
    expect(['0.89.9', '0.100.0', '1.90.0', '1.0.0'].map(isCandidate)).toEqual([false, false, false, false])
  })
})

describe('the CHANGELOG section (#11 step 0)', () => {
  it('waivers: a candidate may fail only memory-no-canvas; 1.0.0, 1.0.1, 1.1.0 and 1.2.0 the same by Nic\'s decision; every other version none', () => {
    expect(waiversFor('0.99.3', true)).toEqual(['memory-no-canvas'])
    expect(waiversFor('1.0.0', false)).toEqual(['memory-no-canvas'])
    expect(waiversFor('1.0.1', false)).toEqual(['memory-no-canvas'])
    // Nic, 10 Nov: around 200 MB is fine for 1.1.0 (203.3 MB measured; abfd0f17)
    expect(waiversFor('1.1.0', false)).toEqual(['memory-no-canvas'])
    // Nic, 11 Nov: waive for 1.2.0, then watch it on the laptop once released (266.7-498.4 MB measured; ff5c9d13)
    expect(waiversFor('1.2.0', false)).toEqual(['memory-no-canvas'])
    for (const v of ['1.0.2', '1.2.1', '1.3.0', '2.0.0']) expect(waiversFor(v, false)).toEqual([])
  })

  it('the companion is looked up on npm under the repo\'s own package name, never a bare marver (0.99.1\'s first run)', () => {
    expect(NPM_NAME).toBe('@marver-design/marver')
  })

  const log = '# Changelog\n\n## 1.0.0 - 2026-11-09\n\n- One, on marver 0.29.0.\n- Two.\n\n## 0.3.0 - unreleased (spec 28 A4)\n\n- Old.\n'
  it('is exactly one dated heading and its body', () => {
    expect(changelogSection(log, V)).toEqual({ heading: '## 1.0.0 - 2026-11-09', date: '2026-11-09', text: '- One, on marver 0.29.0.\n- Two.' })
  })
  it('refuses a missing, a doubled, an undated, an impossible date or an empty section', () => {
    expect(changelogSection(log, '1.0.1')).toEqual({ error: 'app/CHANGELOG.md has no section for 1.0.1' })
    expect(changelogSection(`${log}\n## 1.0.0 - 2026-11-10\n\n- again\n`, V)).toMatchObject({ error: expect.stringContaining('2 sections') })
    expect(changelogSection(log, '0.3.0')).toMatchObject({ error: expect.stringContaining('"## 0.3.0 - YYYY-MM-DD", dated') })
    expect(changelogSection('## 1.0.0 - 2026-02-30\n\n- x\n', V)).toMatchObject({ error: expect.stringContaining('dated') })
    expect(changelogSection('## 1.0.0 - 2026-11-09\n\n## 0.3.0 - 2026-01-01\n- x\n', V)).toEqual({ error: 'the 1.0.0 section is empty' })
    expect(changelogSection('## 1.0.00 - 2026-11-09\n- x\n', V)).toMatchObject({ error: expect.any(String) })
  })
  it('names its companion as the npm package is written - lowercase "marver X.Y.Z" - never the app', () => {
    expect(companionVersions('Needs a canvas on marver 0.29.0. Marver 1.0.1 is already in Applications. marver 0.27.2 or later; marver 0.29.0.')).toEqual(['0.27.2', '0.29.0'])
    expect(companionVersions('canvases on Marver 0.27 or later')).toEqual([])
    expect(companionVersions('a remarver 0.29.0 or marver 0.29.0-beta')).toEqual([])
  })
})

describe('the feed (#9) and the release body', () => {
  it('releases.json: one entry, keys in order, the version\'s own ZIP, ending in a newline', () => {
    const text = feedText({ version: V, pubDate: '2026-11-09T10:00:00.000Z', notes: '- One.\n- Two.', repo: P })
    expect(text).toBe(`{
  "currentRelease": "1.0.0",
  "releases": [
    {
      "version": "1.0.0",
      "updateTo": {
        "version": "1.0.0",
        "pub_date": "2026-11-09T10:00:00.000Z",
        "notes": "- One.\\n- Two.",
        "name": "1.0.0",
        "url": "https://github.com/TNEP4/marver-app/releases/download/v1.0.0/Marver-darwin-arm64-1.0.0.zip"
      }
    }
  ]
}
`)
    expect(feedText({ version: '0.99.1', pubDate: 'x', notes: '', repo: REPOS.test })).toContain('https://github.com/TNEP4/marver-app-test/releases/download/v0.99.1/Marver-darwin-arm64-0.99.1.zip')
  })
  it('the body is the section, then a footer naming the source commit', () => {
    expect(releaseBody({ notes: '- One.', sha: 'c'.repeat(40) })).toBe(`- One.\n\n---\nBuilt from [TNEP4/marver@cccccccccccc](https://github.com/TNEP4/marver/tree/${'c'.repeat(40)}/app).\n`)
  })
  it('the names: three assets, and a submission name no other has', () => {
    expect(assetNames(V)).toEqual({ zip: 'Marver-darwin-arm64-1.0.0.zip', dmg: 'Marver-arm64.dmg', feed: 'releases.json' })
    expect(notaryAppName(V, `33ddceba18e3${'0'.repeat(52)}`)).toBe('Marver-1.0.0-app-33ddceba18e3.zip')
    expect(notaryDmgName(V, `2cc403bc27e3${'0'.repeat(52)}`)).toBe('Marver-1.0.0-dmg-2cc403bc27e3.dmg')
  })
})

describe('the publish (#10, r6 #1)', () => {
  it('is S3\'s one command, serialised {"draft":false,"make_latest":"legacy"}', () => {
    expect(publishArgs(P, 123)).toEqual(['api', '-X', 'PATCH', 'repos/TNEP4/marver-app/releases/123', '-F', 'draft=false', '-f', 'make_latest=legacy'])
    expect(ghFieldsPayload(publishArgs(P, 123))).toBe('{"draft":false,"make_latest":"legacy"}')
  })
  it('gh\'s typing: -F makes true, false, null and integers literals; -f keeps strings', () => {
    expect(ghFieldsPayload(['-f', 'draft=false', '-F', 'n=12', '-F', 'x=null', '-F', 's=legacy', '--raw-field', 'a=b=c'])).toBe('{"draft":"false","n":12,"x":null,"s":"legacy","a":"b=c"}')
  })
})

describe('the assets, reconciled never blindly replaced (#10)', () => {
  const want = { 'a.zip': { sha256: hex('a'), bytes: 10 }, 'b.dmg': { sha256: hex('b'), bytes: 20 }, 'releases.json': { sha256: hex('c'), bytes: 30 } }
  const asset = (id: number, name: string, c: string, size: number) => ({ id, name, size, digest: `sha256:${hex(c)}` })
  it('keeps what matches by digest and size, uploads what is missing, replaces what differs, deletes anything else', () => {
    const plan = reconcileAssets(want, [asset(1, 'a.zip', 'a', 10), asset(2, 'b.dmg', 'b', 21), asset(3, 'notes.txt', 'd', 1)])
    expect(plan).toEqual({ keep: ['a.zip'], upload: ['releases.json'], replace: [{ name: 'b.dmg', ids: [2] }], remove: [{ name: 'notes.txt', id: 3 }] })
    expect(reconcileAssets(want, [asset(1, 'a.zip', 'a', 10), asset(2, 'b.dmg', 'b', 20), asset(3, 'releases.json', 'c', 30)]))
      .toEqual({ keep: ['a.zip', 'b.dmg', 'releases.json'], upload: [], replace: [], remove: [] })
    // a missing digest is never taken for a match
    expect(reconcileAssets(want, [{ id: 1, name: 'a.zip', size: 10, digest: null }]).replace).toEqual([{ name: 'a.zip', ids: [1] }])
  })
})

describe('notarisation (#7)', () => {
  const at = Date.parse('2026-11-10T09:00:00Z')
  const h = (id: string, name: string, minutes: number, status = 'Accepted') => ({ id, name, status, createdDate: new Date(at + minutes * 60_000).toISOString() })
  it('finds every submission of the name since pending (Apple\'s clock allowed for), oldest first', () => {
    const history = [h('c', 'A.zip', 3), h('a', 'A.zip', 1), h('x', 'B.zip', 2), h('old', 'A.zip', -60), h('skew', 'A.zip', -2)]
    expect(submissionsOf(history, 'A.zip', at).map((s: { id: string }) => s.id)).toEqual(['skew', 'a', 'c'])
    expect(T.notarySkewMs).toBe(600_000)
    expect(submissionsOf(history, 'C.zip', at)).toEqual([])
  })
  it('the first Accepted serves; all Invalid or Rejected fail; anything else waits', () => {
    expect(notaryOutcome([{ id: '1', status: 'Invalid' }, { id: '2', status: 'Accepted' }])).toEqual({ accepted: '2' })
    expect(notaryOutcome([{ id: '1', status: 'Invalid' }, { id: '2', status: 'Rejected' }])).toEqual({ failed: true })
    expect(notaryOutcome([{ id: '1', status: 'Invalid' }, { id: '2', status: 'In Progress' }])).toEqual({ waiting: true })
    expect(notaryOutcome([{ id: '1', status: null }])).toEqual({ waiting: true })
    expect(notaryOutcome([])).toEqual({ waiting: true })
  })
})

describe('the acceptance (#11, r2 #5)', () => {
  const N = assetNames(V)
  const digests = { [N.zip]: `sha256:${hex('a')}`, [N.dmg]: `sha256:${hex('b')}` }
  const checks = Object.fromEntries(requiredChecks(V).map((id) => [id, 'pass']))
  const ev = { version: V, zip: hex('a'), dmg: hex('b'), mac: 'Mac mini', macos: '26.1', checks, google: 'refused', notes: '' }
  const judge = (e: unknown, o: Partial<{ zip: string; dmg: string; digests: Record<string, string> }> = {}) => judgeEvidence(e, { version: V, zip: hex('a'), dmg: hex('b'), digests, ...o })
  it('one frozen list for every release; 1.0.0 adds the install matrix', () => {
    expect(ACCEPTANCE_IDS).toEqual(['install-open', 'notarised', 'not-translocated', 'notice-ask', 'notice-banner', 'dock-badge', 'notice-denied', 'settings-link', 'signin', 'shared-card', 'live-picture'])
    expect(requiredChecks('1.0.1')).toEqual(ACCEPTANCE_IDS)
    expect(requiredChecks('1.0.0')).toEqual([...ACCEPTANCE_IDS, 'install-matrix'])
  })
  it('admits evidence of the exact bytes with every required check passed, Google either way', () => {
    expect(judge(ev)).toEqual({ ok: true, why: [] })
    expect(judge({ ...ev, google: 'accepted', checks: { ...checks, 'extra-look': 'fail' } }).ok).toBe(true)
  })
  it('matching hashes alone admit nothing: a required check missing or failed refuses', () => {
    const { signin: _, ...missing } = checks
    expect(judge({ ...ev, checks: missing })).toEqual({ ok: false, why: ['the required check signin is missing'] })
    expect(judge({ ...ev, checks: { ...checks, 'notice-banner': 'fail' } })).toEqual({ ok: false, why: ['the required check notice-banner is fail'] })
    expect(judge({ ...ev, checks: { ...checks, signin: 'ok' } }).why).toEqual(['check signin is "ok": \'pass\' or \'fail\'', 'the required check signin is ok'])
  })
  it('refuses other bytes - the state\'s or the draft\'s - another version, and missing fields', () => {
    expect(judge({ ...ev, dmg: hex('c') }).why).toEqual([`dmg: ${hex('c')} is not the state's ${hex('b')}`, `dmg: the draft's digest of Marver-arm64.dmg is sha256:${hex('b')}`])
    expect(judge(ev, { digests: { ...digests, [N.zip]: `sha256:${hex('f')}` } }).why).toEqual([`zip: the draft's digest of ${N.zip} is sha256:${hex('f')}`])
    expect(judge({ ...ev, zip: `sha256:${hex('a')}` }).why).toEqual(['zip: not a sha256 (64 lowercase hex)'])
    expect(judge({ ...ev, version: '1.0.1' }).why).toEqual(['its version is "1.0.1", not 1.0.0'])
    expect(judge({ ...ev, mac: '', macos: undefined, google: undefined, checks: undefined }).why).toEqual(['mac is missing', 'macos is missing', 'google is undefined: \'accepted\' or \'refused\'', 'checks is missing'])
    expect(judge([]).ok).toBe(false)
  })
})

describe('the tree hash (#11 step 7)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mv-tree-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const make = (dir: string) => {
    mkdirSync(join(dir, 'A.app', 'Contents', 'Versions', 'A'), { recursive: true })
    writeFileSync(join(dir, 'A.app', 'Contents', 'Versions', 'A', 'bin'), 'x')
    chmodSync(join(dir, 'A.app', 'Contents', 'Versions', 'A', 'bin'), 0o755)
    symlinkSync('A', join(dir, 'A.app', 'Contents', 'Versions', 'Current'))
    return join(dir, 'A.app')
  }
  it('takes every file\'s path, mode and sha256, each symlink as its target', () => {
    const a = make(join(root, 'one'))
    const b = make(join(root, 'two'))
    expect(treeHash(a)).toEqual(treeHash(b))
    expect(treeHash(a).bytes).toBe(1)
    chmodSync(join(b, 'Contents', 'Versions', 'A', 'bin'), 0o644)
    expect(treeHash(b).sha256).not.toBe(treeHash(a).sha256)
    const c = make(join(root, 'three'))
    rmSync(join(c, 'Contents', 'Versions', 'Current'))
    symlinkSync('B', join(c, 'Contents', 'Versions', 'Current'))
    expect(treeHash(c).sha256).not.toBe(treeHash(a).sha256)
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('spec 33 E2: the Highlights', () => {
  const H = (...b: string[]) => ['### Highlights', ...b.map((x) => `- ${x}`)].join('\n')
  it('3 to 5 one-line bullets, first in the section, then a blank line or the end', () => {
    expect(highlightsOf(`${H('One', 'Two', 'Three')}\n\nUse it with canvases on marver 0.32.0.\n\n- **Detail.** x`)).toEqual({ lines: ['One', 'Two', 'Three'] })
    expect(highlightsOf(`\n${H('A', 'B', 'C', 'D', 'E')}`)).toEqual({ lines: ['A', 'B', 'C', 'D', 'E'] })
    expect(highlightsOf('Use it with marver 0.32.0.\n\n- **x**').error).toMatch(/does not start with "### Highlights"/)
    expect(highlightsOf(H('A', 'B')).error).toMatch(/2 bullets, not 3 to 5/)
    expect(highlightsOf(H('A', 'B', 'C', 'D', 'E', 'F')).error).toMatch(/6 bullets/)
    expect(highlightsOf(`${H('A', 'B is long')}\n  and wraps\n- C`).error).toMatch(/one line starting "- "/)
    expect(highlightsOf(H('A', 'B', 'x'.repeat(91))).error).toMatch(/at most 90/)
    expect(highlightsOf(H('A', 'B', '**Bold**')).error).toMatch(/plain text/)
    expect(highlightsOf(H('A', 'B', 'a [link](https://x)')).error).toMatch(/plain text/)
  })
  it('required from 1.2.1, and for every --test candidate', () => {
    expect([needsHighlights('1.2.0', false), needsHighlights('1.2.1', false), needsHighlights('1.10.0', false), needsHighlights('0.99.1', true)]).toEqual([false, true, true, true])
  })
  it('the feed carries what it is given; the GitHub body is still the whole section', () => {
    const notes = 'One\nTwo\nThree'
    expect(JSON.parse(feedText({ version: '1.2.1', pubDate: 'd', notes, repo: P })).releases[0].updateTo.notes).toBe(notes)
    const text = `${H('One', 'Two', 'Three')}\n\n- **Detail.**`
    expect(releaseBody({ notes: text, sha: 'a'.repeat(40) }).startsWith(text)).toBe(true)
  })
  it('app/CHANGELOG.md\'s newest section opens with valid Highlights', async () => {
    const { readFileSync } = await import('node:fs')
    const log = readFileSync(join(import.meta.dirname, '..', '..', 'CHANGELOG.md'), 'utf8')
    const lines = log.split('\n')
    const at = lines.findIndex((l) => l.startsWith('## '))
    const end = lines.findIndex((l, i) => i > at && l.startsWith('## '))
    expect(highlightsOf(lines.slice(at + 1, end).join('\n'))).toHaveProperty('lines')
  })
})
