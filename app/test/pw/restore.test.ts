/**
 * Restoring from tabs.json (spec 28 A2.4, A2.12, A2.14 #23, v1.12 r1 #5), end to end on a test home: the canvases
 * running at launch take their saved paths on their own bound origins, only the active tab loads, the file follows
 * the pages (a board change inside a page included) and is written whole; a file of another version is set aside
 * as tabs.json.bad and the app starts as if it were empty.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { launchWindow, sleep, type WindowRun } from '../harness/window.ts'
import { startFakeCanvas, type FakeCanvas } from '../harness/fake-canvas.ts'

let w: WindowRun | undefined
afterAll(async () => { await w?.close() })

const recOf = (f: FakeCanvas) => ({ ...f.record(), file: f.slotFile })

describe('a launch with tabs.json and two canvases running', () => {
  let alpha: FakeCanvas
  let beta: FakeCanvas
  let state: string

  it('the active canvas by (ws, origin) loads its saved path; the other waits, its path kept', async () => {
    w = await launchWindow('pw', {
      prepare: async (env, slotBase) => {
        alpha = await startFakeCanvas({ home: env.home, slotBase, slot: 1, name: 'Alpha' })
        beta = await startFakeCanvas({ home: env.home, slotBase, slot: 2, name: 'Beta' })
        await Promise.all([alpha.ready, beta.ready])
        state = join(env.home, 'state-dev')
        mkdirSync(state, { recursive: true })
        writeFileSync(join(state, 'launched'), '')
        writeFileSync(join(state, 'tabs.json'), JSON.stringify({
          v: 1, active: { kind: 'canvas', ws: beta.ws, origin: beta.origin }, settings: false, closed: [],
          canvases: [
            { ws: alpha.ws, origin: alpha.origin, path: '/#/b/alpha', shownAt: 10 },
            { ws: beta.ws, origin: beta.origin, path: '/index.html#/b/beta', shownAt: 20 },
          ],
        }))
        return { extraEnv: { MARVER_APP_FAKE_ENTRIES: JSON.stringify([recOf(alpha), recOf(beta)]) }, fakes: [alpha, beta] }
      },
    })
    const s = await w.until((x) => !!x.tabs.find((t) => t.reg?.instance === beta.instance)?.doc?.lifted, 10_000, 'Beta restored and lifted')
    const a = s.tabs.find((t) => t.reg?.instance === alpha.instance)!
    const b = s.tabs.find((t) => t.reg?.instance === beta.instance)!
    expect(s.active).toBe(b.id)
    expect(b.doc!.url).toBe(`${beta.origin}/index.html#/b/beta`)
    expect(a).toMatchObject({ hasView: false, path: '/#/b/alpha', open: true })
    expect(alpha.requests.some((r) => r.path === '/')).toBe(false)
  })

  it('the other loads on its saved board when first shown', async () => {
    const s0 = await w!.state()
    const a = s0.tabs.find((t) => t.reg?.instance === alpha.instance)!
    await w!.run.call('activate', { id: a.id })
    const s = await w!.until((x) => !!x.tabs.find((t) => t.id === a.id)?.doc?.lifted, 10_000, 'Alpha lifted')
    expect(s.tabs.find((t) => t.id === a.id)!.doc!.url).toBe(`${alpha.origin}/#/b/alpha`)
  })

  it('a board change inside the page is kept, and the file is written whole within its debounce', async () => {
    const a = (await w!.state()).tabs.find((t) => t.reg?.instance === alpha.instance)!
    await w!.run.call('exec', { target: a.id, js: "location.hash = '#/b/other'; 1" })
    await w!.until((x) => x.tabs.find((t) => t.id === a.id)!.path === '/#/b/other', 3000, 'the path to follow the page')
    await sleep(1500)
    const file = JSON.parse(readFileSync(join(state, 'tabs.json'), 'utf8'))
    expect(file.active).toEqual({ kind: 'canvas', ws: alpha.ws, origin: alpha.origin })
    expect(file.canvases.find((c: { ws: string }) => c.ws === alpha.ws).path).toBe('/#/b/other')
    expect(file.canvases.find((c: { ws: string }) => c.ws === beta.ws).path).toBe('/index.html#/b/beta')
  })

  it('a tab closed for its canvas\'s run is kept closed in the file', async () => {
    const b = (await w!.state()).tabs.find((t) => t.reg?.instance === beta.instance)!
    await w!.report(b.id, { unsaved: false })
    expect(await w!.run.call('close', { id: b.id })).toBe('closed')
    await sleep(1500)
    const file = JSON.parse(readFileSync(join(state, 'tabs.json'), 'utf8'))
    expect(file.closed).toEqual([{ ws: beta.ws, instance: beta.instance }])
    await w!.close()
    w = undefined
  })
})

describe('a tabs.json of another version', () => {
  it('goes aside as tabs.json.bad; the app starts on Home with every running canvas at /', async () => {
    let alpha!: FakeCanvas
    let state = ''
    w = await launchWindow('pw', {
      prepare: async (env, slotBase) => {
        alpha = await startFakeCanvas({ home: env.home, slotBase, slot: 3, name: 'Alpha' })
        await alpha.ready
        state = join(env.home, 'state-dev')
        mkdirSync(state, { recursive: true })
        writeFileSync(join(state, 'launched'), '')
        writeFileSync(join(state, 'tabs.json'), JSON.stringify({ v: 2, active: { kind: 'settings' } }))
        return { extraEnv: { MARVER_APP_FAKE_ENTRIES: JSON.stringify([recOf(alpha)]) }, fakes: [alpha] }
      },
    })
    const s = await w.until((x) => x.tabs.some((t) => t.reg?.instance === alpha.instance), 5000, 'the canvas tab')
    expect(s.active).toBe('home')
    expect(s.tabs.find((t) => t.reg?.instance === alpha.instance)!.path).toBe('/')
    expect(existsSync(join(state, 'tabs.json.bad'))).toBe(true)
    expect(JSON.parse(readFileSync(join(state, 'tabs.json.bad'), 'utf8')).v).toBe(2)
  })
})
