/**
 * The packaged smoke's A5 checks (spec 28 A5.1 #36), apart from smoke.mjs so test/unit/smoke-a5.test.ts reads the same
 * rules without a bundle: the seeded `update.json`, the feed a bundle should carry, the feed constant in its asar, and
 * the updater's one `blocked` record with no `move` and no `check`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** `state/update.json` v1 as Don't ask again leaves it (A5.1 #41): a declined move, nothing else */
export const declinedUpdateFile = (at) => ({ v: 1, intent: null, move: { declined: true, at }, staging: null })

/**
 * Every launch's home holds the answer Don't ask again writes (A5.1 #36, r1 #1), so a build with a feed launched from
 * .stage/ - where Marver would move itself from - never moves a staging bundle into Applications, through the
 * persisted preference alone. A case's own update.json is kept.
 */
export function seedHome(home, at = Date.now()) {
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 })
  const f = join(home, 'state', 'update.json')
  if (!existsSync(f)) writeFileSync(f, JSON.stringify(declinedUpdateFile(at)) + '\n')
}

/**
 * The feed this bundle should carry (A5.1 #4): `--feed=` (scripts/build.mjs passes it, before build.json exists), else
 * the `feed` of the build.json that names this app - beside it (a release's folder) or beside its Marver-darwin-arm64
 * (out/) - else none: a build from before A5 carries none.
 */
export function feedExpected(appPath, arg) {
  if (arg !== undefined) return arg
  for (const f of [join(dirname(appPath), 'build.json'), join(dirname(dirname(appPath)), 'build.json')]) {
    try {
      const b = JSON.parse(readFileSync(f, 'utf8'))
      if (b.app && resolve(b.app) === resolve(appPath)) return b.feed ?? 'none'
    } catch { /* not this one */ }
  }
  return 'none'
}

/**
 * The feed constant (A5.1 #4, #36): with a feed, dist/main.cjs holds its URL and no file the other's; without one, no
 * file holds either. `files` are the asar's scripts, `[path, text]`.
 * @param {[string, string][]} files
 * @param {string} feed none, production or test
 * @param {Record<string, string>} feeds tsdown.config.ts's FEEDS
 */
export function judgeFeed(files, feed, feeds) {
  const bad = []
  for (const [kind, url] of Object.entries(feeds)) {
    const where = files.filter(([, text]) => text.includes(url)).map(([f]) => f)
    if (kind === feed && !where.includes('/dist/main.cjs')) bad.push(`dist/main.cjs does not hold the ${kind} feed ${url}`)
    if (kind !== feed && where.length) bad.push(`${where.join(', ')} hold${where.length > 1 ? '' : 's'} the ${kind} feed, and this build's is ${feed}`)
  }
  return bad.length ? { ok: false, detail: bad.join('; ') }
    : { ok: true, detail: feed === 'none' ? 'no feed: neither feed URL in the bundle' : `the ${feed} feed in dist/main.cjs, the other nowhere` }
}

/** The `update` records of one launch's app.jsonl (A5.1 #25: written whatever `recorder` says) */
export function updateRecords(home) {
  let text = ''
  try { text = readFileSync(join(home, 'perf', 'app.jsonl'), 'utf8') } catch { return [] }
  return text.split('\n').flatMap((l) => {
    try { const r = JSON.parse(l); return r?.kind === 'update' ? [r] : [] } catch { return [] }
  })
}

/**
 * The updater's gate on a launch that completed its startup (A5.1 #13, #36): one `blocked` - `location` with a feed
 * (it runs from .stage/, never Applications), `feed` without one - with no `move` record (the seeded decline: nothing
 * copied) and no `check` record (no feed request).
 */
export function judgeUpdate(records, feed) {
  const want = feed === 'none' ? 'feed' : 'location'
  const blocked = records.filter((r) => r.phase === 'blocked')
  const bad = []
  if (blocked.length !== 1 || blocked[0].why !== want) bad.push(`${blocked.length} blocked record(s) (${blocked.map((r) => r.why).join(', ') || 'none'}), want one, why ${want}`)
  const moves = records.filter((r) => r.phase === 'move')
  if (moves.length) bad.push(`${moves.length} move record(s) (${moves.map((r) => r.why).join(', ')}): the seeded decline was not honoured`)
  const checks = records.filter((r) => r.phase === 'check')
  if (checks.length) bad.push(`${checks.length} check record(s): the feed was requested`)
  return bad.length ? { ok: false, detail: `${bad.join('; ')} (feed ${feed})` }
    : { ok: true, detail: `update { phase: 'blocked', why: '${want}' } once; no move, no check (feed ${feed})` }
}
