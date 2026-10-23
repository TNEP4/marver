/**
 * The pages harness (spec 28 A2.10, A2.13; the pages stream): one app page - strip, Home, Settings or a tab page - in
 * a hidden Electron window under Playwright, with the real page bundle and the real app preload, and a fake main the
 * case plays (test/harness/pages-main.cjs). Built from the dev `dist/` the global setup makes.
 *
 *   const p = await openPage('home')
 *   await p.send('tabs', { rev: 1, active: 'h', tabs: [...] })
 *   expect(await p.calls('tab:activate')).toEqual([{ id: 't1' }])
 *   await p.media({ 'prefers-reduced-motion': 'reduce' })
 *
 * Each launch has its own temporary profile; nothing reads or writes ~/.marver. Never a bundle of two Team IDs
 * (scripts/team-id.mjs).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { assertOneTeam } from '../../scripts/team-id.mjs'
import { APP_DIR, ELECTRON_BIN } from './app.ts'

export type PageKind = 'strip' | 'home' | 'settings' | 'tabpage'
export interface Call { ch: string; p: unknown; t: number }

export interface PageRun {
  app: ElectronApplication
  page: Page
  /** main to page: one channel message */
  send(ch: string, payload: unknown): Promise<void>
  /** what the page sent, all or one channel's payloads */
  calls(): Promise<Call[]>
  calls(ch: string): Promise<unknown[]>
  clear(): Promise<void>
  /** a static answer for an invoke (`link:open`, `home:action`, `settings:get`, `settings:set`) */
  answer(ch: string, value: unknown): Promise<void>
  /** emulated media features (CDP), all at once: { 'prefers-reduced-motion': 'reduce', ... } */
  media(features: Record<string, string>): Promise<void>
  resize(w: number, h: number): Promise<void>
  /** CSP refusals the page's console reported */
  csp(): Promise<string[]>
  close(): Promise<void>
}

export async function openPage(kind: PageKind, o: { width?: number; height?: number } = {}): Promise<PageRun> {
  assertOneTeam(ELECTRON_BIN)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mvpages-')))
  const app = await _electron.launch({
    args: [join(APP_DIR, 'test', 'harness', 'pages-main.cjs')],
    env: {
      ...process.env as Record<string, string>,
      MVPAGES_DIST: join(APP_DIR, 'dist'), MVPAGES_PAGE: kind,
      MVPAGES_W: String(o.width ?? 1100), MVPAGES_H: String(o.height ?? 720),
      MARVER_APP_USER_DATA: join(dir, 'ud'),
    },
    timeout: 30_000,
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => document.documentElement.classList.contains('mv-ready') || document.readyState === 'complete')
  const cdp = await page.context().newCDPSession(page)
  const ev = <T>(fn: (g: { calls: Call[]; answers: Record<string, unknown>; csp: string[]; send(ch: string, p: unknown): void; resize(w: number, h: number): void }, a: unknown) => T, a?: unknown) =>
    app.evaluate((_e, [src, arg]) => {
      const g = (globalThis as unknown as { __pages: unknown }).__pages
      // eslint-disable-next-line no-new-func
      return (new Function('g', 'a', `return (${src})(g, a)`))(g, arg)
    }, [fn.toString(), a ?? null] as const) as Promise<T>
  return {
    app, page,
    send: async (ch, payload) => { await ev((g, a) => { const [c, p] = a as [string, unknown]; g.send(c, p) }, [ch, payload]); await page.evaluate(() => new Promise((r) => setTimeout(r, 10))) },
    calls: (async (ch?: string) => {
      const all = await ev((g) => g.calls)
      return ch ? all.filter((c) => c.ch === ch).map((c) => c.p) : all
    }) as PageRun['calls'],
    clear: async () => { await ev((g) => { g.calls.length = 0 }) },
    answer: async (ch, value) => { await ev((g, a) => { const [c, v] = a as [string, unknown]; g.answers[c] = v }, [ch, value]) },
    media: async (features) => { await cdp.send('Emulation.setEmulatedMedia', { features: Object.entries(features).map(([name, value]) => ({ name, value })) }) },
    resize: async (w, h) => { await ev((g, a) => { const [x, y] = a as [number, number]; g.resize(x, y) }, [w, h]); await page.waitForFunction(([x]) => window.innerWidth === x, [w]) },
    csp: () => ev((g) => g.csp),
    close: async () => {
      await app.close().catch(() => {})
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

/** Every running animation in the page and the properties it animates (A2.14 #26: under Reduce Motion, opacity only). */
export function animatedProperties(page: Page): Promise<{ name: string; props: string[] }[]> {
  return page.evaluate(() => document.getAnimations().map((a) => {
    const eff = a.effect as KeyframeEffect | null
    const props = new Set<string>()
    for (const k of eff?.getKeyframes() ?? []) for (const p of Object.keys(k)) if (!['offset', 'easing', 'composite', 'computedOffset'].includes(p)) props.add(p)
    return { name: (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id, props: [...props] }
  }))
}
