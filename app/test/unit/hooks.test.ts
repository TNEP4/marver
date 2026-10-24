/**
 * The test hooks' registry (spec 28 A2.14 #27, A3.8 #53; src/main/testing/index.ts), without Electron: a name is
 * provided once. A second registration never replaces the first and never throws at launch (a throw in main there
 * would end every case of the build with Electron's error box): calling that name fails, naming both places that
 * provided it - the streams that collide find out at the first case that calls it, and which they are.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getName: () => 'Marver Dev', getVersion: () => '0.2.0', getPath: () => '/nowhere', isReady: () => true, commandLine: { hasSwitch: () => false }, exit: () => {}, quit: () => {} } }))

const was = process.env.MARVER_APP_TEST
let hooks: typeof import('../../src/main/testing/index.ts')
beforeAll(async () => {
  process.env.MARVER_APP_TEST = '1'
  hooks = await import('../../src/main/testing/index.ts')
})
afterAll(() => {
  if (was === undefined) delete process.env.MARVER_APP_TEST
  else process.env.MARVER_APP_TEST = was
})

describe('provide (testing/index.ts)', () => {
  it('a name provided once is called', async () => {
    hooks.provide('t:once', (a) => ({ got: a }))
    expect(await hooks.callHook('t:once', 3)).toEqual({ got: 3 })
  })

  it('a name provided twice: no throw at either registration; calling it fails, naming both providers; other hooks work on', async () => {
    const said: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s) => { said.push(String(s)); return true })
    try {
      function memoryStream() { hooks.provide('t:twice', () => 'memory') }
      function recorderStream() { hooks.provide('t:twice', () => 'recorder') }
      expect(() => memoryStream()).not.toThrow()
      expect(() => recorderStream()).not.toThrow()
      expect(said.join('')).toMatch(/the hook t:twice is provided twice: .*memoryStream.*; .*recorderStream/)
    } finally { spy.mockRestore() }
    await expect(hooks.callHook('t:twice', null)).rejects.toThrow(/t:twice is provided twice, so neither is called: .*memoryStream.*; .*recorderStream/)
    expect(await hooks.callHook('t:once', 4)).toEqual({ got: 4 })
  })

  it('without MARVER_APP_TEST=1, nothing is provided', async () => {
    process.env.MARVER_APP_TEST = '0'
    try { hooks.provide('t:off', () => 1) } finally { process.env.MARVER_APP_TEST = '1' }
    await expect(hooks.callHook('t:off', null)).rejects.toThrow(/no hook named t:off/)
  })
})
