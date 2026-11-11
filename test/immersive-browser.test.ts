import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Browser } from './browser.ts'
import { fixtureRoot, startDev, type Dev } from './dev-server.ts'
import { MOTION } from '../src/shared/immersive.ts'

/**
 * Immersive play in the shell (spec 32 C1, C3-C7; H1's package row), against a REAL `marver dev` and a REAL Chrome
 * whose page gets a fake `window.marverApp` before any script runs: app 1.2's canvas preload as the shell sees it -
 * `topInset: 44` with the presentation contract, `immersive` (the wish, logged) and `onImmersive` (main's answer, which
 * the test gives). Checked: H in play sends the wish and nothing moves before the answer; `{on: true}` drops the play
 * inset (`--mv-play-top` 0, `--mv-top` 44) and takes the 24 px margins in one refit, the stage growing (a slide, a
 * device; a phone at scale 1 not); a refusal keeps the inset and Hide UI with the margins; an app without `immersive`
 * (1.1) and Chrome take the margins and the fades at once, the inset staying; the stopped state alone drops the wish;
 * H off restores both in one refit; leaving play from code keeps Hide UI, re-entering goes immersive at once; an `end`
 * in play turns Hide UI off and after play does not; Escape, `hidden` and `untrusted` end it; the FLIP (fixed stages
 * only, `.dev`'s own transition off, a reversal ending at the right size); the minimal deck's strip fades centred; the
 * play pills fade rather than vanish; canvas-mode Hide UI sends nothing; a board with no way out shows the UI on
 * Escape; the recorder's `immersive` mode (C11): an enter at main's grant (never at the wish or a refusal), an exit with
 * its heldMs at the revoke, and a grant standing when the signals start held from there. Skips without Chrome.
 */

const FRAME = (t: string, vp: string, bg: string) => `export const meta = { title: '${t}', viewport: '${vp}' }\nexport default () => <main style={{ background: '${bg}', width: '100%', height: '100vh', margin: 0 }} />\n`
const SLIDE = (t: string) => `export const meta = { title: '${t}', slide: true }\nexport default () => <main style={{ background: '#335', width: 1280, height: 720 }}><h1>${t}</h1></main>\n`
const nodes = (frames: string[]) => frames.map((f, i) => ({ key: `n${i}`, frame: f, x: i * 2000, y: 0, w: 640, h: 400 }))
const board = (name: string, frames: string[], order: number) => JSON.stringify({ version: 1, name, order, auto: false, nodes: nodes(frames) })

let root = ''
let dev: Dev | null = null
let browser: Browser | null = null
const tabs: string[] = []

