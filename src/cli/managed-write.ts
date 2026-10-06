import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MANAGED_PREFIX, LEGACY_PREFIX, hashBody, managedFile } from '../server/managed.ts'

/**
 * Write one managed file - the marker records a HASH of the body Marver generated, which makes
 * three states distinguishable with no other stored state:
 *   pristine  (body matches the hash)      -> updates flow through on upgrade
 *   edited    (body differs from the hash) -> NEVER overwritten; when upstream also moved, the
 *              fresh version is staged under `stageDir` and one line says to merge - an agent
 *              merges semantically, which is why no merge machinery ships here
 *   detached  (marker line deleted)        -> never touched, never mentioned
 *
 * `base` + `rel` is the file; `shown` is how messages name it (`design/AGENTS.md`,
 * `context/playbooks/release/PLAYBOOK.md`). Shared by `init` (design/) and `context init`.
 */
export function writeManaged(o: { base: string; rel: string; body: string; shown: string; stageDir: string; created: string[]; rerun: string }) {
  const { base, rel, body, shown, stageDir, created, rerun } = o
  const file = join(base, rel)
  const next = managedFile(body)
  const latest = join(stageDir, rel)
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    try { writeFileSync(file, next, { flag: 'wx' }); created.push(shown); return }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }   // written meanwhile: judge it below
  }
  const current = readFileSync(file, 'utf8')
  if (current === next) { rmSync(latest, { force: true }); return }
  // replace the file only if it is still the version judged here - a write landing in between
  // (an editor's save, another agent) is never overwritten; the next run judges it instead
  const replace = (content: string): boolean => {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, content, { flag: 'wx' })
    if (readFileSync(file, 'utf8') !== current) { rmSync(tmp, { force: true }); return false }
    renameSync(tmp, file)
    return true
  }
  if (current.startsWith(MANAGED_PREFIX)) {
    const recorded = current.slice(MANAGED_PREFIX.length).split(' ')[0]
    const nl = current.indexOf('\n')
    const currentBody = nl >= 0 ? current.slice(nl + 1) : ''
    if (nl >= 0 && hashBody(currentBody) === recorded) {
      if (!replace(next)) return                // pristine -> take the update (unless edited meanwhile)
      rmSync(latest, { force: true })
      created.push(`${shown} (updated)`)
    } else if (recorded !== hashBody(body)) {
      // edited AND upstream moved: preserve their body verbatim, stage ours for a merge, and
      // bump the marker's recorded base to the new upstream so this note fires ONCE per
      // release, not on every run forever. The bump is ATOMIC (temp + rename) and skipped
      // entirely for a malformed one-line file - user bytes are never on the losing side of a
      // partial write.
      mkdirSync(dirname(latest), { recursive: true })
      writeFileSync(latest, body)
      if (nl >= 0) replace(managedFile(body).split('\n')[0] + '\n' + currentBody)
      console.warn(`  ~ ${shown}: you customized it and a newer version exists - your edits are untouched. Merge what you want from ${latest.slice(latest.indexOf('design/.local/'))}`)
    }
    // edited, upstream unchanged since their base: silence. A previously staged copy stays
    // put - it is the merge source the note pointed at, and it still matches the upstream.
  } else if (current.startsWith(LEGACY_PREFIX)) {
    // hashless 0.2.2-dev marker: edits are undetectable; take the update (these files are
    // hours old and ours) and move them onto hashed markers
    if (!replace(next)) return
    rmSync(latest, { force: true })
    created.push(`${shown} (updated)`)
  } else if (current !== body) {
    // no marker: user-owned (fine) or a collision with foreign content - say so once per run,
    // never touch it
    rmSync(latest, { force: true })              // a detached file keeps no stale stage
    console.warn(`  note: ${shown} exists without a marver marker - left untouched. If you did not author it, delete it and re-run ${rerun} to restore the managed version.`)
  }
}
