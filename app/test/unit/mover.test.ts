/**
 * Move to Applications (spec 28 A5.1 #23, #24, #32, #40.1; v1.33), on temporary folders only - a fake "Applications"
 * and a small bundle, the real `ditto`, `plutil` and `rename(2)`, `codesign` answered by the case (the bundle is not
 * signed). Nothing here touches the real /Applications.
 *
 * What is at the destination decides, and nothing is written before the install; an existing copy is never renamed,
 * moved or deleted; the interleavings right after the last look (r3 #1, r4 #4): a bundle, a link (a dangling one too)
 * and a file put at the destination between the copy and the claim, a file put inside the placeholder between the claim
 * and the rename, the placeholder swapped for another empty folder; the crashes (r4 #5), each cleaned at the next offer
 * by its recorded identity alone - and the two before an identity is written, leaving an empty folder no one deletes;
 * another folder at the recorded path left alone; the relaunch script with no `xattr`; ditto's four preservations.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UpdateFile } from '../../src/main/config.ts'
import {
  answerFor, claim, cleanLeftover, compareVersions, copy, DITTO_FLAGS, finderAlert, install, look, moveAsks, nodeMoverPorts, offerMove, openItAlert, relaunchScript,
  sourceOf, stage, STAGING_PREFIX, verify, type MoveAlert, type MoverPorts,
} from '../../src/main/mover.ts'
import type { UpdateBody } from '../../../src/shared/app-perf.ts'

let base: string
let apps: string
let src: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-mover-')))
  apps = join(base, 'Applications')
  mkdirSync(apps)
  src = join(base, 'Downloads', 'Marver.app')
  bundle(src, '1.0.1')
})
afterEach(() => {
  for (const d of [apps, join(base, 'Downloads')]) try { chmodSync(d, 0o755) } catch { /* gone */ }
  rmSync(base, { recursive: true, force: true })
})