beforeAll(async () => {
  root = fixtureRoot('mv-immersive-', {
    'design/config.ts': `export default { share: { name: 'Immersive canvas' } }\n`,
    'design/scenes/demo/big.tsx': FRAME('Big', 'monitor', '#ff0000'),
    'design/scenes/demo/phone.tsx': FRAME('Phone', 'mobile', '#2244ff'),
    'design/scenes/deck/s1.tsx': SLIDE('One'),
    'design/scenes/deck/s2.tsx': SLIDE('Two'),
    'design/boards/main.json': board('main', ['demo/big', 'demo/phone'], 0),
    'design/boards/deck.json': board('deck', ['deck/s1', 'deck/s2'], 1),
    'design/boards/mini.json': board('mini', ['deck/s1', 'deck/s2'], 2),
    'design/boards/bare.json': board('bare', ['deck/s1', 'deck/s2'], 3),
    'design/boards/lockd.json': board('lockd', ['demo/big'], 4),
    'design/publish.json': JSON.stringify({ version: 2, boards: {
      deck: { max: 'read', type: 'slides' },
      mini: { max: 'read', type: 'slides', chrome: 'minimal' },
      bare: { max: 'read', type: 'slides', chrome: 'none' },
      lockd: { max: 'read', open: 'present', lock: true },
    } }),
  })
  dev = await startDev(root)
  browser = await Browser.launch()
}, 120_000)
afterEach(async () => { for (const s of tabs.splice(0)) await browser?.closeTab(s).catch(() => {}) })
afterAll(async () => {
  browser?.close()
  await dev?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The fake bridge, at document start. `inset`: mv:doc's answer; `immersive`: app 1.2's two methods given. */
type Fake = { on: boolean; inset?: 0 | 44; immersive?: boolean }
const FAKE = (cfg: Fake) => `(() => {
  const cfg = ${JSON.stringify(cfg)}
  if (!cfg.on) return
  const log = [], states = new Set(), answers = new Set()
  const say = (ch) => (p) => { log.push([ch, JSON.parse(JSON.stringify(p))]) }
  const api = { v: 1, topInset: cfg.inset ?? 44, reopen: false, hello: say('hello'), theme: say('theme'), busy: say('busy'), menu: say('menu'),
    onAppState: (fn) => { states.add(fn); return () => states.delete(fn) }, onMenuClick: () => () => {},
    onPresent: () => () => {}, presented: () => {} }
  if (cfg.immersive) {
    api.immersive = say('immersive')
    api.onImmersive = (fn) => { answers.add(fn); return () => answers.delete(fn) }
  }
  window.marverApp = Object.freeze(api)
  window.__fake = {
    wishes: () => log.filter(([c]) => c === 'immersive').map(([, p]) => p),
    answer: (s) => { for (const f of answers) f(s) },
    appState: (s) => { for (const f of states) f(s) },
  }
})()`

async function open(cfg: Fake, hash: string, size = { width: 1400, height: 1100 }): Promise<string> {
  const s = await browser!.tab(size)
  tabs.push(s)
  await browser!.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE(cfg) }, s)
  await browser!.go(s, `${dev!.origin}/${hash}`)
  if (hash.startsWith('#/p/')) await browser!.until(s, `!!window.__mvStore && !!__mvStore.getState().play && !!document.querySelector('.sh-play-stage .dev iframe')`, 30_000)
  else await browser!.until(s, `!!window.__mvStore && __mvStore.getState().nodes.length > 0 && __mvStore.getState().nodes.every((n) => n.status === 'ready')`, 30_000)
  await browser!.send('Page.bringToFront', {}, s)
  await wait(500)   // play's fade-in
  return s
}
const ev = (s: string, js: string) => browser!.eval(s, js)
const until = (s: string, js: string, ms = 5_000) => browser!.until(s, js, ms)
const skip = (ctx: { skip: () => void }) => { if (!browser) ctx.skip() }
const key = async (s: string, k: string) => {
  if (k === 'Escape') {
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s)
    await browser!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s)
  } else await browser!.press(s, k)
}
/** the stage's laid-out size (its transform, a FLIP, never counts) */
const size = (s: string): Promise<{ w: number; h: number }> => ev(s, `(() => { const c = getComputedStyle(document.querySelector('.sh-play-stage')); return { w: parseFloat(c.width), h: parseFloat(c.height) } })()`)
const rootVar = (s: string, v: string) => ev(s, `document.documentElement.style.getPropertyValue(${JSON.stringify(v)})`)
const hidden = (s: string) => ev(s, `document.body.classList.contains('sh-hide-ui')`)
const wishes = (s: string): Promise<{ on: boolean }[]> => ev(s, `__fake.wishes()`)
const answer = (s: string, a: { on: boolean; end?: true }) => ev(s, `(__fake.answer(${JSON.stringify(a)}), 1)`)
/** counts every `.flip` the play root takes from now on */
/** ...and each FLIP's start - `.flip` coming on, a restart's off-and-on in one task too: the stage's rendered width
 *  then (its first frame, the size it starts from) */
const watchFlips = (s: string) => ev(s, `(() => { window.__flips = 0; window.__devT = []; window.__flipW = []; new MutationObserver((rs) => { const on = !!document.querySelector('.sh-play.flip'); if (on) { __flips++; __devT.push(getComputedStyle(document.querySelector('.sh-play .dev')).transitionDuration) } const added = rs.filter((r) => !/\\bflip\\b/.test(r.oldValue ?? '')).length; if (on && added) __flipW.push(document.querySelector('.sh-play-stage').getBoundingClientRect().width) }).observe(document.querySelector('.sh-play'), { attributes: true, attributeFilter: ['class'], attributeOldValue: true }); return 1 })()`)

