/**
 * The cover between the canvas views and the transparent strip (spec 28 A2.2, A3.8 #3, #29, #30): what shows under
 * the tabs whenever the active view may not be seen through. Owner: the one-ground stream.
 *
 * **S15 chose variant 3** (spikes.md, 23-24 Oct): a `WebContentsView` on persist:app loading the pinned
 * `marver-app://cover/` - a page that draws only the still dots - its ground the view's own native background
 * (`setBackgroundColor`). A plain `View` (1) and an `ImageView` (2) are drawn beneath full-height web views whatever
 * the child order (50 of 50 covered frames showed the pattern); no view at all (4) never covers with the strip's
 * renderer stalled. Variant 3 covered in every steady frame, reached the screen within a refresh over 50 toggles, and
 * kept covering with the strip's renderer stalled and with its own.
 *
 * **Covering waits on the cover's renderer** (S15's second finding): a `WebContentsView`'s native background is drawn
 * as the base of its renderer's frame, so the cover covers only while its renderer is alive and has presented a
 * frame - crashed, or before its page's first frame, it never covers (p95 n 25-26: the whole hold). So the cover says
 * when it is `ready()`: once its renderer has made a frame (two animation frames run in its page), false again from
 * its renderer's loss (reloaded at once) or the GPU process's (present.ts `onGpuLost`), until it makes a frame after
 * that. While it is not ready, layout.ts places every canvas below the strip (app 0.1's opaque layout:
 * `setCoverReady`, which window.ts feeds from `onReady`). A stalled renderer keeps its last frame and still covers.
 * Its renderer is never throttled, as on S15's bench, so a hidden or occluded window does not hold its first frame
 * back. Its dots are cosmetic: the look is set on the page through its renderer (`:root.dark`), the ground natively.
 *
 * Its renderer (about 25-35 MB) counts in the app's own memory (A3.8 #48): the recorder names it `cover`
 * (`contents()`), and the budgets' `procs:roles` finds it by its URL.
 *
 * `bitmap()` is the cover as the reconstructed picture draws it (captureApp, A3.8 #14): the ground, with the dots
 * while the cover is ready - drawn here, no readback, the same with its renderer stalled or gone.
 *
 * FROZEN (A3.8 #53): the `Cover` interface and `makeCover`, grown additively by the optional `stripDraws` and
 * `makeCover`'s `strip` (review of the one-ground stream: variant 4 needs both) and by `ready` and `onReady`
 * (the native stream, from S15's result). App 0.1's plain `View` (window.ts `plainCover`) stays only for a cover
 * that could not be made: no canvas at full height then.
 */
import { WebContentsView, type BaseWindow, type View, type WebContents } from 'electron'
import { ground, type Rect } from './plan.ts'
import { onGpuLost } from './present.ts'
import { COVER_URL, coverWebPreferences } from './sessions.ts'
import { note } from './testing/index.ts'

export interface Cover {
  /** whatever S15 chose (none for variant 4); always second from the top of the window's stack */
  readonly view: View | null
  /** variant 3's renderer, for the recorder's role `cover`; else null */
  contents(): WebContents | null
  /** the strip's rect */
  setRect(r: Rect): void
  /** in compose's turn, with the views beneath (A3.8 #30) */
  setVisible(v: boolean): void
  /** the ground of the active tab's look, and its dots */
  setLook(dark: boolean): void
  /**
   * the cover as the reconstructed picture draws it (captureApp, A3.8 #14): BGRA at the scale factor, or null - then
   * a web-view cover's own capture, else a fill of the ground
   */
  bitmap(width: number, height: number, scaleFactor: number): Buffer | null
  /** the strip's page draws the still dots while this cover covers (app 0.1's plain view; variant 4): window.ts's `dots` */
  readonly stripDraws?: boolean
  /**
   * S15 (24 Oct, two runs): variant 3 covers only while its renderer is alive and has presented a frame - a
   * `WebContentsView`'s native background is the base of its renderer's frame, so with its renderer crashed, or
   * before its page's first paint, it never covers (p95 n 25-26, the whole hold). `ready()` is false until the cover's
   * renderer has presented, and again from its loss (or the GPU process's) until it presents again; while it is false
   * layout keeps every canvas below the strip (app 0.1's opaque layout). Variant 3 must implement both; a cover that
   * never waits on a renderer leaves them out (always ready). Added by the native stream from S15's result.
   */
  ready?(): boolean
  /** called with each change of `ready()` (so compose runs again); returns its unsubscribe */
  onReady?(fn: (ready: boolean) => void): () => void
}

