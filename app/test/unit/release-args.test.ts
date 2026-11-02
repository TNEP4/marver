/**
 * The two scripts' command lines (spec 28 A5.1 #3): build.mjs takes only its own options and refuses `--release` by
 * name; release.mjs takes one version of three numbers, at most one command and `--test`, nothing else. Neither
 * script runs here: only their parsers.
 */
import { describe, expect, it } from 'vitest'
import { BUILD_FLAGS, feedKind, parseBuildArgs } from '../../scripts/build.mjs'
import { COMMANDS, parseArgs, run } from '../../scripts/release.mjs'
import { FEEDS } from '../../tsdown.config.ts'

describe('build.mjs, every argument checked', () => {
  it('takes --js, --adhoc, --no-smoke, --tamper and --known-fail=…, nothing else', () => {
    expect(BUILD_FLAGS).toEqual(['--js', '--adhoc', '--no-smoke', '--tamper'])
    expect(parseBuildArgs([])).toEqual({ js: false, adhoc: false, smoke: true, tamper: false, knownFail: [] })
    expect(parseBuildArgs(['--adhoc', '--no-smoke'])).toEqual({ js: false, adhoc: true, smoke: false, tamper: false, knownFail: [] })
    expect(parseBuildArgs(['--tamper', '--known-fail=memory-no-canvas'])).toEqual({ js: false, adhoc: false, smoke: true, tamper: true, knownFail: ['memory-no-canvas'] })
    expect(parseBuildArgs(['--js'])).toMatchObject({ js: true })
  })

  it('refuses --release by name: a release is scripts/release.mjs', () => {
    expect(parseBuildArgs(['--release'])).toEqual({ error: '--release: a release is scripts/release.mjs' })
    expect(parseBuildArgs(['--adhoc', '--release'])).toEqual({ error: '--release: a release is scripts/release.mjs' })
    expect(parseBuildArgs(['--release=1.0.0'])).toMatchObject({ error: expect.stringContaining('a release is scripts/release.mjs') })
  })

  it('refuses anything it does not know, by name - never ignored (the old parser built anyway)', () => {
    for (const a of ['--relase', '--feed=x', '-r', 'release', '1.0.0', '--smoke', '--no-tamper']) {
      expect(parseBuildArgs([a]), a).toEqual({ error: expect.stringMatching(new RegExp(`^${a.replace(/[-=.]/g, '\\$&')}: not an option of build\\.mjs`)) })
    }
  })

  it('--js takes no other option', () => {
    expect(parseBuildArgs(['--js', '--adhoc'])).toEqual({ error: '--js takes no other option: --adhoc' })
    expect(parseBuildArgs(['--js', '--no-smoke', '--tamper'])).toEqual({ error: '--js takes no other option: --no-smoke --tamper' })
  })

  it('passes --known-fail\'s own refusals on', () => {
    expect(parseBuildArgs(['--known-fail=no-crash-dialogs'])).toMatchObject({ error: expect.stringContaining('cannot be a known failure') })
    expect(parseBuildArgs(['--known-fail'])).toMatchObject({ error: expect.any(String) })
  })

  it('names a bundle\'s feed: none, production or test, and nothing else', () => {
    expect(feedKind('')).toBe('none')
    expect(feedKind(FEEDS.production)).toBe('production')
    expect(feedKind(FEEDS.test)).toBe('test')
    expect(feedKind('https://github.com/TNEP4/marver-app/releases/latest/download/other.json')).toBeNull()
  })
})

describe('release.mjs, every argument checked', () => {
  it('one version, at most one command, --test', () => {
    expect(parseArgs(['1.0.0'])).toEqual({ version: '1.0.0', command: 'prepare', evidence: null, test: false })
    expect(parseArgs(['0.99.3', '--test'])).toEqual({ version: '0.99.3', command: 'prepare', evidence: null, test: true })
    expect(parseArgs(['--publish', '1.0.0'])).toMatchObject({ version: '1.0.0', command: 'publish' })
    expect(parseArgs(['1.0.0', '--accept=/tmp/evidence.json'])).toEqual({ version: '1.0.0', command: 'accept', evidence: '/tmp/evidence.json', test: false })
    for (const c of COMMANDS.filter((x) => x !== 'accept')) expect(parseArgs(['1.2.3', `--${c}`]), c).toMatchObject({ command: c })
    expect(COMMANDS).toEqual(['resume', 'accept', 'publish', 'abandon', 'withdraw', 'settle-published', 'republish', 'settle-unpublished', 'clear-owner'])
  })

  it('refuses a version that is not three numbers (Squirrel\'s NSNumericSearch, #5)', () => {
    for (const v of ['1.0', '1.0.0-rc.1', 'v1.0.0', '1.0.0.1', 'one']) expect(parseArgs([v]), v).toMatchObject({ error: expect.stringContaining('not a version X.Y.Z') })
    expect(parseArgs([])).toEqual({ error: 'the version is missing' })
    expect(parseArgs(['1.0.0', '1.0.1'])).toEqual({ error: 'one version at a time: 1.0.0 and 1.0.1' })
  })

  it('refuses two commands, an unknown option, a command with a value, --accept without its file, and the build\'s options', () => {
    expect(parseArgs(['1.0.0', '--publish', '--abandon'])).toEqual({ error: 'one command at a time: --publish and --abandon' })
    expect(parseArgs(['1.0.0', '--test', '--test'])).toEqual({ error: '--test given twice' })
    expect(parseArgs(['1.0.0', '--force'])).toEqual({ error: '--force: not an option of release.mjs' })
    expect(parseArgs(['1.0.0', '--publish=now'])).toEqual({ error: '--publish=now: not an option of release.mjs' })
    expect(parseArgs(['1.0.0', '--accept'])).toMatchObject({ error: expect.stringContaining('--accept needs the evidence file') })
    expect(parseArgs(['1.0.0', '--accept='])).toMatchObject({ error: expect.stringContaining('--accept needs the evidence file') })
    for (const a of ['--adhoc', '--release', '--js']) expect(parseArgs(['1.0.0', a]), a).toMatchObject({ error: expect.stringContaining('always builds signed, smoked and with its feed') })
    for (const a of ['--no-smoke', '--known-fail=memory-no-canvas', '--tamper', '-p']) expect(parseArgs(['1.0.0', a]), a).toMatchObject({ error: expect.stringContaining('not an option of release.mjs') })
  })

  it('a refused command line runs nothing: exit 2 and the usage, before any port is touched', async () => {
    const lines: string[] = []
    const ports = new Proxy({}, { get: () => { throw new Error('a port was touched') } })
    const r = await run(['1.0.0', '--no-smoke'], { ports, log: (s: string) => { lines.push(s) } })
    expect(r).toEqual({ code: 2 })
    expect(lines.join('\n')).toMatch(/--no-smoke: not an option[\s\S]*usage: node scripts\/release\.mjs <X\.Y\.Z>/)
  })
})
