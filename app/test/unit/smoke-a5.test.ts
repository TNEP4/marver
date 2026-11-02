/**
 * The packaged smoke's A5 checks (spec 28 A5.1 #36; test/smoke/a5.mjs), without a bundle: the seeded update.json, the
 * feed a bundle should carry, the feed constant in its asar, and the updater's one `blocked` record.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { declinedUpdateFile, feedExpected, judgeFeed, judgeUpdate, seedHome, updateRecords } from '../smoke/a5.mjs'
import { FEEDS } from '../../tsdown.config.ts'

const root = mkdtempSync(join(tmpdir(), 'mv-smoke-a5-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('every launch\'s home: the answer Don\'t ask again writes (#36, r1 #1)', () => {
  it('seeds state/update.json v1 with a declined move, and keeps a case\'s own', () => {
    const home = join(root, 'h1')
    seedHome(home, 1234)
    expect(JSON.parse(readFileSync(join(home, 'state', 'update.json'), 'utf8'))).toEqual({ v: 1, intent: null, move: { declined: true, at: 1234 }, staging: null })
    expect(declinedUpdateFile(5)).toEqual({ v: 1, intent: null, move: { declined: true, at: 5 }, staging: null })
    const own = join(root, 'h2')
    mkdirSync(join(own, 'state'), { recursive: true })
    writeFileSync(join(own, 'state', 'update.json'), '{"v":1,"intent":null,"move":null,"staging":null}')
    seedHome(own)
    expect(JSON.parse(readFileSync(join(own, 'state', 'update.json'), 'utf8')).move).toBeNull()
  })
})

describe('the feed a bundle carries (#4)', () => {
  it('--feed= first, then the build.json naming this app (a release\'s folder, or out/), else none', () => {
    const rel = join(root, 'release', '1.0.0')
    mkdirSync(join(rel, 'Marver.app'), { recursive: true })
    writeFileSync(join(rel, 'build.json'), JSON.stringify({ app: join(rel, 'Marver.app'), feed: 'production' }))
    expect(feedExpected(join(rel, 'Marver.app'), undefined)).toBe('production')
    expect(feedExpected(join(rel, 'Marver.app'), 'test')).toBe('test')
    const out = join(root, 'out')
    mkdirSync(join(out, 'Marver-darwin-arm64', 'Marver.app'), { recursive: true })
    writeFileSync(join(out, 'build.json'), JSON.stringify({ app: join(out, 'Marver-darwin-arm64', 'Marver.app') }))
    expect(feedExpected(join(out, 'Marver-darwin-arm64', 'Marver.app'), undefined)).toBe('none')
    // a build.json about another bundle (the stage, before the move) says nothing about this one
    expect(feedExpected(join(root, 'stage', 'Marver-darwin-arm64', 'Marver.app'), undefined)).toBe('none')
  })
})

describe('the feed constant in the asar (#4, #36)', () => {
  const main = (url: string) => `const feed = ${JSON.stringify(url)};\n`
  it('a release with a feed: its URL in dist/main.cjs, the other nowhere', () => {
    expect(judgeFeed([['/dist/main.cjs', main(FEEDS.production)], ['/dist/pages/home/main.js', '']], 'production', FEEDS)).toMatchObject({ ok: true })
    expect(judgeFeed([['/dist/main.cjs', main(FEEDS.test)]], 'test', FEEDS)).toMatchObject({ ok: true })
    expect(judgeFeed([['/dist/main.cjs', main(FEEDS.test)]], 'production', FEEDS)).toEqual({ ok: false,
      detail: `dist/main.cjs does not hold the production feed ${FEEDS.production}; /dist/main.cjs holds the test feed, and this build's is production` })
    expect(judgeFeed([['/dist/main.cjs', main(FEEDS.production)], ['/dist/preload-app.cjs', main(FEEDS.test)]], 'production', FEEDS).ok).toBe(false)
  })
  it('a build without one: neither URL anywhere', () => {
    expect(judgeFeed([['/dist/main.cjs', 'const feed = "";']], 'none', FEEDS)).toEqual({ ok: true, detail: 'no feed: neither feed URL in the bundle' })
    expect(judgeFeed([['/dist/main.cjs', main(FEEDS.production)]], 'none', FEEDS).ok).toBe(false)
  })
})

describe('the updater\'s gate on the clean launch (#13, #36)', () => {
  const rec = (phase: string, why?: string) => ({ v: 1, kind: 'update', phase, ...(why ? { why } : {}) })
  it('one blocked: location with a feed, feed without; no move, no check', () => {
    expect(judgeUpdate([rec('blocked', 'location')], 'production')).toMatchObject({ ok: true })
    expect(judgeUpdate([rec('blocked', 'feed')], 'none')).toMatchObject({ ok: true })
    expect(judgeUpdate([rec('blocked', 'feed')], 'test').ok).toBe(false)
    expect(judgeUpdate([], 'production')).toMatchObject({ ok: false, detail: expect.stringContaining('0 blocked record(s) (none), want one, why location') })
    expect(judgeUpdate([rec('blocked', 'location'), rec('blocked', 'location')], 'production').ok).toBe(false)
    expect(judgeUpdate([rec('blocked', 'location'), rec('move', 'moved')], 'production')).toMatchObject({ ok: false, detail: expect.stringContaining('1 move record(s) (moved)') })
    expect(judgeUpdate([rec('blocked', 'location'), rec('check')], 'production')).toMatchObject({ ok: false, detail: expect.stringContaining('the feed was requested') })
  })
  it('reads only the update records of a launch\'s app.jsonl', () => {
    const home = join(root, 'h3')
    mkdirSync(join(home, 'perf'), { recursive: true })
    writeFileSync(join(home, 'perf', 'app.jsonl'), [JSON.stringify({ v: 1, kind: 'start' }), 'not json', JSON.stringify(rec('blocked', 'location')), ''].join('\n'))
    expect(updateRecords(home)).toEqual([rec('blocked', 'location')])
    expect(updateRecords(join(root, 'nowhere'))).toEqual([])
  })
})
