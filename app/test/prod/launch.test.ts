/**
 * The production-switch harness (spec 28 A2.10, A2.14 #27): the real Electron binary with the app folder and
 * nothing else - no Playwright loader, none of its switches - driven over the control socket (mode 600). The
 * hang, one copy of each guard case, hidden tabs and the memory budget run here.
 */
import { statSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchProd, type AppRun } from '../harness/app.ts'
import { NIC_PROFILES, runSlotBase, snapshot, testEnv, type TestEnv } from '../harness/env.ts'

interface Ping { name: string; pid: number; argv: string[]; switches: string[]; userData: string; ready: boolean }

let env: TestEnv
let run: AppRun
const nicBefore = NIC_PROFILES.map(snapshot)
beforeAll(async () => {
  env = testEnv(runSlotBase())
  run = await launchProd(env)
})
afterAll(async () => {
  await run?.close()
  env?.cleanup()
})

describe('the dev build with the production switches', () => {
  it('answers on its control socket, mode 600', async () => {
    const p = await run.call<Ping>('ping')
    expect(p).toMatchObject({ name: 'Marver Dev', pid: run.pid, ready: true, userData: env.userData })
    expect(statSync(env.control).mode & 0o777).toBe(0o600)
  })

  it('carries none of Playwright\'s switches: the hang monitor, backgrounding and debugging stay as in production', async () => {
    const p = await run.call<Ping>('ping')
    expect(p.switches).toEqual([])
    expect(p.argv.slice(1)).toEqual([expect.stringMatching(/\/app$/)])
  })

  it('a hook that does not exist is refused by name', async () => {
    await expect(run.call('no-such-hook')).rejects.toThrow(/no hook named no-such-hook/)
  })

  it('quits with 0 and leaves Nic\'s profiles as they were', async () => {
    expect(await run.close()).toBe(0)
    expect(NIC_PROFILES.map(snapshot)).toEqual(nicBefore)
  })
})
