/**
 * One Team ID across a bundle (spec 28 A2.8). Every Mach-O part of an .app - the main binary, the frameworks and
 * their libraries, the helpers - carries the same Team ID, or none at all (an ad-hoc build). A bundle caught while
 * it is being signed carries two: the parts @electron/osx-sign has signed with the Developer ID, and the rest still
 * ad-hoc. Launched, it dies at once - the hardened runtime's library validation refuses to map a framework of
 * another Team ID - and macOS shows its "quit unexpectedly" dialog. So build.mjs checks before it moves a bundle
 * into out/, and the smoke and the test launchers check before they launch one.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

function isMachO(file) {
  const buf = Buffer.alloc(4)
  let fd
  try { fd = openSync(file, 'r'); if (readSync(fd, buf, 0, 4, 0) < 4) return false } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
  return MACHO.has(buf.readUInt32BE(0))
}

/** Every Mach-O file under the bundle's Contents/, symlinks skipped (a framework's Versions/Current and its top links). */
export function machOParts(app) {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && isMachO(p)) out.push(p)
    }
  }
  walk(join(app, 'Contents'))
  return out.sort()
}

/** `codesign -dv` of one part: its Team ID, or null for ad-hoc and unsigned (`signed` tells them apart). */
export function teamOf(file) {
  const r = spawnSync('codesign', ['-dv', file], { encoding: 'utf8' })
  const text = `${r.stdout}${r.stderr}`
  if (/not signed at all/.test(text)) return { team: null, signed: false }
  const m = /^TeamIdentifier=(.+)$/m.exec(text)
  return { team: m && m[1] !== 'not set' ? m[1].trim() : null, signed: r.status === 0 }
}

const label = (team) => team ?? 'none (ad-hoc or unsigned)'

/**
 * The verdict on a list of `{ part, team, signed }`, pure: ok when every part carries the same Team ID (or every
 * part none). The message names each Team ID with its parts, for a refusal anyone can read.
 */
export function judgeTeams(app, parts) {
  const by = new Map()
  for (const p of parts) { const k = p.team ?? ''; if (!by.has(k)) by.set(k, []); by.get(k).push(p.part) }
  if (!parts.length) return { ok: false, team: null, parts, message: `${app} holds no Mach-O part: not an app bundle` }
  if (by.size === 1) {
    const team = parts[0].team
    const unsigned = parts.filter((p) => !p.signed).length
    return { ok: true, team, parts, message: `${parts.length} Mach-O parts, one Team ID: ${label(team)}${unsigned ? ` (${unsigned} unsigned)` : ''}` }
  }
  const list = [...by].map(([k, ps]) => `${label(k || null)}: ${ps.length} part${ps.length > 1 ? 's' : ''} (${ps.slice(0, 3).join(', ')}${ps.length > 3 ? ', ...' : ''})`)
  return {
    ok: false, team: null, parts,
    message: `refusing to launch ${app}: its Mach-O parts carry ${by.size} Team IDs - ${list.join('; ')}. ` +
      'A bundle caught while it is being signed looks like this, and launching it crashes at once (library ' +
      'validation refuses a framework of another Team ID) with a macOS dialog. Build it again (node scripts/build.mjs) ' +
      'and launch the finished one in out/.',
  }
}

/** The check, on a bundle on disk. */
export function checkTeams(app) {
  const parts = machOParts(app).map((f) => ({ part: relative(app, f), ...teamOf(f) }))
  return judgeTeams(app, parts)
}

/** The .app that holds `file` (the outermost one: a helper's binary answers its main bundle). */
export function bundleOf(file) {
  let found = null
  for (let d = file; d !== dirname(d); d = dirname(d)) if (d.endsWith('.app')) found = d
  return found
}

const seen = new Map()
/** For a launcher: throws with the message when the bundle holding `bin` carries more than one Team ID. Once per bundle and process. */
export function assertOneTeam(bin) {
  const app = bundleOf(bin)
  if (!app) return null
  let v = seen.get(app)
  if (!v) { v = checkTeams(app); seen.set(app, v) }
  if (!v.ok) throw new Error(v.message)
  return v
}
