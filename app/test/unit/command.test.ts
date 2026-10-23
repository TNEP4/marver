/** The start command (src/shared/command.ts; spec 28 A2.11, A2.12, A2.14 #24): copied with the full path quoted, shown with ~. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXED_COMMANDS, shq, startCommand, startCommandShown, tilde } from '../../src/shared/command.ts'
import { hueOf, HUES, initials } from '../../src/shared/hue.ts'

describe('startCommand()', () => {
  it('quotes the full real path for the shell, with --port for a port of its own', () => {
    expect(startCommand({ root: '/Users/nic/tms broker' })).toBe(`cd '/Users/nic/tms broker' && npx marver dev`)
    expect(startCommand({ root: "/Users/x/it's here" })).toBe(`cd '/Users/x/it'\\''s here' && npx marver dev`)
    expect(startCommand({ root: '/Users/x/a', port: 5298 })).toBe(`cd '/Users/x/a' && npx marver dev --port 5298`)
    expect(startCommand({ root: '/Users/x/a', port: null })).toBe(`cd '/Users/x/a' && npx marver dev`)
  })

  it('round-trips a root holding a quote, a space and a dollar through sh', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mvapp-cmd-')))
    const root = join(base, `it's $HOME "here"`)
    mkdirSync(root)
    try {
      const cmd = startCommand({ root }).replace(' && npx marver dev', ' && pwd')
      expect(execFileSync('/bin/sh', ['-c', `eval "$1"`, 'sh', cmd], { encoding: 'utf8' }).trim()).toBe(root)
    } finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('is shown with ~ outside the quotes, so it still runs as shown', () => {
    expect(startCommandShown({ root: '/Users/nic/tms-broker' }, '/Users/nic')).toBe('cd ~/tms-broker && npx marver dev')
    expect(startCommandShown({ root: '/Users/nic/tms broker' }, '/Users/nic')).toBe(`cd ~/'tms broker' && npx marver dev`)
    expect(startCommandShown({ root: '/opt/canvas', port: 4900 }, '/Users/nic')).toBe('cd /opt/canvas && npx marver dev --port 4900')
    expect(startCommandShown({ root: '/Users/nic' }, '/Users/nic')).toBe('cd ~ && npx marver dev')
  })

  it('tilde() shortens only a path under the home folder', () => {
    expect(tilde('/Users/nic/x', '/Users/nic')).toBe('~/x')
    expect(tilde('/Users/nicola/x', '/Users/nic')).toBe('/Users/nicola/x')
    expect(tilde('/Users/nic/x', '/Users/nic/')).toBe('~/x')
  })

  it('shq() quotes for a POSIX shell', () => expect(shq(`a'b`)).toBe(`'a'\\''b'`))

  it('the three fixed commands Home copies', () => {
    expect(FIXED_COMMANDS).toEqual({
      dev: 'npx marver dev',
      init: 'npm i -D @marver-design/marver && npx marver init',
      update: 'npm i -D @marver-design/marver@latest',
    })
  })
})

describe('initials and hues (A2.4)', () => {
  it('the first letters of up to two words', () => {
    expect(initials('TMS broker')).toBe('TB')
    expect(initials('tidewell')).toBe('T')
    expect(initials('Marver Platform canvas')).toBe('MP')
    expect(initials('localhost:4808')).toBe('L4')
    expect(initials('  ')).toBe('?')
    expect(initials('élan vital')).toBe('ÉV')
  })

  it('a hue stable per key, one of eight', () => {
    expect(hueOf('0123456789abcdef')).toBe(hueOf('0123456789abcdef'))
    const seen = new Set(Array.from({ length: 200 }, (_, i) => hueOf(`ws${i}`)))
    expect([...seen].every((h) => h >= 0 && h < HUES.length)).toBe(true)
    expect(seen.size).toBe(8)
  })
})
