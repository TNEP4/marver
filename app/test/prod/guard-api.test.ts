/**
 * Chromium's own beforeunload behind each act of the guard, each API on its own (spec 28 A2.10, A2.14 #16, #31,
 * v1.13 r2 #4), in the production-switch harness - Playwright's loader turns a beforeunload check off. Every case
 * starts from a fresh, clean record, so main asks nothing and the page's beforeunload is the only veto: what
 * Chromium honours is what this records, for `close({ waitForBeforeUnload: true })`, `reload()`,
 * `reloadIgnoringCache()` and `loadURL()`, against a page that refuses with no gesture since it loaded, one that
 * refuses after a gesture, and one whose renderer is busy (hung) when the act comes. The outcomes are printed and
 * asserted; r2 #4's words are checked against them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hits, launchWindow, MAY_LEAVE, REFUSE_UNLOAD, scripted, sleep, type WindowRun } from '../harness/window.ts'
import type { FakeCanvas } from '../harness/fake-canvas.ts'

let w: WindowRun
beforeAll(async () => { w = await launchWindow('prod') })
afterAll(async () => {
  process.stdout.write(`r2 #4 outcomes (Electron 45): ${JSON.stringify(outcomes, null, 1)}\n`)
  for (const t of (await w.state().catch(() => ({ tabs: [] as { id: string; kind: string; hasView: boolean }[] }))).tabs) {
    if (t.kind === 'local' && t.hasView) await w.run.call('exec', { target: t.id, js: MAY_LEAVE }).catch(() => {})
  }
  await w?.close()
})

type Api = { kind: 'close' } | { kind: 'reload' } | { kind: 'forceReload' } | { kind: 'load'; url: string }
const outcomes: Record<string, string> = {}

async function lifted(id: string, over: number) {
  await w.until((x) => { const t = x.tabs.find((q) => q.id === id); return !!t?.doc?.lifted && t.doc.commits > over && t.retained }, 10_000, `${id} lifted`)
}
async function shown(slot: number, script = REFUSE_UNLOAD): Promise<{ id: string; fake: FakeCanvas }> {
  const c = await w.canvas({ slot, script })
  await w.run.call('activate', { id: c.id })
  await lifted(c.id, 0)
  await scripted(c.fake)
  await w.report(c.id, { unsaved: false })   // fresh and clean: no sheet, the act at once
  return c
}
const gesture = (id: string) => w.run.call('exec', { target: id, js: 'document.body.click(); 1', gesture: true })
const commits = async (id: string) => (await w.tab(id)).doc?.commits ?? 0
const act = (id: string, a: Api) => a.kind === 'close' ? w.run.call<string>('close', { id }) : w.run.call<string>('guard', { id, action: a })
const went = (a: Api, answer: string) => a.kind === 'close' ? answer === 'closed' : answer === 'done'

describe('a page that refuses: with no gesture since it loaded, then after one (r2 #4)', () => {
  const apis: [string, number, (origin: string, n: number) => Api, boolean][] = [
    // name, slot, the act, whether r2 #4 says a refusal with no gesture holds
    ['close', 1, () => ({ kind: 'close' }), true],
    ['reload', 2, () => ({ kind: 'reload' }), false],
    ['forceReload', 3, () => ({ kind: 'forceReload' }), false],
    ['loadURL', 4, (o, n) => ({ kind: 'load', url: n === 0 ? `${o}/index.html#/b/other` : `${o}/#/b/again` }), false],
  ]
  for (const [name, slot, api, holdsWithNone] of apis) {
    it(`${name}: ${holdsWithNone ? 'refused with no gesture' : 'Chromium goes on with no gesture'}; refused after one`, async () => {
      const { id, fake } = await shown(slot)
      // no gesture since load
      const before = await commits(id)
      const a0 = api(fake.origin, 0)
      const none = await act(id, a0)
      outcomes[`${name}, no gesture`] = went(a0, none) ? 'went on' : 'refused'
      expect(went(a0, none)).toBe(!holdsWithNone)
      if (holdsWithNone) {
        await sleep(300)
        expect(await commits(id)).toBe(before)
        expect(hits(fake, '/__mv/test/beforeunload')).toBeGreaterThanOrEqual(1)
      } else {
        await lifted(id, before)   // the new document: its own script, its own report
        await scripted(fake, 2)
        await w.report(id, { unsaved: false })
      }
      // after a gesture
      await gesture(id)
      const mid = await commits(id)
      const a1 = api(fake.origin, 1)
      const after = await act(id, a1)
      await sleep(300)
      outcomes[`${name}, after a gesture`] = went(a1, after) ? 'went on' : 'refused'
      expect(went(a1, after)).toBe(false)
      expect(await commits(id)).toBe(mid)
      expect((await w.tab(id)).hasView).toBe(true)
    })
  }
})

describe('a renderer busy when the act comes (hung)', () => {
  it('each API on its own canvas, all at once: what Chromium does past a renderer that does not answer its beforeunload', async () => {
    const tabs: { name: string; id: string; fake: FakeCanvas; a: Api }[] = []
    const apis: [string, number, (origin: string) => Api][] = [
      ['close', 5, () => ({ kind: 'close' })],
      ['reload', 6, () => ({ kind: 'reload' })],
      ['forceReload', 7, () => ({ kind: 'forceReload' })],
      ['loadURL', 8, (o) => ({ kind: 'load', url: `${o}/index.html#/b/other` })],
    ]
    for (const [name, slot, api] of apis) {
      const c = await shown(slot)
      await gesture(c.id)   // its refusal would hold if Chromium heard it
      tabs.push({ name, ...c, a: api(c.fake.origin) })
    }
    // a 12 s busy loop in each, run synchronously (not awaited: the call answers when it ends) - and seen silent
    // by main before any act, so every act meets a renderer that cannot answer
    for (const t of tabs) void w.run.call('exec', { target: t.id, js: 'var e = Date.now() + 12000; while (Date.now() < e) {} 1' }).catch(() => {})
    for (const t of tabs) {
      let silent = false
      for (let i = 0; i < 20 && !silent; i++) silent = !!(await w.run.call<boolean | null>('silent', { target: t.id, ms: 300 }))
      expect(silent, `${t.name}'s page busy`).toBe(true)
    }
    const start = Date.now()
    const answers = await Promise.all(tabs.map(async (t) => ({ t, answer: await act(t.id, t.a), ms: Date.now() - start })))
    for (const { t, answer, ms } of answers) outcomes[`${t.name}, hung`] = `${went(t.a, answer) ? 'went on' : 'refused'} after ${(ms / 1000).toFixed(1)} s`
    // the guard's act answers by itself, within its own bound, whatever Chromium does
    for (const { ms } of answers) expect(ms).toBeLessThan(60_000)
    // r2 #4: "a hung page's [refusal] never holds" - every act went on
    for (const { t, answer } of answers) expect(went(t.a, answer), `${t.name}, hung`).toBe(true)
  }, 100_000)
})
