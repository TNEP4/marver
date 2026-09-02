import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { init } from '../src/cli/init.ts'

/** init tests run against a real temp dir - init is filesystem-in, filesystem-out. */
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mv-init-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host', devDependencies: {} }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const OPTS = { mode: 'studio' as const, demo: false }
const read = (rel: string) => readFileSync(join(root, 'design', rel), 'utf8')

describe('init: Live Jam scaffolding', () => {
  /** A PATH holding exactly these executables - init detects the agent off the real
   *  filesystem, so pin it or the assertion depends on what the machine has installed. */
  const bins: string[] = []
  const withBins = (...names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-bin-'))
    bins.push(dir)
    for (const n of names) { writeFileSync(join(dir, n), '#!/bin/sh\n'); chmodSync(join(dir, n), 0o755) }
    vi.stubEnv('PATH', dir)
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID']) vi.stubEnv(k, '')
    return dir
  }
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const d of bins.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('writes the detected agent into config.ts, armed, at concurrency 6', () => {
    withBins('codex')
    init(root, OPTS)
    expect(read('config.ts')).toContain('jam: { agent: "codex", concurrency: 6 },')
  })
  it('the tool RUNNING init wins - it is the most accurate answer to "which agent is this"', () => {
    withBins('claude', 'codex')
    vi.stubEnv('CODEX_THREAD_ID', 'abc')
    init(root, OPTS)
    expect(read('config.ts')).toContain('jam: { agent: "codex", concurrency: 6 },')
  })
  it('a re-run never claims Live Jam is on - the config already there decides, not fresh detection', () => {
    withBins('claude')
    init(root, OPTS)
    writeFileSync(join(root, 'design', 'config.ts'), 'export default { jam: false }\n')
    const log = vi.mocked(console.log)
    log.mockClear()
    init(root, OPTS)                                  // init preserves the existing config...
    expect(read('config.ts')).toContain('jam: false')  // ...so announcing detection would be a lie
    expect(log.mock.calls.flat().join('\n')).not.toContain('Live Jam is on')
  })
  it('no agent CLI → the block ships commented out, never a broken agent name', () => {
    withBins()
    init(root, OPTS)
    const cfg = read('config.ts')
    expect(cfg).toContain('// jam: { agent: "claude", concurrency: 6 },')
    expect(cfg).not.toMatch(/^\s*jam: \{/m)
  })
  it('scaffolds the jam playbook and routes to it from AGENTS.md', () => {
    init(root, OPTS)
    expect(existsSync(join(root, 'design', 'instructions', 'jam.md'))).toBe(true)
    expect(read('instructions/jam.md')).toContain('marver-reanchor')
    expect(read('AGENTS.md')).toContain('instructions/jam.md')
  })
  it('creates a root CLAUDE.md that @-imports design/AGENTS.md (Claude reads CLAUDE.md)', () => {
    init(root, OPTS)
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('@design/AGENTS.md')
  })
  it('appends the import to an existing CLAUDE.md without clobbering it; idempotent on re-run', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# My project\n\nMy own rules.\n')
    init(root, OPTS)
    const after = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(after).toContain('My own rules.')        // human bytes preserved
    expect(after).toContain('@design/AGENTS.md')     // import appended
    init(root, OPTS)                                  // re-run
    const again = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect((again.match(/@design\/AGENTS\.md/g) ?? []).length).toBe(1)   // not duplicated
  })
})