/** H in play, and main's grant: immersive, the stage grown */
async function grant(s: string): Promise<void> {
  const n = (await wishes(s)).length
  await key(s, 'h')
  await until(s, `__fake.wishes().length === ${n + 1} && __fake.wishes().at(-1).on === true`)
  await answer(s, { on: true })
  await until(s, `__mvImmersive.granted() && document.documentElement.style.getPropertyValue('--mv-play-top') === '0px'`)
}

// 1400 x 1100, the monitor frame (1920 x 1080) shown: min(1, 1304/1920, (1056-128)/1080) -> 1304 wide; tight: 1376/1920 -> 1376
const SHOWN = 1304, TIGHT = 1376

describe('immersive play: the wish, the answer, one refit (C1, C3, C4)', () => {
  it('H in play sends {on: true}; nothing moves before the answer; {on: true} drops the play inset alone and takes the 24 px margins in one refit; H off restores both, Hide UI off; H on again goes immersive again', { timeout: 60_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    expect(await size(s)).toMatchObject({ w: SHOWN })
    expect([await rootVar(s, '--mv-top'), await rootVar(s, '--mv-play-top')]).toEqual(['44px', '44px'])
    expect(await wishes(s)).toEqual([])
    await key(s, 'h')
    await until(s, `__fake.wishes().length === 1`)
    expect(await wishes(s)).toEqual([{ on: true }])
    expect(await hidden(s)).toBe(true)
    await wait(150)
    // before main answers, nothing moves: the inset, the margins, the stage
    expect([await rootVar(s, '--mv-play-top'), (await size(s)).w]).toEqual(['44px', SHOWN])
    await answer(s, { on: true })
    await until(s, `getComputedStyle(document.querySelector('.sh-play-stage')).width === '${TIGHT}px'`)
    expect([await rootVar(s, '--mv-top'), await rootVar(s, '--mv-play-top')]).toEqual(['44px', '0px'])
    expect(await ev(s, `document.documentElement.classList.contains('mv-immersive')`)).toBe(true)
    expect(await ev(s, `__mvInset.usable().top`)).toBe(0)
    await until(s, `getComputedStyle(document.querySelector('.sh-play')).paddingTop === '0px'`, 2000)
    // H off: the wish drops; until main answers, the grant (and so the margins and the inset) stands
    await key(s, 'h')
    await until(s, `__fake.wishes().length === 2`)
    expect((await wishes(s))[1]).toEqual({ on: false })
    expect(await hidden(s)).toBe(false)
    await wait(150)
    expect([await rootVar(s, '--mv-play-top'), (await size(s)).w]).toEqual(['0px', TIGHT])
    await answer(s, { on: false })
    await until(s, `getComputedStyle(document.querySelector('.sh-play-stage')).width === '${SHOWN}px'`)
    expect([await rootVar(s, '--mv-play-top'), await hidden(s), await ev(s, `__mvImmersive.granted()`)]).toEqual(['44px', false, false])
    // and again
    await grant(s)
    await until(s, `getComputedStyle(document.querySelector('.sh-play-stage')).width === '${TIGHT}px'`)
  })

  it('a wish off main never answers is taken as answered within a second: the inset comes back', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    await grant(s)
    await key(s, 'h')
    await until(s, `__fake.wishes().length === 2`)
    expect(await rootVar(s, '--mv-play-top')).toBe('0px')
    await until(s, `document.documentElement.style.getPropertyValue('--mv-play-top') === '44px'`, 2_000)
    await until(s, `getComputedStyle(document.querySelector('.sh-play-stage')).width === '${SHOWN}px'`)
  })

  it('a refused wish ({on: false}, no end) keeps Hide UI and the 44 px inset, with the 24 px margins', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    await key(s, 'h')
    await until(s, `__fake.wishes().length === 1`)
    await answer(s, { on: false })
    await until(s, `getComputedStyle(document.querySelector('.sh-play-stage')).width === '${TIGHT}px'`)
    expect([await hidden(s), await rootVar(s, '--mv-play-top'), await ev(s, `__mvImmersive.granted()`)]).toEqual([true, '44px', false])
  })

  it('an app without `immersive` (1.1) and Chrome: H gives the 24 px margins and the fades at once, the inset stays and nothing is sent', { timeout: 60_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: false }, '#/p/main?at=demo/big')
    await key(s, 'h')
    await until(s, `getComputedStyle(document.querySelector('.sh-play-stage')).width === '${TIGHT}px'`)
    expect([await rootVar(s, '--mv-play-top'), await ev(s, `__fake.wishes().length`)]).toEqual(['44px', 0])
    await until(s, `getComputedStyle(document.querySelector('.sh-play > nav.sh-play-pill')).opacity === '0'`, 2000)
    // Chrome: no bridge, no inset - Hide UI alone, as before
    const c = await open({ on: false }, '#/p/main?at=demo/big')
    // 1400 x 1100, no inset: shown min(1, 1304/1920, 972/1080) -> 1304; tight -> 1376
    expect((await size(c)).w).toBe(SHOWN)
    await key(c, 'h')
    await until(c, `getComputedStyle(document.querySelector('.sh-play-stage')).width === '${TIGHT}px'`)
    expect(await rootVar(c, '--mv-play-top')).toBe('')
  })

  it('a phone at scale 1 does not grow; a slide stage does; responsive fill grows by its window with no FLIP; a slide under fill grows by its window, its aspect kept, with the FLIP', { timeout: 90_000 }, async (ctx) => {
    skip(ctx)
    const p = await open({ on: true, immersive: true }, '#/p/main?at=demo/phone')
    expect(await size(p)).toEqual({ w: 390, h: 844 })
    await watchFlips(p)
    await grant(p)
    await wait(400)
    expect([await size(p), await ev(p, '__flips')]).toEqual([{ w: 390, h: 844 }, 0])

    // a slide in slides mode: min((w-48)/1280, (h-88)/720) -> 1352 wide; tight min(1376/1280, 1076/720) -> 1376
    const d = await open({ on: true, immersive: true }, '#/p/deck?at=deck/s1&slides=1')
    expect((await size(d)).w).toBe(1352)
    await watchFlips(d)
    await grant(d)
    await until(d, `getComputedStyle(document.querySelector('.sh-play-stage')).width === '1376px'`)
    expect(await ev(d, '__flips')).toBeGreaterThan(0)

    // responsive fill: edge to edge of the view, taller by the strip's 44 px, never a FLIP
    const f = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    await ev(f, `(__mvStore.getState().setPlay({ ...__mvStore.getState().play, device: 'fill' }), 1)`)
    await until(f, `!!document.querySelector('.sh-play.fill')`)
    expect(await size(f)).toEqual({ w: 1400, h: 1056 })
    await watchFlips(f)
    await grant(f)
    await until(f, `getComputedStyle(document.querySelector('.sh-play-stage')).height === '1100px'`)
    await wait(400)
    expect(await ev(f, '__flips')).toBe(0)

    // a slide under fill, 1600 x 900: min(1600/1280, 856/720) -> 1522 x 856; immersive: min(1600/1280, 900/720) -> 1600 x 900
    const sf = await open({ on: true, immersive: true }, '#/p/deck?at=deck/s1&slides=1', { width: 1600, height: 900 })
    await ev(sf, `(__mvStore.getState().setPlay({ ...__mvStore.getState().play, device: 'fill' }), 1)`)
    await until(sf, `getComputedStyle(document.querySelector('.sh-play-stage')).width === '1522px'`)
    await watchFlips(sf)
    await grant(sf)
    await until(sf, `getComputedStyle(document.querySelector('.sh-play-stage')).width === '1600px'`)
    const z = await size(sf)
    expect(z.h).toBe(900)
    expect(Math.abs(z.w / z.h - 16 / 9)).toBeLessThan(0.01)
    expect(await ev(sf, '__flips')).toBeGreaterThan(0)
  })
})

