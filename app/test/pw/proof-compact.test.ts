/**
 * Spec 32 G4b: H2.5's compact-tab proof, windowless (the page harness's proof route, test/proofs/s32-compact.*):
 * 12 tabs at 1280 and at 720 wide, light and dark, 1x and 2x, with "99+" and ⌘N on some. Nic's call (I2): compact
 * under 104 px, the 84 px floor, then ». The shots go to app/test/.proofs/s32/compact/ (gitignored) with a contact
 * sheet; the geometry the look rests on is asserted here (A2's concentric ends, A3's widths, A4's »).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_DIR } from '../harness/app.ts'
import { openProof, type PageRun } from '../harness/pages.ts'

const OUT = join(APP_DIR, 'test', '.proofs', 's32', 'compact')
const HEIGHT = 6 + 3 * (22 + 44) + 10
type Tab = { i: number; on: boolean; width: number; compact: boolean; nameShown: boolean; logoLeft: number; badgeRight: number | null; inside: boolean }
type Strip = { more: string | null; tabs: Tab[] }
type Proof = { render(): Promise<void>; geometry(): Strip[]; look(dark: boolean): Promise<void> }
const proof = (p: PageRun) => ({
  render: () => p.page.evaluate(() => (window as unknown as { proof: Proof }).proof.render()),
  geometry: () => p.page.evaluate(() => (window as unknown as { proof: Proof }).proof.geometry()),
  look: (dark: boolean) => p.page.evaluate((d) => (window as unknown as { proof: Proof }).proof.look(d), dark),
})
const shots: string[] = []

for (const dpr of [1, 2] as const) {
  describe(`compact tabs at ${dpr}x (H2.5)`, () => {
    let p: PageRun
    beforeAll(async () => {
      mkdirSync(OUT, { recursive: true })
      p = await openProof('s32-compact.html', { bundle: 's32-compact.ts', width: 1280, height: HEIGHT, dpr })
      await p.page.waitForFunction(() => document.body.dataset.ready === '1')
    })
    afterAll(async () => { await p?.close() })

    for (const width of [1280, 720]) {
      it(`${width} wide: compact under 104 px, ends concentric, the floor 84, then »; shot light and dark`, async () => {
        await p.resize(width, HEIGHT)
        await proof(p).render()
        expect(await p.page.evaluate(() => devicePixelRatio)).toBe(dpr)
        const [active, homeOn, onBadge] = await proof(p).geometry()
        for (const strip of [active, homeOn, onBadge]) {
          for (const t of strip.tabs) {
            // A2: compact exactly when the width is under 104; the logo 4 px from the face's left in every tab
            expect(t.compact, `tab ${t.i}`).toBe(t.width < 104)
            expect(t.nameShown, `tab ${t.i}`).toBe(!t.compact)
            expect(t.logoLeft, `tab ${t.i}`).toBeCloseTo(4, 1)
            // the badge 7 px from the face's right, compact or not (no centring)
            if (t.badgeRight !== null) expect(t.badgeRight, `tab ${t.i}`).toBeCloseTo(7, 1)
            // every child of the face inside its content box, "99+" and ⌘N included
            expect(t.inside, `tab ${t.i}`).toBe(true)
            expect(t.width, `tab ${t.i}`).toBeGreaterThanOrEqual(84 - 0.01)
            expect(t.width, `tab ${t.i}`).toBeLessThanOrEqual(t.on ? 260 : 176)
          }
          const rest = strip.tabs.filter((t) => !t.on).map((t) => t.width)
          expect(Math.max(...rest) - Math.min(...rest)).toBeLessThan(0.01)
        }
        if (width === 1280) {
          // 12 fit at the floor: no », every inactive tab compact, the active one wide enough for its name
          expect(active.more).toBeNull()
          expect(active.tabs).toHaveLength(12)
          expect(active.tabs.filter((t) => !t.on).every((t) => t.compact)).toBe(true)
          expect(active.tabs.find((t) => t.on)).toMatchObject({ i: 2, compact: false, nameShown: true })
          expect(homeOn.tabs.every((t) => !t.on && t.compact)).toBe(true)
        } else {
          // 720: six stay and » holds six; with a canvas tab active it stays, with Home on the first six
          expect(active.more).toBe('6')
          expect(active.tabs.map((t) => t.i)).toEqual([0, 1, 2, 3, 4, 5])
          expect(homeOn.more).toBe('6')
          expect(homeOn.tabs.map((t) => t.i)).toEqual([0, 1, 2, 3, 4, 5])
        }
        for (const dark of [false, true]) {
          await proof(p).look(dark)
          const file = `compact-${width}-${dark ? 'dark' : 'light'}@${dpr}x.png`
          await p.page.screenshot({ path: join(OUT, file) })
          shots.push(file)
        }
        await proof(p).look(false)
        expect(await p.csp()).toEqual([])
      })
    }
  })
}

afterAll(() => {
  if (!shots.length) return
  const cells = shots.sort().map((f) => `<figure><img src="${f}" alt="${f}"><figcaption>${f}</figcaption></figure>`).join('\n')
  writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Compact tabs - spec 32 H2.5</title>
<style>body{font:13px -apple-system,sans-serif;margin:24px;background:#f4f5f8;color:#18181b}figure{margin:0 0 28px}img{display:block;max-width:100%;height:auto;box-shadow:0 0 0 1px rgba(0,0,0,.1)}figcaption{margin-top:6px;color:#55575f}</style>
<h1>Compact tabs (spec 32 H2.5, G4b)</h1><p>12 tabs at 1280 and 720 wide, light and dark, 1x and 2x. Compact under 104 px, the 84 px floor, then » (Nic, I2). Row 1: a canvas tab active, another hovered (⌘N). Row 2: Home on. Row 3: a hover on the 99+ badge.</p>
${cells}
`)
})