const plist = (id: string, version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>
`
/** A small bundle: Info.plist, an executable, a framework link (ditto keeps it). */
function bundle(at: string, version: string, id = 'design.marver.app'): void {
  mkdirSync(join(at, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(at, 'Contents', 'Frameworks', 'X.framework', 'Versions', 'A'), { recursive: true })
  writeFileSync(join(at, 'Contents', 'Info.plist'), plist(id, version))
  writeFileSync(join(at, 'Contents', 'MacOS', 'Marver'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 })
  symlinkSync('A', join(at, 'Contents', 'Frameworks', 'X.framework', 'Versions', 'Current'))
}
/** A tree's names, kinds, inodes and bytes: equal before and after means nothing was renamed, moved or changed. */
function tree(p: string): string {
  const h = createHash('sha256')
  const walk = (q: string): void => {
    const st = lstatSync(q)
    h.update(`${q}|${st.ino}|${st.isDirectory()}|${st.isSymbolicLink()}\n`)
    if (st.isFile()) h.update(readFileSync(q))
    if (st.isDirectory()) for (const n of readdirSync(q).sort()) walk(join(q, n))
  }
  walk(p)
  return h.digest('hex')
}
const dest = () => join(apps, 'Marver.app')
const stagings = () => readdirSync(apps).filter((n) => n.startsWith(STAGING_PREFIX))

interface Rig {
  p: MoverPorts
  file: UpdateFile
  writes: UpdateFile[]
  records: UpdateBody[]
  asked: MoveAlert[]
  answer: string
  revealed: string[][]
  relaunched: string[]
  quits: number
  /** tools as they ran */
  ran: { cmd: string; args: string[] }[]
  /** the case's hook in codesign --verify (after the copy, before the claim) and in each update.json write */
  onVerify?: () => void
  onWrite?: (f: UpdateFile) => void
  writeOk: boolean
}

function rig(o: { version?: string; file?: Partial<UpdateFile> } = {}): Rig {
  const r: Rig = {
    p: null as unknown as MoverPorts, file: { v: 1, intent: null, move: null, staging: null, ...o.file }, writes: [], records: [], asked: [], answer: '', revealed: [], relaunched: [], quits: 0, ran: [], writeOk: true,
  }
  const node = nodeMoverPorts({
    bundle: src, version: o.version ?? '1.0.1', apps,
    read: () => structuredClone(r.file),
    write: (f) => { if (!r.writeOk) return false; r.file = structuredClone(f); r.writes.push(structuredClone(f)); r.onWrite?.(f); return true },
    record: (b) => { r.records.push(b) },
    ask: async (a) => { r.asked.push(a); return { button: r.answer || a.buttons[0]!, checked: false } },
    reveal: (paths) => { r.revealed.push(paths) },
    quit: () => { r.quits += 1 },
  })
  r.p = {
    ...node,
    now: () => 1_800_000_000_000,
    from: () => 'Downloads',
    relaunch: (s) => { r.relaunched.push(s) },
    run: (cmd, args) => {
      r.ran.push({ cmd, args })
      if (cmd !== '/usr/bin/codesign') return node.run(cmd, args)
      if (args[0] === '--verify') { r.onVerify?.(); return { code: 0, out: '' } }
      return { code: 0, out: `Executable=${args.at(-1)}\ndesignated => identifier "design.marver.app" and anchor apple generic and certificate leaf[subject.OU] = PXV6WER853\n` }
    },
  }
  return r
}
const whys = (r: Rig) => r.records.filter((b) => b.phase === 'move').map((b) => b.why)

describe('what is at the destination decides (#23)', () => {
  it('nothing, in a writable Applications: installed silently - no question, the moved note written, relaunched, quit', async () => {
    expect(moveAsks).toBe(false)
    const r = rig()
    expect(look(r.p)).toEqual({ kind: 'empty', writable: true })
    expect(await offerMove(r.p, { feed: 'f', inApplications: false })).toBe('quit')
    expect(r.asked).toEqual([])
    expect(readFileSync(join(dest(), 'Contents', 'MacOS', 'Marver'), 'utf8')).toContain('1.0.1')
    expect(lstatSync(join(dest(), 'Contents', 'Frameworks', 'X.framework', 'Versions', 'Current')).isSymbolicLink()).toBe(true)
    expect(stagings()).toEqual([])
    expect(r.file).toEqual({ v: 1, intent: null, move: { moved: true, at: 1_800_000_000_000, from: 'Downloads' }, staging: null })
    expect(r.relaunched).toEqual([relaunchScript(process.pid, dest())])
    expect(r.quits).toBe(1)
    expect(whys(r)).toEqual(['moved'])
    // the source is never deleted or trashed
    expect(existsSync(join(src, 'Contents', 'Info.plist'))).toBe(true)
  })

  it('a Marver of this version or newer: Open It (the default) relaunches into it and quits; Cancel goes on; nothing written either way', async () => {
    for (const v of ['1.0.1', '1.2.0']) {
      bundle(dest(), v)
      const before = tree(dest())
      const r = rig()
      expect(answerFor(look(r.p))).toBe('open-existing')
      expect(await offerMove(r.p, { feed: 'f', inApplications: false })).toBe('quit')
      expect(r.asked).toEqual([openItAlert(v)])
      expect(r.asked[0]!.message).toBe(`Marver ${v} is already in Applications`)
      expect(r.relaunched).toEqual([relaunchScript(process.pid, dest())])
      expect(whys(r)).toEqual(['offered', 'opened-existing'])
      const c = rig()
      c.answer = 'Cancel'
      expect(await offerMove(c.p, { feed: 'f', inApplications: false })).toBe('go-on')
      expect(c.quits).toBe(0)
      expect(whys(c)).toEqual(['offered', 'cancelled'])
      for (const x of [r, c]) expect(x.writes).toEqual([])
      expect(stagings()).toEqual([])
      expect(tree(dest())).toBe(before)
      rmSync(dest(), { recursive: true })
    }
  })

  it('Open It acts only on the copy it was asked about: replaced or removed while the alert was up, what is there now decides (code review r1 P2)', async () => {
    const changing = (r: Rig, change: () => void) => {
      const ask = r.p.ask
      let n = 0
      r.p = { ...r.p, ask: async (a) => { if (n++ === 0) change(); return ask(a) } }
    }
    // replaced by an older Marver: the Finder route, nothing opened, nothing quit
    bundle(dest(), '1.2.0')
    const r = rig()
    changing(r, () => { rmSync(dest(), { recursive: true }); bundle(dest(), '0.3.0') })
    expect(await offerMove(r.p, { feed: 'f', inApplications: false })).toBe('go-on')
    expect(r.relaunched).toEqual([])
    expect(r.quits).toBe(0)
    expect(r.asked.map((a) => a.message)).toEqual(['Marver 1.2.0 is already in Applications', 'An older Marver (0.3.0) is in Applications'])
    expect(whys(r)).not.toContain('opened-existing')
    rmSync(dest(), { recursive: true })
    // removed: the slot is empty now, and the silent move runs instead
    bundle(dest(), '1.2.0')
    const m = rig()
    changing(m, () => { rmSync(dest(), { recursive: true }) })
    expect(await offerMove(m.p, { feed: 'f', inApplications: false })).toBe('quit')
    expect(whys(m)).toEqual(['offered', 'moved'])
    expect(m.relaunched).toEqual([relaunchScript(process.pid, dest())])
    rmSync(dest(), { recursive: true, force: true })
  })

  it('anything else is the Finder route: an older Marver, another app of that name, an empty folder, a file, a link, an Applications this account cannot write', async () => {
    const cases: [string, () => void, RegExp][] = [
      ['older', () => bundle(dest(), '0.3.0'), /^An older Marver \(0\.3\.0\) is in Applications$/],
      ['another app', () => bundle(dest(), '9.0.0', 'com.example.marver'), /^Another app named Marver/],
      ['an empty folder', () => mkdirSync(dest()), /^An empty folder named Marver\.app/],
      ['a folder of something else', () => { mkdirSync(dest()); writeFileSync(join(dest(), 'notes.txt'), 'x') }, /^Something named Marver\.app/],
      ['a file', () => writeFileSync(dest(), 'x'), /^Something named Marver\.app/],
      ['a link to an app', () => { bundle(join(base, 'Elsewhere', 'Marver.app'), '2.0.0'); symlinkSync(join(base, 'Elsewhere', 'Marver.app'), dest()) }, /^Something named Marver\.app/],
      ['a dangling link', () => symlinkSync(join(base, 'nowhere'), dest()), /^Something named Marver\.app/],
      ['an unwritable Applications', () => chmodSync(apps, 0o555), /^Marver can't add itself to Applications/],
    ]
    for (const [what, make, message] of cases) {
      make()
      const before = existsSync(dest()) || lstatSync(dest(), { throwIfNoEntry: false }) ? tree(dest()) : null
      const r = rig()
      r.answer = 'Show Both'
      expect(answerFor(look(r.p)), what).toBe('finder')
      expect(await offerMove(r.p, { feed: 'f', inApplications: false }), what).toBe('go-on')
      expect(r.asked[0]!.message, what).toMatch(message)
      expect(r.asked[0]!.buttons, what).toEqual(['Show Both', 'Cancel'])
      expect(r.revealed, what).toEqual([what === 'an unwritable Applications' ? [src, apps] : [src, dest()]])
      expect(r.writes, what).toEqual([])
      expect(r.quits, what).toBe(0)
      expect(whys(r), what).toEqual(['finder'])
      if (before) expect(tree(dest()), what).toBe(before)
      chmodSync(apps, 0o755)
      expect(stagings(), what).toEqual([])
      rmSync(dest(), { recursive: true, force: true })
    }
  })

  it('the older Marver\'s words: drag and Replace, and Finder asks for an administrator when the copy cannot be written', () => {
    expect(finderAlert({ kind: 'marver', version: '0.3.0', newer: false, writable: true, dev: 1, ino: 2 }).detail).toBe('To replace it, drag this Marver into Applications and choose Replace.')
    expect(finderAlert({ kind: 'marver', version: '0.3.0', newer: false, writable: false, dev: 1, ino: 2 }).detail).toContain("Finder asks for an administrator's name and password.")
    expect(finderAlert({ kind: 'empty-folder' }).detail).toBe('Move that empty folder to the Trash, then open the download again.')
  })

  it('no feed, already in Applications, or a declined move: no look at all', async () => {
    for (const [o, file] of [[{ feed: '', inApplications: false }, {}], [{ feed: 'f', inApplications: true }, {}], [{ feed: 'f', inApplications: false }, { move: { declined: true as const, at: 1 } }]] as const) {
      const r = rig({ file })
      expect(await offerMove(r.p, o)).toBe('go-on')
      expect(r.asked).toEqual([])
      expect(r.writes).toEqual([])
      expect(r.records).toEqual([])
      expect(existsSync(dest())).toBe(false)
    }
  })

  it('versions compare as numbers; anything else is older', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.1', '1.0.1')).toBe(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('', '1.0.0')).toBeLessThan(0)
  })
})

describe('the install\'s order and its tools', () => {
  it('staging recorded before the copy; ditto with its four named preservations; codesign verified and the DR compared', () => {
    const r = rig()
    let recordedBeforeCopy = false
    const p = { ...r.p, run: (cmd: string, args: string[]) => { if (cmd === '/usr/bin/ditto') recordedBeforeCopy = !!r.file.staging && existsSync(r.file.staging.path); return r.p.run(cmd, args) } }
    expect(install(p)).toBe('moved')
    expect(recordedBeforeCopy).toBe(true)
    const ditto = r.ran.find((x) => x.cmd === '/usr/bin/ditto')!
    expect(DITTO_FLAGS).toEqual(['--rsrc', '--extattr', '--qtn', '--acl'])
    expect(ditto.args.slice(0, 4)).toEqual([...DITTO_FLAGS])
    expect(ditto.args[4]).toBe(src)
    expect(ditto.args[5]).toMatch(new RegExp(`/${STAGING_PREFIX}[^/]+/Marver\\.app$`))
    expect(r.ran.filter((x) => x.cmd === '/usr/bin/codesign').map((x) => x.args.slice(0, -1))).toEqual([['--verify', '--deep', '--strict'], ['-d', '-r-'], ['-d', '-r-']])
    // the staging folder: private, on the destination's volume
    const s = r.writes[0]!.staging!
    expect(s.path.startsWith(`${apps}/${STAGING_PREFIX}`)).toBe(true)
    expect(r.writes[1]!.staging!.placeholder).not.toBeNull()
  })

  it('a staging record that cannot be written: nothing copied, the empty folder removed, recorded failed', () => {
    const r = rig()
    r.writeOk = false
    expect(install(r.p)).toBe('failed')
    expect(r.ran).toEqual([])
    expect(stagings()).toEqual([])
    expect(existsSync(dest())).toBe(false)
    expect(whys(r)).toEqual(['failed'])
  })

  it('a copy whose signature or designated requirement does not verify: removed, nothing claimed', () => {
    const r = rig()
    const p = { ...r.p, run: (cmd: string, args: string[]) => (cmd === '/usr/bin/codesign' && args[0] === '-d' && args.at(-1)!.includes(STAGING_PREFIX) ? { code: 0, out: 'designated => identifier "x"' } : r.p.run(cmd, args)) }
    expect(install(p)).toBe('failed')
    expect(stagings()).toEqual([])
    expect(existsSync(dest())).toBe(false)
    expect(r.file.staging).toBeNull()
  })

  it('the relaunch: Electron\'s script, no xattr; the source\'s place for the note', () => {
    const s = relaunchScript(4242, '/Applications/Marver.app')
    expect(s).toBe("while /bin/kill -0 4242; do /bin/sleep 0.1; done; /usr/bin/open '/Applications/Marver.app'")
    expect(s).not.toMatch(/xattr|quarantine/)
    const ro = (v: string) => v === '/Volumes/Marver 1.0.1'
    expect(sourceOf('/Volumes/Marver 1.0.1/Marver.app', '', ro)).toBe('dmg')
    expect(sourceOf('/Users/nic/Downloads/Marver.app', '', ro)).toBe('Downloads')
    const t = '/private/var/folders/xy/abc/T/AppTranslocation/1234-ABCD'
    expect(sourceOf(`${t}/d/Marver.app`, `/dev/disk4s1 on /Volumes/Marver 1.0.1 (hfs, local, read-only)\n/Volumes/Marver 1.0.1 on ${t} (nullfs, local, read-only)\n`, ro)).toBe('dmg')
    expect(sourceOf(`${t}/d/Marver.app`, `/Users/nic/Desktop on ${t} (nullfs, local, read-only)\n`, ro)).toBe('Desktop')
    expect(sourceOf(`${t}/d/Marver.app`, '', ro)).toBe('')
  })
})

describe('the interleavings right after the last look (r3 #1, r4 #4)', () => {
  const putters: [string, () => void][] = [
    ['a bundle', () => bundle(dest(), '0.9.0')],
    ['a link', () => { bundle(join(base, 'Elsewhere', 'Marver.app'), '2.0.0'); symlinkSync(join(base, 'Elsewhere', 'Marver.app'), dest()) }],
    ['a dangling link', () => symlinkSync(join(base, 'nowhere'), dest())],
    ['a file', () => writeFileSync(dest(), 'mine')],
  ]
  for (const [what, put] of putters) {
    it(`${what} put at the destination between the copy and the claim: the claim fails, nothing touched, the Finder route`, async () => {
      const r = rig()
      let before = ''
      r.onVerify = () => { if (!lstatSync(dest(), { throwIfNoEntry: false })) { put(); before = tree(dest()) } }
      r.answer = 'Cancel'
      expect(await offerMove(r.p, { feed: 'f', inApplications: false })).toBe('go-on')
      expect(tree(dest())).toBe(before)
      expect(stagings()).toEqual([])
      expect(r.file.staging).toBeNull()
      expect(r.quits).toBe(0)
      expect(whys(r)).toEqual(['taken', 'finder', 'cancelled'])
    })
  }

  it('a file put inside the placeholder between the claim and the rename: the rename fails, the folder left with it', () => {
    const r = rig()
    r.onWrite = (f) => { if (f.staging?.placeholder) writeFileSync(join(dest(), 'put-there'), 'x') }
    expect(install(r.p)).toBe('failed')
    expect(readdirSync(dest())).toEqual(['put-there'])
    expect(stagings()).toEqual([])
    expect(r.file.staging).toBeNull()
    expect(r.records.at(-1)).toMatchObject({ phase: 'move', why: 'failed', message: 'the publish: ENOTEMPTY' })
  })

  it('the placeholder swapped for another empty folder: replaced by the publish - accepted, nothing lost', () => {
    const r = rig()
    let swapped = 0
    r.onWrite = (f) => { if (f.staging?.placeholder) { rmdirSync(dest()); mkdirSync(dest()); swapped = statSync(dest()).ino } }
    expect(install(r.p)).toBe('moved')
    expect(swapped).not.toBe(0)
    expect(existsSync(join(dest(), 'Contents', 'Info.plist'))).toBe(true)
  })
})

describe('crashes, and the next offer (r3 #2, r4 #5)', () => {
  /** the next launch: the leftover cleaned by its recorded identity, then an install into the slot left empty */
  async function next(r: Rig): Promise<void> {
    expect(await offerMove(r.p, { feed: 'f', inApplications: false })).toBe('quit')
    expect(whys(r)[0]).toBe('cleaned')
    expect(stagings()).toEqual([])
    expect(existsSync(join(dest(), 'Contents', 'Info.plist'))).toBe(true)
  }

  it('halfway through the copy: the partial staging folder removed by its identity', async () => {
    const r = rig()
    const s = stage(r.p)
    mkdirSync(join(s, 'Marver.app', 'Contents'), { recursive: true })
    writeFileSync(join(s, 'Marver.app', 'Contents', 'half'), 'x')
    const r2 = rig({ file: r.file })
    await next(r2)
  })

  it('after the verification: the whole staged bundle removed by its identity', async () => {
    const r = rig()
    const s = stage(r.p)
    copy(r.p, s)
    verify(r.p, s)
    expect(existsSync(join(s, 'Marver.app', 'Contents', 'Info.plist'))).toBe(true)
    await next(rig({ file: r.file }))
  })

  it('after the placeholder\'s identity is written: the staging folder and the empty placeholder removed', async () => {
    const r = rig()
    const s = stage(r.p)
    copy(r.p, s)
    verify(r.p, s)
    expect(claim(r.p)).toBe(true)
    expect(r.file.staging!.placeholder).toEqual({ dev: lstatSync(dest()).dev, ino: lstatSync(dest()).ino })
    await next(rig({ file: r.file }))
  })

  it('a recorded placeholder that came to hold something is left: rmdir fails', () => {
    const r = rig()
    const s = stage(r.p)
    copy(r.p, s)
    claim(r.p)
    writeFileSync(join(dest(), 'kept'), 'x')
    const r2 = rig({ file: r.file })
    expect(cleanLeftover(r2.p)).toBe(true)                      // the staging folder went
    expect(readdirSync(dest())).toEqual(['kept'])
    expect(r2.file.staging).toBeNull()
  })

  it('after mkdtemp, before its identity is written: an empty folder no one deletes; the next install makes its own', async () => {
    const orphan = mkdtempSync(join(apps, STAGING_PREFIX))
    const r = rig()
    expect(await offerMove(r.p, { feed: 'f', inApplications: false })).toBe('quit')
    expect(whys(r)).toEqual(['moved'])
    expect(stagings()).toEqual([orphan.slice(apps.length + 1)])
    expect(readdirSync(orphan)).toEqual([])
  })

  it('after the claim, before its identity is written: the staging cleaned, the empty Marver.app left - the Finder route next time', async () => {
    const r = rig()
    const s = stage(r.p)
    copy(r.p, s)
    mkdirSync(dest())                                            // claimed, the placeholder not yet recorded
    const r2 = rig({ file: r.file })
    r2.answer = 'Cancel'
    expect(await offerMove(r2.p, { feed: 'f', inApplications: false })).toBe('go-on')
    expect(whys(r2)).toEqual(['cleaned', 'finder', 'cancelled'])
    expect(r2.asked[0]!.message).toBe('An empty folder named Marver.app is in Applications')
    expect(readdirSync(dest())).toEqual([])
    expect(stagings()).toEqual([])
  })

  it('another folder at the recorded path is left alone, and the record dropped', () => {
    const r = rig()
    const s = stage(r.p)
    rmSync(s, { recursive: true })
    mkdirSync(s)
    writeFileSync(join(s, 'theirs'), 'x')
    const r2 = rig({ file: r.file })
    expect(cleanLeftover(r2.p)).toBe(false)
    expect(readdirSync(s)).toEqual(['theirs'])
    expect(r2.file.staging).toBeNull()
    expect(r2.records).toEqual([{ phase: 'move', why: 'cleaned', message: 'nothing at the recorded identity' }])
  })

  it('a leftover is cleaned even from a copy in Applications (the moved copy\'s launch), with no offer after', async () => {
    const r = rig()
    const s = stage(r.p)
    copy(r.p, s)
    const r2 = rig({ file: r.file })
    expect(await offerMove(r2.p, { feed: 'f', inApplications: true })).toBe('go-on')
    expect(whys(r2)).toEqual(['cleaned'])
    expect(stagings()).toEqual([])
    expect(r2.asked).toEqual([])
  })
})