describe('init: the method layer (0.2.2)', () => {
  it('scaffolds instructions/ with hashed markers, and setup.md in a no-app repo', () => {
    init(root, OPTS)
    for (const f of ['configure', 'discover', 'wireframe', 'brand', 'craft', 'components', 'review', 'boards'])
      expect(read(`instructions/${f}.md`)).toMatch(/^<!-- marver:managed [0-9a-f]{64} /)
    for (const f of ['layout', 'typography', 'color', 'motion', 'copy', 'tune', 'critique', 'states', 'delight', 'operate', 'concepts', 'slop'])
      expect(read(`instructions/reference/${f}.md`)).toMatch(/^<!-- marver:managed [0-9a-f]{64} /)
    expect(read('instructions/setup.md')).toContain('# Setup required')
    expect(read('AGENTS.md')).toContain('design/instructions/setup.md')
    expect(read('AGENTS.md')).toContain('## The method (binding)')
  })

  it('re-init after the app appears: deletes setup.md, regenerates the contract', () => {
    init(root, OPTS)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host', devDependencies: { tailwindcss: '^4.0.0' } }))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.css'), '@import "tailwindcss";')
    init(root, OPTS)
    expect(existsSync(join(root, 'design', 'instructions', 'setup.md'))).toBe(false)
    expect(read('AGENTS.md')).not.toContain('STOP - this repo has no app yet')
    expect(read('AGENTS.md')).toContain("app's Tailwind classes")
  })

  it('managed lifecycle: pristine updates, edits are preserved + staged, detached is untouched', () => {
    const h = (s: string) => createHash('sha256').update(s).digest('hex')
    init(root, OPTS)
    const craft = join(root, 'design', 'instructions', 'craft.md')
    const latest = join(root, 'design', '.local', 'latest', 'instructions', 'craft.md')

    // PRISTINE with an outdated body (hash matches its own body, differs from template) -> updated
    writeFileSync(craft, `<!-- marver:managed ${h('stale\n')} -->\nstale\n`)
    init(root, OPTS)
    expect(read('instructions/craft.md')).toContain('# Craft')

    // EDITED and upstream moved (recorded hash matches neither body nor template) ->
    // body preserved verbatim, fresh version staged, marker bumped to the new base
    // so the note fires once per release
    writeFileSync(craft, `<!-- marver:managed ${h('some old base\n')} -->\n# Craft, but MY version\n`)
    init(root, OPTS)
    expect(read('instructions/craft.md')).toContain('# Craft, but MY version')
    expect(readFileSync(latest, 'utf8')).toContain('# Craft')
    const bumpedHash = read('instructions/craft.md').slice('<!-- marver:managed '.length).split(' ')[0]
    const templateBody = readFileSync(latest, 'utf8')
    expect(bumpedHash).toBe(h(templateBody))
    // ...and the next init is silent for this file (base is now current)
    const warns: string[] = []
    ;(console.warn as any).mockImplementation((m: string) => warns.push(m))
    init(root, OPTS)
    expect(warns.filter((w) => w.includes('instructions/craft.md'))).toEqual([])

    // EDITED but upstream unchanged since their base (recorded hash == template hash)
    // -> preserved, silent, nothing staged
    rmSync(latest)
    const template = read('instructions/discover.md')
    const recorded = template.slice('<!-- marver:managed '.length).split(' ')[0]
    writeFileSync(join(root, 'design', 'instructions', 'discover.md'),
      `<!-- marver:managed ${recorded} -->\nmy tuned discover\n`)
    init(root, OPTS)
    expect(read('instructions/discover.md')).toContain('my tuned discover')
    expect(existsSync(join(root, 'design', '.local', 'latest', 'instructions', 'discover.md'))).toBe(false)

    // DETACHED: marker deleted -> never touched
    writeFileSync(craft, '# my own rules\n')
    init(root, OPTS)
    expect(read('instructions/craft.md')).toBe('# my own rules\n')

    // LEGACY hashless marker (0.2.2-dev era) -> upgraded onto hashed markers
    writeFileSync(craft, '<!-- generated by marver init (older wording) -->\nstale\n')
    init(root, OPTS)
    expect(read('instructions/craft.md')).toMatch(/^<!-- marver:managed [0-9a-f]{64} /)

    // MALFORMED one-line marker file (no newline, no body): bytes must survive
    const weird = '<!-- marver:managed junk with user words and no newline'
    writeFileSync(craft, weird)
    init(root, OPTS)
    expect(read('instructions/craft.md')).toBe(weird)
  })

  it('collision guard: refuses a non-marver design/, allows a marver-shaped one', () => {
    mkdirSync(join(root, 'design'))
    writeFileSync(join(root, 'design', 'assets.txt'), 'not ours')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    expect(() => init(root, OPTS)).toThrow('exit')
    expect(exit).toHaveBeenCalledWith(1)
    // marver-shaped by content: config.ts mentioning marver
    writeFileSync(join(root, 'design', 'config.ts'), '// marver config\nexport default {}\n')
    expect(() => init(root, OPTS)).not.toThrow()
  })

  it('a foreign setup.md is never deleted', () => {
    init(root, OPTS)   // no-app: writes our setup.md
    const setup = join(root, 'design', 'instructions', 'setup.md')
    writeFileSync(setup, 'my personal setup notes\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host', devDependencies: { tailwindcss: '^4.0.0' } }))
    init(root, OPTS)   // app detected - would delete OUR setup.md, must keep theirs
    expect(read('instructions/setup.md')).toBe('my personal setup notes\n')
  })
})