/** Whether a cover covers now: `ready()` where the cover has it, else always (S15: only variant 3 waits on a renderer). */
export const coverReady = (c: Pick<Cover, 'ready'> | null | undefined): boolean => !c || !c.ready || c.ready()

/** The dots' colour of each look: the shell's `--dot` (styles.css's tokens), as the cover's page draws them. */
export const DOT = { light: '#c9cbd5', dark: '#35363f' } as const

/**
 * The ground and, with `dots`, the still dots, BGRA (opaque) for a picture of `width x height` px at `sf` px per
 * window point - the CSS `radial-gradient(var(--dot) 1px, transparent 1px) 0 0 / 20px 20px` from the window's
 * origin: a dot of 1 pt radius at the centre of every 20 pt tile, never smaller than one pixel at a small scale.
 */
export function coverBitmap(width: number, height: number, sf: number, dark: boolean, dots: boolean): Buffer {
  const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const
  const [gr, gg, gb] = hex(ground(dark))
  const [dr, dg, db] = hex(dark ? DOT.dark : DOT.light)
  const w = Math.max(0, Math.round(width))
  const h = Math.max(0, Math.round(height))
  const buf = Buffer.alloc(w * h * 4)
  const s = sf > 0 ? sf : 1
  const r = Math.max(1, 0.5 / s)
  for (let y = 0; y < h; y++) {
    const dy = ((y + 0.5) / s) % 20 - 10
    for (let x = 0; x < w; x++) {
      const dx = ((x + 0.5) / s) % 20 - 10
      const dot = dots && dx * dx + dy * dy <= r * r
      const i = (y * w + x) * 4
      buf[i] = dot ? db : gb; buf[i + 1] = dot ? dg : gg; buf[i + 2] = dot ? dr : gr; buf[i + 3] = 255
    }
  }
  return buf
}

/**
 * The cover S15 chose (variant 3), made hidden at openWindow and added by window.ts between the tab pages and the
 * strip. `strip` is the strip's view (variant 4's; unused here).
 */
export function makeCover(win: BaseWindow, strip?: WebContentsView): Cover {
  void win
  void strip
  const view = new WebContentsView({ webPreferences: coverWebPreferences() })
  const wc = view.webContents
  const url = COVER_URL
  let dark = false
  let ready = false
  /** each loss advances it: a frame asked for before a loss never makes the cover ready */
  let gen = 0
  const fns = new Set<(ready: boolean) => void>()
  const j = (data: unknown) => { if (__MV_TEST__) note('cover', data) }
  const set = (on: boolean, why: string) => {
    if (ready === on) return
    ready = on
    j({ ready: on, why })
    for (const fn of [...fns]) { try { fn(on) } catch (err) { process.stderr.write(`marver-app: a cover listener threw: ${(err as Error).message}\n`) } }
  }
  const alive = () => !wc.isDestroyed() && !wc.isCrashed()
  /** the page's look, through its renderer (cosmetic: the ground is native) */
  const look = () => { if (alive()) wc.executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark}); 1`).catch(() => { /* its renderer went: did-finish-load sets it again */ }) }
  /** ready once two animation frames ran in the page after now: its renderer has made a frame since the last loss */
  const arm = () => {
    const g = gen
    if (!alive()) return
    wc.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
      .then(() => { if (g === gen && alive()) set(true, 'presented') })
      .catch(() => { /* its renderer went: the reload arms again */ })
  }
  const lost = (why: string) => { gen += 1; set(false, why) }
  view.setBackgroundColor(ground(dark))
  view.setVisible(false)
  wc.on('did-finish-load', () => { look(); arm() })
  wc.on('render-process-gone', (_e, d) => {
    lost(`renderer ${d.reason}`)
    // a crashed cover never covers: loaded again at once, ready at its first frame
    setTimeout(() => { if (!wc.isDestroyed()) void wc.loadURL(url).catch(() => { /* sessions.ts serves it */ }) }, 0)
  })
  const offGpu = onGpuLost(() => { lost('gpu'); arm() })
  wc.once('destroyed', () => { offGpu(); lost('destroyed') })
  void wc.loadURL(url).catch(() => { /* sessions.ts serves it; did-finish-load arms */ })
  return {
    view,
    stripDraws: false,
    contents: () => (wc.isDestroyed() ? null : wc),
    setRect: (r) => view.setBounds(r),
    setVisible: (v) => view.setVisible(v),
    setLook: (d) => {
      if (d === dark) return
      dark = d
      view.setBackgroundColor(ground(d))
      look()
    },
    bitmap: (width, height, sf) => coverBitmap(width, height, sf, dark, ready),
    ready: () => ready,
    onReady: (fn) => { fns.add(fn); return () => { fns.delete(fn) } },
  }
}
