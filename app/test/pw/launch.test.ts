/**
 * The Playwright harness (spec 28 A2.10, A2.14 #27): the dev build under Playwright's Electron driver, on a
 * profile and home of its own. One case per harness to start the others from: the wiring is there, and the
 * switches Playwright's loader adds are visible - the reason the production-switch harness exists.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchPW, type AppRun } from '../harness/app.ts'
import { NIC_PROFILES, runSlotBase, snapshot, testEnv, type TestEnv } from '../harness/env.ts'

interface Ping { name: string; version: string; electron: string; userData: string; crashDumps: string; switches: string[]; env: Record<string, string>; ready: boolean }

let env: TestEnv
let run: AppRun
const nicBefore = NIC_PROFILES.map(snapshot)
beforeAll(async () => {
  env = testEnv(runSlotBase())
  run = await launchPW(env)
})
afterAll(async () => {
  await run?.close()
  env?.cleanup()
})

describe('the dev build under Playwright', () => {
  it('starts as Marver Dev on its own profile and home', async () => {
    const p = await run.call<Ping>('ping')
    expect(p).toMatchObject({ name: 'Marver Dev', version: '0.1.0', electron: '45.0.0', ready: true, userData: env.userData })
    expect(p.env.MARVER_HOME).toBe(env.home)
    expect(p.crashDumps).toBe(join(env.home, 'perf', 'crashpad'))
    expect(statSync(join(env.home, 'perf', 'crashpad')).mode & 0o777).toBe(0o700)
    expect(existsSync(join(env.userData, 'SingletonLock')) || existsSync(join(env.userData, 'SingletonSocket'))).toBe(true)
  })

  it('runs main\'s startup in order: the home, then ready', async () => {
    const log = await run.call<{ topic: string; turn: number; data: { step: string } }[]>('log')
    const steps = log.filter((l) => l.topic === 'startup').map((l) => l.data.step)
    expect(steps).toEqual(['home', 'ready'])
  })

  it('carries Playwright\'s own switches - the hang monitor off among them', async () => {
    const p = await run.call<Ping>('ping')
    expect(p.switches).toContain('disable-hang-monitor')
    expect(p.switches).toContain('remote-debugging-port')
  })

  it('quits with 0 and leaves Nic\'s profiles as they were', async () => {
    expect(await run.close()).toBe(0)
    expect(NIC_PROFILES.map(snapshot)).toEqual(nicBefore)
  })
})