describe('init: onboarding', () => {
  const appify = () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host', devDependencies: { tailwindcss: '^4.0.0' } }))
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.css'), '@import "tailwindcss";')
  }

  it('setup.md is the conversational flow: pitch, two STOPs, the first draft', () => {
    init(root, OPTS)
    const s = read('instructions/setup.md')
    expect(s).toContain('what are we building')
    expect((s.match(/STOP/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(s).toContain('welcome.md')
    expect(s).toContain('#/b/')
  })

  it('a stale marver-authored setup.md is refreshed in place', () => {
    init(root, OPTS)
    const setup = join(root, 'design', 'instructions', 'setup.md')
    writeFileSync(setup, '# Setup required - old template\nrun npx marver init\n')
    init(root, OPTS)   // still no app: ours + stale -> current template
    expect(read('instructions/setup.md')).toContain('what are we building')
  })

  it('setup->app transition refreshes pristine tsconfig.json (standalone -> extends)', () => {
    init(root, OPTS)   // no root tsconfig -> standalone design/tsconfig.json
    expect(read('tsconfig.json')).not.toContain('"extends"')
    appify()
    init(root, OPTS)
    expect(existsSync(join(root, 'design', 'instructions', 'setup.md'))).toBe(false)
    expect(read('tsconfig.json')).toContain('"extends"')
    expect(read('tsconfig.json')).toContain('"@/*"')
  })

  it('setup->app transition never touches an edited tsconfig or providers', () => {
    init(root, OPTS)
    writeFileSync(join(root, 'design', 'tsconfig.json'), '{ "my": "own" }\n')
    writeFileSync(join(root, 'design', 'providers.tsx'), '// mine\n')
    appify()
    init(root, OPTS)
    expect(read('tsconfig.json')).toBe('{ "my": "own" }\n')
    expect(read('providers.tsx')).toBe('// mine\n')
  })

  it('welcome.md ships in instructions/ and AGENTS.md routes to it', () => {
    init(root, OPTS)
    expect(read('instructions/welcome.md')).toMatch(/^<!-- marver:managed [0-9a-f]{64} /)
    expect(read('AGENTS.md')).toContain('instructions/welcome.md')
  })

  it('an edited setup.md is preserved while no-app, and survives the transition', () => {
    init(root, OPTS)
    const setup = join(root, 'design', 'instructions', 'setup.md')
    writeFileSync(setup, readFileSync(setup, 'utf8') + '\nMY NOTES\n')
    init(root, OPTS)   // still no app: edited -> untouched
    expect(readFileSync(setup, 'utf8')).toContain('MY NOTES')
    appify()
    init(root, OPTS)   // app detected: edited -> kept, told to delete manually
    expect(existsSync(setup)).toBe(true)
    expect(readFileSync(setup, 'utf8')).toContain('MY NOTES')
  })
})


describe('v1.5: the living slide list is write-once', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { init } = await import('../src/cli/init.ts')

  it('init appends slides-inspiration/ to a pre-1.5 .gitignore without rewriting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-gi-init-'))
    try {
      mkdirSync(join(root, 'design'), { recursive: true })
      writeFileSync(join(root, 'design', '.gitignore'), '.local/\n.dist/\n# mine\nsecret.env\n')
      init(root, { mode: 'studio', demo: false })
      const gi = readFileSync(join(root, 'design', '.gitignore'), 'utf8')
      expect(gi.startsWith('.local/\n.dist/\n# mine\nsecret.env\n')).toBe(true)   // theirs, untouched
      expect(gi.trim().split('\n').filter((l) => l === 'slides-inspiration/').length).toBe(1)
      init(root, { mode: 'studio', demo: false })                                  // idempotent
      expect(readFileSync(join(root, 'design', '.gitignore'), 'utf8')).toBe(gi)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('init writes design/slides.md once and never overwrites it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv-slides-init-'))
    try {
      init(root, { mode: 'studio', demo: false })
      const p = join(root, 'design', 'slides.md')
      expect(existsSync(p)).toBe(true)
      expect(readFileSync(p, 'utf8')).toContain('this file WINS')
      expect(readFileSync(p, 'utf8')).toContain('## The deck look')   // the fill-in template opens the file
      writeFileSync(p, '# MY NOTES\n')
      init(root, { mode: 'studio', demo: false })
      expect(readFileSync(p, 'utf8')).toContain('MY NOTES')
      // the shipped doctrine template landed too, managed, with its two depth references
      expect(existsSync(join(root, 'design', 'instructions', 'slides.md'))).toBe(true)
      for (const f of ['deck-story', 'deck-layouts'])
        expect(readFileSync(join(root, 'design', 'instructions', 'reference', `${f}.md`), 'utf8')).toMatch(/^<!-- marver:managed [0-9a-f]{64} /)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