describe('the ways in and back (C1.1, C1.2, C6, C7)', () => {
  it('the stopped state alone drops the wish, and its end brings it back', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    await grant(s)
    await ev(s, `(__mvLink.setState({ shown: true }), 1)`)
    await until(s, `__fake.wishes().at(-1).on === false`)
    expect(await hidden(s)).toBe(true)
    await ev(s, `(__mvLink.setState({ shown: false }), 1)`)
    await until(s, `__fake.wishes().at(-1).on === true`)
  })

  it('leaving play from code (a show()) keeps Hide UI after the answer; entering play again with it on goes immersive at once', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    await grant(s)
    await ev(s, `(window.__keep = __mvStore.getState().play, __mvStore.getState().setPlay(null), 1)`)
    await until(s, `__fake.wishes().at(-1).on === false`)
    await answer(s, { on: false })
    await wait(100)
    expect([await hidden(s), await rootVar(s, '--mv-play-top')]).toEqual([true, '44px'])
    const n = (await wishes(s)).length
    await ev(s, `(__mvStore.getState().setPlay(window.__keep), 1)`)
    await until(s, `__fake.wishes().length === ${n + 1} && __fake.wishes().at(-1).on === true`)
    await answer(s, { on: true })
    await until(s, `__mvImmersive.granted()`)
  })

  it('{on: false, end: true} in play restores the inset and turns Hide UI off; after play was left it leaves Hide UI as it is', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    await grant(s)
    await answer(s, { on: false, end: true })
    await until(s, `!document.body.classList.contains('sh-hide-ui')`)
    expect([await rootVar(s, '--mv-play-top'), (await wishes(s)).at(-1)]).toEqual(['44px', { on: false }])
    expect(await ev(s, `!!__mvStore.getState().play`)).toBe(true)
    await grant(s)
    await ev(s, `(__mvStore.getState().setPlay(null), 1)`)
    await until(s, `__fake.wishes().at(-1).on === false`)
    await answer(s, { on: false, end: true })
    await wait(100)
    expect(await hidden(s)).toBe(true)
  })

  it('Escape, a hidden tab and an untrusted document each end it with Hide UI off', { timeout: 60_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    await grant(s)
    await key(s, 'Escape')
    await until(s, `!__mvStore.getState().play`)
    expect([await hidden(s), (await wishes(s)).at(-1)]).toEqual([false, { on: false }])
    for (const st of ['hidden', 'untrusted']) {
      const t = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
      await grant(t)
      await ev(t, `(__fake.appState(${JSON.stringify(st)}), 1)`)
      await until(t, `!document.body.classList.contains('sh-hide-ui')`)
      expect((await wishes(t)).at(-1)).toEqual({ on: false })
      expect(await ev(t, `!!__mvStore.getState().play`)).toBe(true)
    }
  })

  it('canvas-mode Hide UI sends nothing', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/b/main')
    await key(s, 'h')
    await until(s, `document.body.classList.contains('sh-hide-ui')`)
    await wait(200)
    expect(await wishes(s)).toEqual([])
    expect(await ev(s, `__mvImmersive.tight()`)).toBe(false)
  })

  it('a board with no way out: Escape with nothing live turns Hide UI off and stays in play', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/lockd?at=demo/big')
    await grant(s)
    await key(s, 'Escape')
    await until(s, `!document.body.classList.contains('sh-hide-ui')`)
    expect(await ev(s, `!!__mvStore.getState().play`)).toBe(true)
    expect((await wishes(s)).at(-1)).toEqual({ on: false })
    // without Hide UI there is still nowhere to go
    await key(s, 'Escape')
    await wait(200)
    expect(await ev(s, `!!__mvStore.getState().play`)).toBe(true)
  })
})

