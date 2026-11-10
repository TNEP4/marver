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
 *
 * Spec 32 (G4): `dpr` launches at a device scale factor of 1 or 2 (H2.1's screenshots); `resize()` waits for both
 * axes (F4); `openProof(file)` serves one static HTML file from test/proofs/ on `marver-app://proof/` - with the
 * proof folder's own CSS and scripts beside it, the pages' shared files at `/<file>` and any page's built files at
 * `/pages/<page>/<file>`, and, with `bundle`, one TypeScript entry of test/proofs bundled as `/proof.js` (an IIFE,
 * as a page's is) - under the same CSP as every app page. Not a folder of pages/: every folder there is a shipped
 * page (bundle.test.ts).
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { assertOneTeam } from '../../scripts/team-id.mjs'
import { INVOKES, isInvoke, SENDERS } from '../../src/shared/channels.ts'
import { APP_DIR, ELECTRON_BIN } from './app.ts'

export type PageKind = 'strip' | 'home' | 'settings' | 'tabpage'
export interface Call { ch: string; p: unknown; t: number }
export interface OpenOptions { width?: number; height?: number; dpr?: 1 | 2 }
/** the proof pages' folder (G4): static HTML, CSS and script entries, never shipped */
export const PROOFS_DIR = join(APP_DIR, 'test', 'proofs')

export interface PageRun {
  app: ElectronApplication
  page: Page
  /** main to page: one channel message */
  send(ch: string, payload: unknown): Promise<void>
  /** what the page sent, all or one channel's payloads */
  calls(): Promise<Call[]>
  calls(ch: string): Promise<unknown[]>
  clear(): Promise<void>
  /** a static answer for an invoke (channels.ts `INVOKES`) */
  answer(ch: string, value: unknown): Promise<void>
  /** the invoke rejects from now on (main has no handler for it, or its handler threw) */
  reject(ch: string): Promise<void>
  /** the invoke answers `value` after `ms` from now on */
  answerLater(ch: string, value: unknown, ms: number): Promise<void>
  /** emulated media features (CDP), all at once: { 'prefers-reduced-motion': 'reduce', ... } */
  media(features: Record<string, string>): Promise<void>
  /** the window's content size; resolves once the page sees both (innerWidth and innerHeight) */
  resize(w: number, h: number): Promise<void>
  /** CSP refusals the page's console reported */
  csp(): Promise<string[]>
  close(): Promise<void>
}

export function openPage(kind: PageKind, o: OpenOptions = {}): Promise<PageRun> {
  return launch({ MVPAGES_PAGE: kind }, o)
}

/**
 * A proof page (G4, H2.5): `file` (an .html in test/proofs/) on `marver-app://proof/`, no preload, the page CSP.
 * `bundle` names a .ts entry in test/proofs/, bundled (tsdown, an IIFE for chrome140) and served as `/proof.js`.
 */
export async function openProof(file: string, o: OpenOptions & { bundle?: string } = {}): Promise<PageRun> {
  if (!/^[\w.-]+\.html$/.test(file) || !existsSync(join(PROOFS_DIR, file))) throw new Error(`no proof page ${file} in test/proofs`)
  const env: Record<string, string> = { MVPAGES_PAGE: 'proof', MVPAGES_PROOF: file, MVPAGES_PROOF_DIR: PROOFS_DIR }
  let out: string | null = null
  if (o.bundle) {
    out = realpathSync(mkdtempSync(join(tmpdir(), 'mvproof-js-')))
    env.MVPAGES_PROOF_JS = await bundleProof(o.bundle, out)
  }
  const run = await launch(env, o)
  if (!out) return run
  const dir = out
  return { ...run, close: async () => { await run.close(); rmSync(dir, { recursive: true, force: true }) } }
}

/** One test/proofs entry as a browser IIFE (the pages' own build options, tsdown.config.ts `page()`). */
async function bundleProof(entry: string, out: string): Promise<string> {
  if (!/^[\w.-]+\.ts$/.test(entry) || !existsSync(join(PROOFS_DIR, entry))) throw new Error(`no proof entry ${entry} in test/proofs`)
  const { build } = await import('tsdown')
  await build({
    config: false, cwd: APP_DIR, entry: { proof: join(PROOFS_DIR, entry) }, format: 'iife', platform: 'browser', target: 'chrome140',
    outDir: out, clean: false, dts: false, hash: false, report: false, publint: false, sourcemap: false, logLevel: 'warn', deps: {},
    define: { __MARVER_RELEASE__: 'false', __MV_TEST__: 'true', __MARVER_FEED__: '""' },
    outputOptions: { entryFileNames: '[name].js' },
  })
  const js = join(out, 'proof.js')
  if (!existsSync(js)) throw new Error(`the proof bundle of ${entry} wrote no proof.js`)
  return js
}

async function launch(extra: Record<string, string>, o: OpenOptions): Promise<PageRun> {
  assertOneTeam(ELECTRON_BIN)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mvpages-')))
  const app = await _electron.launch({
    args: [join(APP_DIR, 'test', 'harness', 'pages-main.cjs')],
    env: {
      ...process.env as Record<string, string>,
      MVPAGES_DIST: join(APP_DIR, 'dist'), ...extra,
      MVPAGES_W: String(o.width ?? 1100), MVPAGES_H: String(o.height ?? 720), MVPAGES_DPR: String(o.dpr ?? ''),
      MVPAGES_INVOKES: JSON.stringify(INVOKES), MVPAGES_SENDS: JSON.stringify(Object.keys(SENDERS).filter((c) => !isInvoke(c))),
      MARVER_APP_USER_DATA: join(dir, 'ud'),
    },
    timeout: 30_000,
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => document.documentElement.classList.contains('mv-ready') || document.readyState === 'complete')
  const cdp = await page.context().newCDPSession(page)
  const ev = <T>(fn: (g: { calls: Call[]; answers: Record<string, unknown>; csp: string[]; send(ch: string, p: unknown): void; reject(ch: string): void; later(ch: string, v: unknown, ms: number): void; resize(w: number, h: number): void }, a: unknown) => T, a?: unknown) =>
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
    reject: async (ch) => { await ev((g, a) => { g.reject(a as string) }, ch) },
    answerLater: async (ch, value, ms) => { await ev((g, a) => { const [c, v, m] = a as [string, unknown, number]; g.later(c, v, m) }, [ch, value, ms]) },
    media: async (features) => { await cdp.send('Emulation.setEmulatedMedia', { features: Object.entries(features).map(([name, value]) => ({ name, value })) }) },
    // both axes (spec 32 F4): a height-only resize (1280 x 44 to 1280 x 800) must not resolve at once
    resize: async (w, h) => { await ev((g, a) => { const [x, y] = a as [number, number]; g.resize(x, y) }, [w, h]); await page.waitForFunction(([x, y]) => window.innerWidth === x && window.innerHeight === y, [w, h]) },
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
