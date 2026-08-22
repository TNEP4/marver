import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyManaged, enumerateInstructionTemplates, hashBody, managedFile,
  MANAGED_PREFIX, LEGACY_PREFIX, staleManagedInstructions, templatesDir,
} from '../src/server/managed.ts'

// a managed file with an arbitrary RECORDED base hash and body (to synthesize each state)
const mk = (recorded: string, body: string) => `${MANAGED_PREFIX}${recorded} - x -->\n${body}`

describe('classifyManaged - mirrors init writeManaged exactly', () => {
  const shipped = 'CURRENT SHIPPED BODY\n'
  const shippedHash = hashBody(shipped)

  it('absent when the file is missing', () => {
    expect(classifyManaged(null, shipped)).toBe('absent')
  })
  it('pristine-current: unedited, recorded == shipped', () => {
    expect(classifyManaged(managedFile(shipped), shipped)).toBe('pristine-current')
  })
  it('pristine-stale: unedited, recorded is an OLD base', () => {
    const old = 'OLD BODY\n'
    // body matches its own recorded hash (pristine) but that base != current shipped
    expect(classifyManaged(managedFile(old), shipped)).toBe('pristine-stale')
  })
  it('edited-current: body edited, recorded == current shipped base', () => {
    expect(classifyManaged(mk(shippedHash, 'MY EDITS'), shipped)).toBe('edited-current')
  })
  it('edited-stale: body edited, recorded is an OLD base', () => {
    expect(classifyManaged(mk(hashBody('OLD\n'), 'MY EDITS'), shipped)).toBe('edited-stale')
  })
  it('malformed managed marker (no newline) -> detached, never throws', () => {
    expect(classifyManaged(`${MANAGED_PREFIX}deadbeef - x -->`, shipped)).toBe('detached')
  })
  it('managed marker with a non-sha256 hash -> detached (mangled, leave it be)', () => {
    expect(classifyManaged(`${MANAGED_PREFIX}not-a-real-hash - x -->\nbody`, shipped)).toBe('detached')
  })
  it('legacy hashless marker -> legacy', () => {
    expect(classifyManaged(`${LEGACY_PREFIX} -->\nanything`, shipped)).toBe('legacy')
  })
  it('no recognizable marker -> detached', () => {
    expect(classifyManaged('# a file the user owns\n', shipped)).toBe('detached')
  })
})

describe('enumerateInstructionTemplates - parity with what init writes', () => {
  const set = enumerateInstructionTemplates(templatesDir())
  const rels = set.map((e) => e.rel)

  it('includes the top-level jam.md (the reported missing file) with a real body', () => {
    const jam = set.find((e) => e.rel === 'instructions/jam.md')
    expect(jam).toBeTruthy()
    expect(jam!.body.length).toBeGreaterThan(0)
  })
  it('includes one level of reference/*.md', () => {
    expect(rels.some((r) => /^instructions\/reference\/[^/]+\.md$/.test(r))).toBe(true)
  })
  it('is .md-only and EXCLUDES setup.md (the SETUP_MD constant, written separately)', () => {
    expect(rels.every((r) => r.endsWith('.md'))).toBe(true)
    expect(rels).not.toContain('instructions/setup.md')
  })
  it('returns [] for a templates dir with no instructions/ (no throw)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mv-tpl-'))
    expect(enumerateInstructionTemplates(empty)).toEqual([])
    rmSync(empty, { recursive: true, force: true })
  })
})

describe('staleManagedInstructions - report only upgrade-behind, never user-owned', () => {
  let root = ''
  const templates = enumerateInstructionTemplates(templatesDir())
  const design = () => join(root, 'design')
  const writeInstr = (rel: string, content: string) => {
    const f = join(design(), rel)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, content)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mv-managed-'))
    mkdirSync(design(), { recursive: true })
    // pristine-current scaffold: AGENTS.md present + every instruction at the shipped body
    writeFileSync(join(design(), 'AGENTS.md'), managedFile('# contract\n'))
    for (const { rel, body } of templates) writeInstr(rel, managedFile(body))
  })
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('a freshly-scaffolded workspace has NO stale files', () => {
    expect(staleManagedInstructions(root)).toEqual([])
  })

  it('a MISSING instruction (jam.md deleted) is reported', () => {
    rmSync(join(design(), 'instructions', 'jam.md'))
    expect(staleManagedInstructions(root)).toContain('jam.md')
  })

  it('a pristine-STALE instruction is reported', () => {
    writeInstr('instructions/jam.md', managedFile('OLD JAM BODY\n'))   // pristine on an old base
    expect(staleManagedInstructions(root)).toContain('jam.md')
  })

  it('an EDITED-CURRENT instruction (forked from current base) is NOT reported', () => {
    const body = templates.find((t) => t.rel === 'instructions/jam.md')!.body
    writeInstr('instructions/jam.md', mk(hashBody(body), 'my local edits'))
    expect(staleManagedInstructions(root)).not.toContain('jam.md')
  })

  it('an EDITED-STALE instruction (forked from an OLD base) IS reported', () => {
    writeInstr('instructions/jam.md', mk(hashBody('OLD\n'), 'my local edits'))
    expect(staleManagedInstructions(root)).toContain('jam.md')
  })

  it('a LEGACY-marker instruction is reported', () => {
    writeInstr('instructions/jam.md', `${LEGACY_PREFIX} -->\nold jam`)
    expect(staleManagedInstructions(root)).toContain('jam.md')
  })

  it('a DETACHED instruction (marker removed) is NOT reported', () => {
    writeInstr('instructions/jam.md', '# I own this now\n')
    expect(staleManagedInstructions(root)).not.toContain('jam.md')
  })

  it('AGENTS.md is reported when ABSENT, not when merely detached', () => {
    rmSync(join(design(), 'AGENTS.md'))
    expect(staleManagedInstructions(root)).toContain('AGENTS.md')
    writeFileSync(join(design(), 'AGENTS.md'), '# user-owned contract, marker deleted\n')
    expect(staleManagedInstructions(root)).not.toContain('AGENTS.md')
  })

  it('never throws on a nonexistent root (returns an array)', () => {
    expect(Array.isArray(staleManagedInstructions(join(root, 'does-not-exist')))).toBe(true)
  })
})