describe('the shell\'s motion (C5)', () => {
  it('the FLIP: a device stage starts from its old size with .dev\'s own size transition off, and ends with no transform; a reversal mid-FLIP starts from the size it shows and ends at the right size', { timeout: 60_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    await watchFlips(s)
    await grant(s)
    await until(s, `__flips > 0`, 1000)
    expect(await ev(s, `__devT`)).toContain('0s')
    await until(s, `!document.querySelector('.sh-play.flip') && document.querySelector('.sh-play-stage').style.transform === ''`, 2000)
    expect((await size(s)).w).toBe(TIGHT)
    // its first frame is the old size (scale(prev/next) at the new layout size), and one answer gave one FLIP
    const starts = await ev(s, `__flipW`) as number[]
    expect(starts).toHaveLength(1)
    expect(starts[0]).toBeCloseTo(SHOWN, 0)
    // reversal: H off and its answer, and 80 ms into the FLIP back, H on and its grant in one task - the new FLIP
    // starts from the rendered size of that moment (between the two sizes), never from either end
    await key(s, 'h')
    await until(s, `__fake.wishes().at(-1).on === false`)
    await answer(s, { on: false })
    await wait(80)
    const mid = await ev(s, `(() => { const w = document.querySelector('.sh-play-stage').getBoundingClientRect().width; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true })); __fake.answer({ on: true }); return w })()`) as number
    expect(await ev(s, `__fake.wishes().at(-1).on`)).toBe(true)
    expect(mid).toBeGreaterThan(SHOWN + 3)
    expect(mid).toBeLessThan(TIGHT - 3)
    await until(s, `__flipW.length === 3`, 1000)
    expect((await ev(s, `__flipW`) as number[])[2]).toBeCloseTo(mid, 0)
    await until(s, `!document.querySelector('.sh-play.flip')`, 2000)
    expect((await size(s)).w).toBe(TIGHT)
    expect(await ev(s, `document.querySelector('.sh-play-stage').getBoundingClientRect().width`)).toBeCloseTo(TIGHT, 0)
    expect(await ev(s, `__flipW.length`)).toBe(3)
  })

  it('responsive fill picked mid-FLIP drops the device\'s FLIP at once: no .flip, no transform, no transition on its stage', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    await key(s, 'h')
    await until(s, `__fake.wishes().at(-1)?.on === true`)
    // in the page, in one go: the grant, and 60 ms into the device FLIP it starts, fill - then two frames on (far
    // inside the FLIP's 320 ms + 50 ms timer), what the fill stage carries
    const r = await ev(s, `new Promise((done) => {
      const play = document.querySelector('.sh-play')
      const ob = new MutationObserver(() => {
        if (!play.classList.contains('flip')) return
        ob.disconnect()
        const at = performance.now()
        setTimeout(() => {
          __mvStore.getState().setPlay({ ...__mvStore.getState().play, device: 'fill' })
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const st = document.querySelector('.sh-play-stage')
            done({ fill: play.classList.contains('fill'), flip: play.classList.contains('flip'), transform: st.style.transform,
              transition: st.style.transition, computed: getComputedStyle(st).transform, ms: performance.now() - at })
          }))
        }, 60)
      })
      ob.observe(play, { attributes: true, attributeFilter: ['class'] })
      __fake.answer({ on: true })
    })`) as { fill: boolean; flip: boolean; transform: string; transition: string; computed: string; ms: number }
    expect(r.ms).toBeLessThan(MOTION.out.stage)
    expect(r).toMatchObject({ fill: true, flip: false, transform: '', transition: '', computed: 'none' })
    expect(await size(s)).toEqual({ w: 1400, h: 1100 })
  })

  it('the stage\'s padding moves with MOTION: back 300 ms, out 320 ms, the stage ease', { timeout: 45_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    const t = () => ev(s, `(() => { const c = getComputedStyle(document.querySelector('.sh-play')); return [c.transitionProperty, c.transitionDuration, c.transitionTimingFunction] })()`)
    const nums = (x: string) => (x.match(/[\d.]+/g) ?? []).map(Number)
    expect((await t())[1]).toBe(`${MOTION.back.stage / 1000}s`)
    await grant(s)
    const out = await t()
    expect(out[0]).toBe('padding-top')
    expect(out[1]).toBe(`${MOTION.out.stage / 1000}s`)
    expect(nums(out[2])).toEqual(nums(MOTION.out.stageEase))
  })

  it('under Hide UI in play the pills, their fab and the navigator fade (display kept, 160 ms out, 200 ms back); the minimal deck\'s strip fades centred; a full deck and a no-chrome deck draw none', { timeout: 60_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: false }, '#/p/main?at=demo/big')
    const look = (sel: string) => ev(s, `(() => { const c = getComputedStyle(document.querySelector(${JSON.stringify(sel)})); return { display: c.display, dur: c.transitionDuration, pe: c.pointerEvents } })()`)
    // the fade's move: the offset from the shown place (translate and transform, rendered), the scale (the pill/fab morph
    // left alone), which property carries the offset, and each property's time and ease
    type Move = { dy: number; scale: number; via: 'translate' | 'transform'; t: Record<string, [string, string] | null> }
    const moves = (sel: string): Promise<Move> => ev(s, `(() => {
      const el = document.querySelector(${JSON.stringify(sel)}), c = getComputedStyle(el)
      const p = c.transitionProperty.split(', '), d = c.transitionDuration.split(', '), f = c.transitionTimingFunction.split(', ')
      const of = (x) => { const i = p.indexOf(x); return i < 0 ? null : [d[i % d.length], f[i % f.length]] }
      const tr = c.translate === 'none' ? 0 : parseFloat(c.translate.split(' ')[1] ?? '0'), m = new DOMMatrix(c.transform)
      return { dy: tr + m.m42, scale: Math.round(m.a * 100) / 100, via: tr ? 'translate' : 'transform', t: { translate: of('translate'), transform: of('transform') } }
    })()`)
    const PILLS = ['.sh-play > nav.sh-play-pill', '.sh-play > .sh-pill-fab']
    const base: Record<string, Move> = {}
    for (const sel of PILLS) base[sel] = await moves(sel)
    expect(base['.sh-play > .sh-pill-fab'].scale).toBe(0.5)   // the fab, shown folded while the pill is open
    await key(s, 'h')
    await wait(30)
    for (const sel of ['.sh-play > nav.sh-play-pill', '.sh-play > .sh-pill-fab', '.sh-play-nav']) {
      const l = await look(sel)
      expect(l.display, sel).not.toBe('none')
      expect(l.dur.split(', ')[0], sel).toBe(`${MOTION.out.pills / 1000}s`)
      expect(l.pe, sel).toBe('none')
    }
    await until(s, `getComputedStyle(document.querySelector('.sh-play-nav')).visibility === 'hidden' && getComputedStyle(document.querySelector('.sh-play > nav.sh-play-pill')).opacity === '0'`, 2000)
    // the pills' and the fab's move: 6 px up, 160 ms ease out, their own scale kept (the pill/fab morph is left alone)
    const via: Record<string, Move['via']> = {}
    for (const sel of PILLS) {
      const m = await moves(sel)
      expect([m.dy - base[sel].dy, m.scale], sel).toEqual([-6, base[sel].scale])
      expect(m.t[m.via], sel).toEqual([`${MOTION.out.pills / 1000}s`, 'ease'])
      via[sel] = m.via
    }
    await key(s, 'h')
    await wait(30)
    expect((await look('.sh-play-nav')).dur.split(', ')[0]).toBe(`${MOTION.back.pills / 1000}s`)
    // back: 200 ms ease for the pills' move too (never the morph's 260 ms)
    for (const sel of PILLS) expect((await moves(sel)).t[via[sel]], sel).toEqual([`${MOTION.back.pills / 1000}s`, 'ease'])
    await until(s, `getComputedStyle(document.querySelector('.sh-play-nav')).visibility === 'visible' && getComputedStyle(document.querySelector('.sh-play-nav')).opacity === '1'`, 2000)

    const m = await open({ on: false }, '#/p/mini?at=deck/s1&slides=1')
    expect(await ev(m, `!!document.querySelector('.sh-slides-strip')`)).toBe(true)
    await key(m, 'h')
    await until(m, `(() => { const c = getComputedStyle(document.querySelector('.sh-slides-strip')); return c.opacity === '0' && c.visibility === 'hidden' })()`, 2000)
    const strip = await ev(m, `(() => { const el = document.querySelector('.sh-slides-strip'); const r = el.getBoundingClientRect(); const t = new DOMMatrix(getComputedStyle(el).transform); return { mid: (r.left + r.right) / 2, w: el.offsetWidth, tx: t.m41, ty: t.m42, pe: getComputedStyle(el).pointerEvents } })()`)
    expect(Math.abs(strip.mid - 700)).toBeLessThan(1)
    expect([Math.round(strip.tx), strip.ty, strip.pe]).toEqual([-Math.round(strip.w / 2), 6, 'none'])
    for (const b of ['deck', 'bare']) {
      const d = await open({ on: false }, `#/p/${b}?at=deck/s1&slides=1`)
      expect(await ev(d, `!!document.querySelector('.sh-slides-strip')`), b).toBe(false)
    }
  })
})

