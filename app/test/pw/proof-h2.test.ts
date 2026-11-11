/**
 * Spec 32 H2: the screenshot proofs, windowless - the page harness only (hidden windows, fake main, real CSP), never
 * the app. The strip and Home at 1x and 2x, light and dark: the strip's rest, hover, active, Home on, the menus (local,
 * remote, »), 1, 3, 7, 12 and 20 tabs, long names, "99+", compact tabs, A9's states, the window in the background and
 * a key's focus ring; Home's grid and board with the few and the busy sets, empty, Help, the card, chip and View menus,
 * the focused field, the hovers (cards, a chip, the field, the icon buttons, the more button, pressed too) and the
 * Copied states, each at 1280 x 800 and 720 x 480.
 *
 * A Home proof is Home's page with the strip drawn over it, as the window shows them: Home's shot laid under the
 * strip's page (its html background, through the CSSOM: the CSP allows `data:` images) and the strip's page shot at
 * the window's size. A strip proof alone lays a stand-in canvas ground under it (the design kit's ground and dots).
 * The traffic lights are the system's in the app; both draw stand-ins where macOS puts them, so a proof lines up
 * with its frame.
 *
 * The shots go to app/test/.proofs/s32/h2/ (gitignored) with a contact sheet, index.html, which pairs each proof with
 * the matching design frame's shot when one was copied into h2/design/ (H2.3: `marver shot` on the platform canvas).
 * The logos are the design's own files when they are on this Mac (MV_H2_LOGOS, else the platform canvas's
 * design/assets/tab-strip); without them every canvas wears its initials. Run alone:
 *   pnpm --filter marver-app exec vitest run --project pw test/pw/proof-h2.test.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RecentView, SharedLink, TabMarks, TabMenuView, TabView } from '../../src/shared/channels.ts'
import { APP_DIR } from '../harness/app.ts'
import { openPage, type PageRun } from '../harness/pages.ts'

const OUT = join(APP_DIR, 'test', '.proofs', 's32', 'h2')
const LOGOS = process.env.MV_H2_LOGOS ?? join(homedir(), 'marver-platform', 'canvas', 'design', 'assets', 'tab-strip')
const logoOf = (file: string): string | undefined => {
  const f = join(LOGOS, file)
  if (!existsSync(f)) return undefined
  const type = file.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
  return `data:${type};base64,${readFileSync(f).toString('base64')}`
}
const L = { starbucks: logoOf('starbucks.svg'), calepin: logoOf('calepin.svg'), os: logoOf('os-app.png'), aperture: logoOf('aperture.png'), grindr: logoOf('grindr.png'), platform: logoOf('platform.svg') }

const NOW = Date.now()
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const mk = (o: Partial<TabMarks> = {}): TabMarks => ({ needs: 0, unseen: 0, working: false, session: false, ...o })
const asks = (n: number, board?: string): TabMarks => mk({ needs: n, kinds: { ask: n, review: 0, failed: 0, stalled: 0 }, top: { kind: 'ask', ...(board ? { board } : {}) } })
const home: TabView = { id: 'h', kind: 'home', name: 'Home', state: 'live', verified: true, open: true }
let port = 4900
const tab = (id: string, name: string, over: Partial<TabView> = {}): TabView =>
  ({ id, kind: 'local', name, state: 'live', verified: true, open: true, link: `http://localhost:${++port}/`, folder: `~/${id}`, version: '0.31.0', ...over })
const remote = (id: string, host: string, over: Partial<TabView> = {}): TabView => ({ id, kind: 'remote', name: host, state: 'live', verified: false, open: true, link: `https://${host}/`, hue: 2, ...over })
const keyed = (list: TabView[]): TabView[] => {
  const canvases = list.filter((t) => t.kind !== 'home' && t.kind !== 'settings')
  return list.map((t) => {
    const i = canvases.indexOf(t)
    return i < 0 ? t : { ...t, key: i < 8 ? i + 1 : i === canvases.length - 1 ? 9 : undefined }
  })
}

/** Nic's strip on 10 Nov, as tab-strip/_kit.tsx NIC draws it */
const NIC = (): TabView[] => keyed([
  tab('asteria', 'marver-asteria', { marks: asks(2), hue: 5 }),
  tab('ambient', 'ambient-agent-try', { marks: mk({ unseen: 3 }), hue: 1 }),
  tab('starbucks', 'Starbucks CTO Brief', { logo: L.starbucks, marks: mk({ unseen: 4 }) }),
  tab('os', 'os-app', { logo: L.os, marks: mk({ unseen: 1 }) }),
  tab('aperture', 'Aperture', { logo: L.aperture, marks: mk({ unseen: 12 }) }),
  tab('grindr', 'grindr-creative-swap', { logo: L.grindr }),
  tab('calepin', 'Calepin', { logo: L.calepin, marks: asks(6) }),
])
/** Home's busy set, as home-v2/_home.tsx RUNNING, RECENT and SHARED (names as the identity step sets them) */
const BUSY = (): TabView[] => keyed([
  tab('asteria', 'Asteria', { marks: asks(2, 'Vault feed'), version: '0.30.0', update: '0.31.0', hue: 5 }),
  tab('calepin', 'Calepin', { logo: L.calepin, marks: asks(6, 'Filter v3'), version: '0.30.1', update: '0.31.0' }),
  tab('ambient', 'Ambient agent', { marks: mk({ working: true, work: { board: 'Onboarding', since: NOW - 4 * MIN } }), version: '0.30.0', update: '0.31.0', hue: 1 }),
  tab('platform', 'Marver Platform', { logo: L.platform, marks: mk({ working: true, work: { board: 'Tab strip', since: NOW - MIN } }) }),
  tab('starbucks', 'Starbucks CTO Brief', { logo: L.starbucks, marks: mk({ unseen: 4 }), version: '0.30.0', update: '0.31.0' }),
  tab('aperture', 'Aperture', { logo: L.aperture, marks: mk({ unseen: 12 }) }),
  tab('os', 'OS', { logo: L.os, version: '0.30.0', update: '0.31.0' }),
  tab('grindr', 'Grindr creative swap', { logo: L.grindr, version: '0.28.0', update: '0.31.0' }),
])
const FEW = (): TabView[] => BUSY().filter((t) => ['calepin', 'platform', 'aperture'].includes(t.id))
const RECENT: RecentView[] = [
  { id: 'r_0000000000000001', name: 'Newsletter', folder: '~/newsletter-canvas', lastSeen: NOW - 19 * HOUR },
  { id: 'r_0000000000000002', name: 'Fauna Robotics', folder: '~/robotics-inventory', lastSeen: NOW - 5 * DAY },
  { id: 'r_0000000000000003', name: 'Hertz TMS', folder: '~/tms-broker', lastSeen: NOW - 4 * DAY },
  { id: 'r_0000000000000004', name: 'Hertz Dealer Direct', folder: '~/hertz-dealer-direct', lastSeen: NOW - 15 * DAY },
]
const SHARED: SharedLink[] = [
  { id: 's_00000000000000a1', url: 'https://deck-production-ce5f.up.railway.app/', host: 'deck-production-ce5f.up.railway.app', name: 'On deck', lastSeen: NOW - 10 * DAY },
  { id: 's_00000000000000a2', url: 'https://app.marver.design/', host: 'app.marver.design', name: 'Marver', logo: L.platform, lastSeen: NOW - 10 * DAY },
  { id: 's_00000000000000a3', url: 'https://hertz-tms.up.railway.app/', host: 'hertz-tms.up.railway.app', name: 'Hertz TMS', lastSeen: NOW - 10 * DAY },
]
type HomeSet = 'busy' | 'few' | 'empty'
const homeTabs = (set: HomeSet): TabView[] => (set === 'busy' ? BUSY() : set === 'few' ? FEW() : [])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settle = (q: PageRun) => q.page.evaluate(async () => {
  for (let i = 0; i < 3; i++) {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  }
})
async function poll<T>(what: string, f: () => Promise<T>, ms = 3000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

/** the stand-in traffic lights (macOS draws them at 14, 16; 12 round, 8 apart) and the design kit's canvas ground */
const LIGHTS = ['#ff5f57', '#febc2e', '#28c840'].map((c, i) => `radial-gradient(circle 6px at ${20 + i * 20}px 22px, ${c} 5.4px, transparent 6px) no-repeat`)
const GROUND = (dark: boolean) => `radial-gradient(${dark ? '#35363f' : '#c9cbd5'} 1px, transparent 1px) 0 0 / 20px 20px, ${dark ? '#1b1c23' : '#e7e9ef'}`
const backdrop = (q: PageRun, bg: string) => q.page.evaluate((b) => { document.documentElement.style.background = b }, bg)

const shots: { file: string; group: string; note: string }[] = []
const ROWS: TabMenuView['rows'] = [
  { kind: 'item', id: 'open-browser', label: 'Open in browser', icon: 'arrow-square-out', enabled: true },
  { kind: 'item', id: 'reveal', label: 'Reveal in Finder', icon: 'folder-open', enabled: true },
  { kind: 'item', id: 'copy-link', label: 'Copy local link', icon: 'link', enabled: true },
  { kind: 'item', id: 'mark-all-seen', label: 'Mark all as seen', icon: 'check', enabled: true },
  { kind: 'item', id: 'resolve-all-comments', label: 'Resolve all comments', icon: 'check-square-offset', enabled: false },
  { kind: 'sep' },
  { kind: 'item', id: 'close', label: 'Close tab', icon: 'x', enabled: true },
]
const REMOTE_ROWS: TabMenuView['rows'] = [
  { kind: 'item', id: 'open-browser', label: 'Open in browser', icon: 'arrow-square-out', enabled: true },
  { kind: 'item', id: 'copy-link', label: 'Copy link', icon: 'link', enabled: true },
  { kind: 'sep' },
  { kind: 'item', id: 'reload', label: 'Reload', icon: 'arrow-clockwise', enabled: true },
  { kind: 'item', id: 'force-reload', label: 'Force reload', icon: 'arrow-clockwise', enabled: true },
  { kind: 'sep' },
  { kind: 'item', id: 'close', label: 'Close tab', icon: 'x', enabled: true },
]

for (const dpr of [1, 2] as const) {
  describe(`H2 proofs at ${dpr}x`, () => {
    let s: PageRun
    let hm: PageRun
    let rev = 0
    let mrev = 0
    beforeAll(async () => {
      mkdirSync(OUT, { recursive: true })
      s = await openPage('strip', { width: 1280, height: 44, dpr })
      hm = await openPage('home', { width: 1280, height: 800, dpr })
      hm.page.setDefaultTimeout(5000)
      await hm.answer('link:open', { ok: true })
      await hm.answer('home:action', { ok: true })
      await hm.send('home:info', { welcome: false, writable: true })
    })
    afterAll(async () => { await s?.close(); await hm?.close() })

    const strip = {
      async look(dark: boolean) {
        await s.media({ 'prefers-color-scheme': dark ? 'dark' : 'light' })
      },
      async show(active: string, list: TabView[], dark: boolean) {
        await s.send('tabs', { rev: ++rev, active, tabs: [home, ...list].map((t) => (t.kind === 'local' ? { ...t, dark } : t)) })
        await s.page.waitForFunction((d) => document.documentElement.classList.contains('dark') === d, dark)
        await settle(s)
      },
      async reset(w: number, h = 44) {
        await s.send('tab-menu', null)
        await s.send('window', { rev: ++rev, focused: true, fullScreen: false })
        await s.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await s.resize(w, h)
        await s.page.mouse.move(2, 40)
      },
      /** main's side of a menu: the view for the strip's last ask, the strip grown, then the strip says it shows */
      async menu(rows: TabMenuView['rows'], kind: 'tab' | 'more', w: number) {
        const asked = [...await s.calls('tab:menu'), ...await s.calls('tabs:more')] as { x: number; y: number }[]
        const a = asked.at(-1)!
        const v: TabMenuView = { rev: ++mrev, x: a.x, y: a.y, kind, rows }
        await s.send('tab-menu', v)
        await s.resize(w, 420)
        await poll('tab:menu-shown', async () => (await s.calls('tab:menu-shown') as { rev: number }[]).some((x) => x.rev === v.rev))
        await settle(s)
      },
    }
    async function stripShot(name: string, group: string, note: string, dark: boolean, w: number, h = 44) {
      await backdrop(s, [...LIGHTS, GROUND(dark)].join(', '))
      const file = `strip-${name}-${dark ? 'dark' : 'light'}-${w}@${dpr}x.png`
      await s.page.screenshot({ path: join(OUT, file), clip: { x: 0, y: 0, width: w, height: h } })
      shots.push({ file, group: `strip-${name}`, note })
    }

    const H = {
      async world(set: HomeSet, view: 'grid' | 'board', dark: boolean, size: [number, number]) {
        await hm.page.evaluate(() => {
          ;(document.activeElement as HTMLElement | null)?.blur?.()
          document.querySelector<HTMLElement>('.mv-catcher')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
        })
        await hm.page.keyboard.press('Escape')
        // the field keeps its draft across renders (D11): a proof starts with it empty
        if (await hm.page.$('#link')) {
          await hm.page.fill('#link', '')
          await hm.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
        }
        await hm.page.mouse.move(1, size[1] - 4)
        await hm.resize(...size)
        await hm.media({ 'prefers-color-scheme': dark ? 'dark' : 'light' })
        await hm.page.waitForFunction((d) => document.documentElement.classList.contains('dark') === d, dark)
        await hm.send('recent', set === 'busy' ? RECENT : set === 'few' ? RECENT.slice(0, 2) : [])
        await hm.send('shared', set === 'busy' ? SHARED : [])
        await hm.send('tabs', { rev: ++rev, active: 'h', tabs: [home, ...homeTabs(set)] })
        if (set !== 'empty' && !await hm.page.$(`.hm-body.${view}`)) {
          await hm.page.click('[data-key="view"]')
          await sleep(280)
          const r = (await hm.page.locator(`.mv-row[data-id="${view}"]`).boundingBox())!
          await hm.page.mouse.move(r.x + 20, r.y + 10, { steps: 2 })
          await hm.page.mouse.down(); await hm.page.mouse.up()
          await hm.page.waitForSelector(`.hm-body.${view}`, { timeout: 3000 })
          await hm.page.mouse.move(1, size[1] - 4)
        }
        await settle(hm)
      },
      async moreClick(id: string) {
        await hm.page.hover(`[data-card="${id}"]`)
        await hm.page.click(`[data-more="${id}"]`)
        await settle(hm)
      },
    }
    /** Home's shot under the strip's page, at the window's size: what the window shows */
    async function homeShot(name: string, note: string, set: HomeSet, dark: boolean, size: [number, number], o: { hoverTab?: string } = {}) {
      await settle(hm)
      const png = await hm.page.screenshot({ caret: 'hide' })
      await strip.reset(size[0], size[1])
      await strip.look(dark)
      await strip.show('h', homeTabs(set), dark)
      if (o.hoverTab) { await s.page.hover(`[data-id="${o.hoverTab}"]`); await settle(s) }
      await backdrop(s, [...LIGHTS, `url(data:image/png;base64,${png.toString('base64')}) 0 0 / ${size[0]}px ${size[1]}px no-repeat`].join(', '))
      const file = `home-${name}-${dark ? 'dark' : 'light'}-${size[0]}@${dpr}x.png`
      await s.page.screenshot({ path: join(OUT, file) })
      shots.push({ file, group: `home-${name}`, note })
      await backdrop(s, '')
      await strip.reset(1280)
    }

    for (const dark of [false, true]) {
      const theme = dark ? 'dark' : 'light'

      it(`the strip, ${theme}: option D's rows (rest, hover, the long name widened, Home on), 900 and 720 wide`, async () => {
        await strip.look(dark)
        const rows: [string, string, string | null, string, number][] = [
          ['d-rest', 'calepin', null, 'At rest, Calepin active (frame 06 row 1)', 1280],
          ['d-hover-active', 'calepin', 'calepin', 'Hovering Calepin: its badge gives way to ⌘7 (row 2)', 1280],
          ['d-hover-long', 'calepin', 'ambient', 'Hovering ambient-agent-try: its dot gives way to ⌘2, no size change (row 3)', 1280],
          ['d-active-long', 'ambient', null, 'ambient-agent-try active: widened to its whole name (row 4)', 1280],
          ['d-aperture', 'aperture', 'starbucks', 'Aperture active, Starbucks hovered (row 5, shot light and dark)', 1280],
          ['home-on', 'h', null, 'Home on: no marks, Home lit (A10, A11)', 1280],
          ['home-on-hover', 'h', 'calepin', 'Home on, Calepin hovered: ⌘7 comes back', 1280],
          ['d-narrow', 'calepin', null, 'A narrow window: every tab shrinks the same (row 6)', 900],
          ['d-compact', 'calepin', null, '720 wide: compact tabs under 104 px', 720],
        ]
        for (const [name, active, hover, note, w] of rows) {
          await strip.reset(w)
          await strip.show(active, NIC(), dark)
          if (hover) { await s.page.hover(`[data-id="${hover}"]`); await settle(s) }
          expect(await s.page.evaluate(() => devicePixelRatio)).toBe(dpr)
          await stripShot(name, 'rows', note, dark, w)
        }
      })

      it(`the strip, ${theme}: 1, 3, 7, 12 and 20 tabs; long names; 99+; at 1280 and 720`, async () => {
        await strip.look(dark)
        const many = (n: number) => keyed(Array.from({ length: n }, (_, i) => tab(`t${i + 1}`, ['Marver Platform', 'TMS broker', 'Hertz dealer', 'Tidewell', 'Calepin', 'Aperture', 'Newsletter', 'Fauna Robotics', 'On deck', 'Asteria', 'Grindr', 'OS'][i % 12] + (i >= 12 ? ` ${i + 1}` : ''),
          { marks: i % 4 === 1 ? asks(i + 1) : i % 4 === 2 ? mk({ unseen: 2 }) : undefined, logo: i % 3 === 0 ? [L.calepin, L.aperture, L.platform, L.starbucks][(i / 3) % 4] : undefined })))
        for (const n of [1, 3, 7, 12, 20]) {
          for (const w of [1280, 720]) {
            if (n < 7 && w === 720) continue
            await strip.reset(w)
            const list = many(n)
            await strip.show(list[Math.min(1, n - 1)].id, list, dark)
            await stripShot(`tabs-${n}`, 'count', `${n} tab${n > 1 ? 's' : ''}, the second active${n >= 12 ? '; » holds the rest when they do not fit at the 84 px floor' : ''}`, dark, w)
          }
        }
        const long = keyed([
          tab('l1', 'An exceedingly long canvas name that never fits anywhere', { marks: asks(3) }),
          tab('l2', 'Another canvas whose name runs on and on past its tab', { logo: L.aperture, marks: mk({ unseen: 2 }) }),
          tab('l3', 'Short'),
          tab('l4', 'A third long name, cut with an ellipsis at its end', { logo: L.calepin }),
        ])
        for (const [active, w] of [['l1', 1280], ['l3', 1280], ['l1', 720]] as const) {
          await strip.reset(w)
          await strip.show(active, long, dark)
          await stripShot(`long-${active === 'l1' ? 'active-long' : 'active-short'}`, 'long', `Long names; ${active === 'l1' ? 'the long one active (widened up to 260)' : 'a short one active (no widening)'}`, dark, w)
        }
        const badges = keyed([
          tab('b1', 'Calepin', { logo: L.calepin, marks: asks(150) }),
          tab('b2', 'Asteria', { marks: asks(99) }),
          tab('b3', 'Aperture', { logo: L.aperture, marks: asks(100) }),
          tab('b4', 'Newsletter', { marks: mk({ unseen: 500 }) }),
          ...Array.from({ length: 8 }, (_, i) => tab(`b${i + 5}`, `Canvas ${i + 5}`, { marks: asks(120 + i) })),
        ])
        for (const w of [1280, 720]) {
          await strip.reset(w)
          await strip.show('b1', badges, dark)
          await s.page.hover('[data-id="b3"]')
          await settle(s)
          await stripShot('badges-99', 'badges', '"99+" badges (150, 100, 120+), 99 as it is; Aperture hovered (⌘3); compact with 99+ at 720', dark, w)
        }
      })

      it(`the strip, ${theme}: A9's states, the window in the background, a key's focus ring`, async () => {
        await strip.look(dark)
        const states = keyed([
          tab('s1', 'Starting one', { state: 'starting' }),
          tab('s2', 'Not proven', { state: 'unverified', link: 'http://localhost:4808/' }),
          tab('s3', 'Stopped one', { state: 'gone', logo: L.aperture }),
          tab('s4', 'Unreachable', { state: 'unreachable' }),
          tab('s5', 'Crashed one', { state: 'crashed', logo: L.calepin }),
          tab('s6', 'Unloaded', { state: 'unloaded' }),
          tab('s7', 'Jam session', { marks: mk({ session: true }), logo: L.platform }),
          tab('s8', 'Agent working', { marks: mk({ working: true }) }),
          tab('s9', 'Stale marks', { marks: { ...asks(4), stale: true, session: true } }),
          remote('s10', 'deck.example.com'),
          { id: 'settings', kind: 'settings', name: 'Settings', state: 'hidden', verified: false, open: true },
        ])
        await strip.reset(1280)
        await strip.show('s7', states, dark)
        await stripShot('states', 'states', 'A9: starting, unverified, stopped, unreachable, crashed, unloaded, Jam session (active), working, stale marks, a remote tab, Settings', dark, 1280)
        await strip.reset(1280)
        await strip.show('calepin', NIC(), dark)
        await s.send('window', { rev: ++rev, focused: false, fullScreen: false })
        await settle(s)
        await stripShot('inactive', 'window', 'The window in the background: tabs and Home .55, the active one .8', dark, 1280)
        await strip.reset(1280)
        await strip.show('calepin', NIC(), dark)
        await s.page.focus('[data-id="calepin"]')
        await s.page.keyboard.press('ArrowLeft')
        await settle(s)
        await stripShot('focus', 'window', 'A key\'s focus ring (E7): ArrowLeft from Calepin to grindr', dark, 1280)
      })

      it(`the strip, ${theme}: the menus - a local tab's, a remote tab's, the active one's, »`, async () => {
        await strip.look(dark)
        const list = [...NIC(), remote('deck', 'deck-production-ce5f.up.railway.app')]
        for (const [name, id, rows, note] of [
          ['menu-local', 'aperture', ROWS, 'A local tab\'s menu: its tab wears the hover face, its badge stays'],
          ['menu-active', 'calepin', ROWS, 'The active tab\'s menu: the panel look stays'],
          ['menu-remote', 'deck', REMOTE_ROWS, 'A remote tab\'s menu'],
        ] as const) {
          await strip.reset(1280)
          await strip.show('calepin', list, dark)
          await s.clear()
          const b = (await s.page.locator(`[data-id="${id}"]`).boundingBox())!
          await s.page.mouse.click(b.x + 20, b.y + 16, { button: 'right' })
          await strip.menu(rows, 'tab', 1280)
          await stripShot(name, 'menus', note, dark, 1280, 420)
        }
        await strip.reset(720)
        const twenty = keyed(Array.from({ length: 20 }, (_, i) => tab(`m${i + 1}`, `Canvas ${i + 1}`, { state: i === 14 ? 'gone' : 'live', marks: i % 5 === 0 ? asks(i + 1) : undefined })))
        await strip.show('m2', twenty, dark)
        await s.clear()
        await s.page.click('#more')
        const ids = ((await s.calls('tabs:more')).at(-1) as { ids: string[] }).ids
        const rows: TabMenuView['rows'] = ids.map((x) => ({ kind: 'item', id: `tab:${x}`, label: `Canvas ${x.slice(1)}${x === 'm15' ? ' - stopped' : ''}`, enabled: true }))
        await strip.menu(rows, 'more', 720)
        await stripShot('menu-more', 'menus', '» open at 720: one row per hidden tab, » wears the panel look', dark, 720, 420)
      })

      for (const size of [[1280, 800], [720, 480]] as [number, number][]) {
        const at = `${size[0]} x ${size[1]}`
        it(`Home, ${theme}, ${at}: grid and board with the few and the busy sets, empty`, async () => {
          for (const [set, view, name, note] of [
            ['busy', 'grid', 'grid-busy', 'Grid, busy (frame 02-grid without its hover and menu)'],
            ['few', 'grid', 'grid-few', 'Grid, few (frame 04-states, top right)'],
            ['busy', 'board', 'board-busy', 'Board, busy (frame 03-board without its hover)'],
            ['few', 'board', 'board-few', 'Board, few'],
            ['empty', 'grid', 'empty', 'Empty (frame 04-states, top left)'],
          ] as const) {
            await H.world(set, view, dark, size)
            await homeShot(name, note, set, dark, size)
          }
        })

        it(`Home, ${theme}, ${at}: Help, the card menu, the chip menu, the View menu, the focused field`, async () => {
          await H.world('busy', 'grid', dark, size)
          await hm.page.click('[data-key="help"]')
          await homeShot('help', 'Help open (frame 04-states, bottom left)', 'busy', dark, size)
          await H.world('empty', 'grid', dark, size)
          await hm.page.click('[data-key="help-float"]')
          await homeShot('empty-help', 'Help open from the empty state (it opens upward)', 'empty', dark, size)
          await H.world('busy', 'grid', dark, size)
          await H.moreClick('asteria')
          await homeShot('card-menu', 'Asteria\'s more menu: the card .hov, its more button .on (frame 02-grid)', 'busy', dark, size)
          await H.world('busy', 'grid', dark, size)
          const c = (await hm.page.locator('[data-card="ambient"]').boundingBox())!
          await hm.page.mouse.move(c.x + 60, c.y + 20); await hm.page.mouse.down({ button: 'right' }); await hm.page.mouse.up({ button: 'right' })
          await settle(hm)
          await homeShot('card-menu-pointer', 'A right-click on a card: its menu at the pointer', 'busy', dark, size)
          await H.world('busy', 'board', dark, size)
          const chip = (await hm.page.locator('[data-key="chip:s_00000000000000a1"]').boundingBox())!
          await hm.page.mouse.move(chip.x + 30, chip.y + 12); await hm.page.mouse.down({ button: 'right' }); await hm.page.mouse.up({ button: 'right' })
          await settle(hm)
          await homeShot('chip-menu', 'A shared chip\'s menu on the board, above the pointer', 'busy', dark, size)
          await H.world('busy', 'board', dark, size)
          await hm.page.click('[data-key="view"]')
          await settle(hm)
          await homeShot('view-menu', 'The View menu on the board (frame 04-states, bottom right); the button .on', 'busy', dark, size)
          await H.world('few', 'grid', dark, size)
          await hm.page.click('#link')
          await hm.page.keyboard.type('app.marver.design/c/on-deck')
          await homeShot('field', 'The field focused, a link typed (frame 04-states, top right)', 'few', dark, size)
        })

        it(`Home, ${theme}, ${at}: the hovers and the Copied states`, async () => {
          const hovers: [HomeSet, 'grid' | 'board', string, string, string][] = [
            ['busy', 'grid', 'hover-card', '[data-card="calepin"]', 'A grid card hovered: its more button shows (frame 02-grid, Calepin)'],
            ['busy', 'grid', 'hover-off', '[data-card="r_0000000000000001"]', 'A not-running card hovered: its logo back to colour'],
            ['busy', 'board', 'hover-board-card', '[data-card="asteria"]', 'A board card hovered (frame 03-board, Asteria)'],
            ['busy', 'board', 'hover-chip', '[data-key="chip:s_00000000000000a2"]', 'A shared chip hovered'],
            ['busy', 'grid', 'hover-field', '.hm-head .hm-link', 'The link field hovered'],
            ['busy', 'grid', 'hover-icon', '[data-key="view"]', 'The View button hovered: glass'],
            ['busy', 'grid', 'hover-help', '[data-key="help"]', 'The "?" button hovered'],
          ]
          for (const [set, view, name, sel, note] of hovers) {
            await H.world(set, view, dark, size)
            const el = hm.page.locator(sel).first()
            await el.scrollIntoViewIfNeeded()
            await el.hover()
            await sleep(60)
            await homeShot(name, note, set, dark, size)
          }
          await H.world('busy', 'grid', dark, size)
          await hm.page.hover('[data-card="os"]')
          await hm.page.hover('[data-more="os"]')
          await homeShot('more-hover', 'The more button hovered', 'busy', dark, size)
          await H.world('busy', 'grid', dark, size)
          await hm.page.hover('[data-card="os"]')
          await hm.page.hover('[data-more="os"]')
          await hm.page.mouse.down()
          await homeShot('more-pressed', 'The more button pressed (pointer down)', 'busy', dark, size)
          await hm.page.mouse.up()
          await H.world('busy', 'grid', dark, size)
          await homeShot('strip-hover', 'Home on with a tab hovered in the strip (⌘N back)', 'busy', dark, size, { hoverTab: 'calepin' })

          await H.world('empty', 'grid', dark, size)
          await hm.page.click('[data-key="cp:dev"]')
          await hm.page.waitForFunction(() => getComputedStyle(document.querySelector('[data-key="cp:dev"] .b')!).opacity === '1')
          await homeShot('copied-label', 'The empty state\'s CopyLabel: Copied', 'empty', dark, size)
          await H.world('busy', 'grid', dark, size)
          await hm.page.click('[data-key="help"]')
          await hm.page.locator('.hm-cmd2 button').first().click()
          await hm.page.waitForSelector('.hm-cmd2 button.done')
          await homeShot('copied-help', 'Help\'s first command copied: the check', 'busy', dark, size)
          await H.world('busy', 'grid', dark, size)
          await H.moreClick('os')
          await sleep(280)
          const r = (await hm.page.locator('.mv-row[data-id="copy-path"]').boundingBox())!
          await hm.page.mouse.move(r.x + 20, r.y + 10, { steps: 2 })
          await hm.page.mouse.down(); await hm.page.mouse.up()
          await hm.page.waitForFunction(() => document.querySelector('.mv-row[data-id="copy-path"]')?.textContent === 'Copied')
          // the row reads Copied for 900 ms: shot at once, without the settle's wait for every animation
          const png = await hm.page.screenshot({ caret: 'hide' })
          await strip.reset(size[0], size[1])
          await strip.look(dark)
          await strip.show('h', BUSY(), dark)
          await backdrop(s, [...LIGHTS, `url(data:image/png;base64,${png.toString('base64')}) 0 0 / ${size[0]}px ${size[1]}px no-repeat`].join(', '))
          const file = `home-copied-row-${theme}-${size[0]}@${dpr}x.png`
          await s.page.screenshot({ path: join(OUT, file) })
          shots.push({ file, group: 'home-copied-row', note: 'A menu\'s Copy path row: Copied, in the done colours' })
          await backdrop(s, '')
          await strip.reset(1280)
          expect(await hm.csp()).toEqual([])
          expect(await s.csp()).toEqual([])
        })
      }
    }
  })
}

/** proof group -> the design frame shot it is judged against (files in h2/design/, shot by `marver shot`) */
const DESIGN: Record<string, string[]> = {
  'strip-d-rest': ['tab-strip--06-option-d', 'h2ref--strip-rows'],
  'strip-d-hover-active': ['tab-strip--06-option-d', 'h2ref--strip-rows'],
  'strip-d-hover-long': ['tab-strip--06-option-d', 'h2ref--strip-rows'],
  'strip-d-active-long': ['tab-strip--06-option-d', 'h2ref--strip-rows'],
  'strip-d-aperture': ['tab-strip--06-option-d', 'h2ref--strip-rows'],
  'strip-home-on': ['h2ref--strip-rows', 'home-v2--02-grid'],
  'strip-home-on-hover': ['h2ref--strip-rows'],
  'strip-d-narrow': ['tab-strip--06-option-d', 'h2ref--strip-rows'],
  'strip-d-compact': ['h2ref--strip-rows', 'tab-strip--03-compact'],
  'strip-tabs-12': ['tab-strip--03-compact'],
  'home-grid-busy': ['h2ref--grid-busy'],
  'home-grid-few': ['h2ref--grid-few'],
  'home-board-busy': ['h2ref--board-busy'],
  'home-board-few': ['h2ref--board-few'],
  'home-empty': ['h2ref--empty'],
  'home-help': ['h2ref--help'],
  'home-empty-help': ['h2ref--empty-help'],
  'home-card-menu': ['h2ref--grid-menu', 'home-v2--02-grid'],
  'home-view-menu': ['h2ref--view-menu'],
  'home-field': ['h2ref--field'],
  'home-hover-card': ['h2ref--grid-hover'],
  'home-hover-board-card': ['h2ref--board-hover', 'home-v2--03-board'],
}

/** what the comparison with the frames found and left, as of 11 Nov (the fixed ones are in git log) */
const LEFT = [
  'Strip: from the second tab on, every tab sits up to 2 px further left than in the frames - A3 corrects the kit\'s Home allowance (+10, not +8), so the kit\'s tabs run 2 px past their row.',
  'Home: a focused field\'s icon and key chip are #5cb3ff in dark (the frame keeps #0088ff) - E1\'s --hm-field-accent, a defect the spec fixes.',
  'Home: Help\'s edge-light ring shows (the frame clips it with overflow: hidden) - D9.4, a defect the spec fixes.',
  'Home: the field shows its hint line under it ("opens app.marver.design in a new tab") - D3 keeps today\'s hint; the frame draws none.',
  'Menus: Copy link\'s icon is dom.ts\'s link (the field\'s glyph, E3); the frame\'s menu draws the shell\'s LinkIcon, another chain.',
  'Right-click menus open at clientY + 2 (D8.4); the frame, positioned inside the card\'s border, lands 1 px right and 1 px lower than that.',
  'The working dot pulses: its shade differs with the moment of the shot. Logos and initials hues are the proof\'s data, not the app\'s look.',
  'At 2x some lines of text sit half a CSS pixel lower and the 28 px brand mark draws half a pixel larger per side - rounding.',
  'The proofs are tagged Display P3 (the harness draws in the display\'s space); the frames are untagged sRGB. Compare them colour-managed.',
]

afterAll(() => {
  if (!shots.length) return
  const designDir = join(OUT, 'design')
  const have = existsSync(designDir) ? readdirSync(designDir) : []
  const groups = new Map<string, { note: string; files: string[] }>()
  for (const sh of shots) {
    const g = groups.get(sh.group) ?? { note: sh.note, files: [] }
    g.files.push(sh.file)
    groups.set(sh.group, g)
  }
  const fig = (src: string, cap: string) => `<figure><a href="${src}"><img src="${src}" alt="${cap}" loading="lazy"></a><figcaption>${cap}</figcaption></figure>`
  const sections = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([g, { note, files }]) => {
    const refs = (DESIGN[g] ?? []).flatMap((base) => have.filter((f) => f.startsWith(`${base}--`) || f.startsWith(`${base}-light--`) || f.startsWith(`${base}-dark--`)).sort().map((f) => fig(`design/${f}`, `design: ${f}`)))
    return `<section id="${g}"><h2>${g}</h2><p>${note}</p><div class="row">${files.sort().map((f) => fig(f, f)).join('')}</div>${refs.length ? `<details><summary>Design frames (${refs.length})</summary><div class="row">${refs.join('')}</div></details>` : ''}</section>`
  })
  const toc = [...groups.keys()].sort().map((g) => `<a href="#${g}">${g}</a>`).join(' ')
  writeFileSync(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Spec 32 H2 proofs</title>
<style>body{font:13px -apple-system,sans-serif;margin:24px;background:#f4f5f8;color:#18181b}nav{line-height:1.9}nav a{margin-right:10px;color:#0068d6}
section{margin:28px 0;border-top:1px solid #dcdee5;padding-top:12px}h2{font-size:15px;margin:0 0 4px}p{margin:0 0 10px;color:#55575f}
.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}figure{margin:0;max-width:640px}img{display:block;max-width:100%;height:auto;box-shadow:0 0 0 1px rgba(0,0,0,.12)}
figcaption{margin-top:4px;color:#55575f;font-size:11px}details{margin-top:10px}summary{cursor:pointer;color:#0068d6}</style>
<h1>Spec 32 H2 proofs (page harness, windowless)</h1>
<p>The real strip and Home pages under a fake main, at 1x and 2x, light and dark; Home at 1280 x 800 and 720 x 480. The traffic lights and the canvas ground behind a strip alone are stand-ins (macOS and the canvas draw them in the app). Each group opens its design frames below it.</p>
<h2>Compared with the frames: what is left</h2><ul>${LEFT.map((l) => `<li>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</li>`).join('')}</ul>
<nav>${toc}</nav>
${sections.join('\n')}
`)
})