describe('the recorder\'s immersive mode (C11)', () => {
  /** this page's `immersive` (or `hide-ui`) mode records in design/.local/perf/page.jsonl, oldest first */
  const recs = (page: string, mode: string, phase: 'enter' | 'exit'): Record<string, any>[] => {
    let text = ''
    try { text = readFileSync(join(root, 'design', '.local', 'perf', 'page.jsonl'), 'utf8') } catch { return [] }
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.page === page && r.kind === 'mode' && r.mode === mode && r.phase === phase).sort((a, b) => a.seq - b.seq)
  }
  /** everything waiting goes now, then `n` such records are on disk */
  async function flushed(s: string, page: string, mode: string, phase: 'enter' | 'exit', n: number): Promise<Record<string, any>[]> {
    const by = Date.now() + 10_000
    while (Date.now() < by) {
      await ev(s, `window.__mvRecorder.send()`)
      const r = recs(page, mode, phase)
      if (r.length >= n) return r
      await wait(150)
    }
    return recs(page, mode, phase)
  }

  it('main\'s grant enters it (two frames, done), its end exits it with how long it was held; a refusal records nothing; a grant standing when the signals start is held, its end an exit', { timeout: 90_000 }, async (ctx) => {
    skip(ctx)
    const s = await open({ on: true, immersive: true }, '#/p/main?at=demo/big')
    const page: string = await until(s, `window.__mvRecorder?.page`)
    // refused, then H off: Hide UI entered and left, immersive never
    await key(s, 'h')
    await until(s, `__fake.wishes().length === 1`)
    await answer(s, { on: false })
    await key(s, 'h')
    await until(s, `__fake.wishes().length === 2`)
    expect(await flushed(s, page, 'hide-ui', 'exit', 1)).toHaveLength(1)
    expect([recs(page, 'immersive', 'enter'), recs(page, 'immersive', 'exit')]).toEqual([[], []])

    // granted: the enter, at main's answer (never at the wish)
    await key(s, 'h')
    await until(s, `__fake.wishes().length === 3 && __fake.wishes().at(-1).on === true`)
    await wait(200)
    await ev(s, `window.__mvRecorder.send()`)
    expect(recs(page, 'immersive', 'enter')).toEqual([])
    await answer(s, { on: true })
    await until(s, `__mvImmersive.granted()`)
    const [enter] = await flushed(s, page, 'immersive', 'enter', 1)
    expect(enter).toMatchObject({ mode: 'immersive', phase: 'enter', outcome: 'done' })
    expect(enter.shownMs).toBeGreaterThanOrEqual(0)
    expect(recs(page, 'immersive', 'exit')).toEqual([])
    // held 400 ms, then revoked: the exit, its heldMs the time between
    await wait(400)
    await key(s, 'h')
    await until(s, `__fake.wishes().length === 4`)
    await answer(s, { on: false })
    const [exit] = await flushed(s, page, 'immersive', 'exit', 1)
    expect(exit).toMatchObject({ mode: 'immersive', phase: 'exit' })
    expect(exit.heldMs).toBeGreaterThanOrEqual(400)
    expect(exit.heldMs).toBeLessThan(10_000)

    // a grant standing when the signals start: a fresh instance of the recorder's signals (Vite serves the module again
    // under its own query; immersive.ts, the stores and the page's outbox stay the page's own) starts while granted
    await grant(s)
    await flushed(s, page, 'immersive', 'enter', 2)
    const url: string = await ev(s, `performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/shell/recorder-signals.ts'))`)
    expect(url).toBeTruthy()
    const fresh = new URL(url)
    fresh.searchParams.set('mvfresh', '1')
    expect(await ev(s, `import(${JSON.stringify(fresh.href)}).then((m) => { const before = m.modesOn(); m.startSignals(); return { before, after: m.modesOn() } })`)).toEqual({ before: [], after: expect.arrayContaining(['hide-ui']) })   // started, Hide UI held with it
    await wait(300)
    const enters = (await flushed(s, page, 'immersive', 'enter', 2)).length
    expect(enters).toBe(2)   // held from the start: no enter record of its own
    await key(s, 'h')
    await until(s, `__fake.wishes().length === 6`)
    await answer(s, { on: false })
    // two exits: the page's own instance (entered at the grant) and the fresh one (held since it started)
    const exits = await flushed(s, page, 'immersive', 'exit', 3)
    expect(exits).toHaveLength(3)
    expect(exits.slice(1).every((r) => r.heldMs >= 300)).toBe(true)
    expect(recs(page, 'immersive', 'enter')).toHaveLength(2)
  })
})
