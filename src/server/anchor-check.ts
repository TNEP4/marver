/**
 * The anchor check (spec 26, Part 6): `comments new --on|--at`, `comments move` and a Live Jam re-pin
 * name an element by its words or a selector; the dev server loads the frame in the headless
 * browser `marver shot` uses - no screenshot - and asks the frame which VISIBLE element that is
 * (inspect.js `__mvAnchorCheck`). What it finds is stored as the full element bundle, so the pin
 * resolves exactly on the canvas.
 *
 * Refused only on evidence: a frame that rendered with no match, or several. Anything that stops
 * the check - no Chrome, a browser that will not start, a frame that throws, the deadline - comes
 * back `unchecked`, and the caller writes the note unchecked with a warning.
 */
import { planShot, frameUrl, manifestFrame, MOUNTED, withBrowser } from './shot.ts'
import type { AnchorCheck, AnchorTarget } from '../shared/anchor.ts'

/** End to end, a cold browser start included (most of it). */
export const CHECK_MS = 20_000

export interface CheckRequest {
  root: string
  viewports: Record<string, { width: number; height: number }>
  origin: string
  frameId: string
  target: AnchorTarget
  /** the open threads already on this frame, to say which hold the same element */
  others?: { key: string; anchor: unknown }[]
  /** a viewport name; default the frame's own (meta.viewport), else the canvas default */
  viewport?: string
  theme?: string
}

/** A request the check cannot even start on: an unknown frame, viewport or theme. */
export class CheckInputError extends Error {}

export async function checkAnchor(req: CheckRequest, deadlineMs = CHECK_MS - 1_000): Promise<AnchorCheck> {
  const theme = req.theme ?? 'light'
  if (!/^[a-z0-9-]+$/i.test(theme)) throw new CheckInputError(`invalid theme "${theme}"`)
  const frame = manifestFrame(req.root, req.frameId)
  if (!frame) throw new CheckInputError(`unknown frame "${req.frameId}" - ids are in design/manifest.json`)
  if (req.viewport && !req.viewports[req.viewport]) throw new CheckInputError(`unknown viewport "${req.viewport}" - this canvas has ${Object.keys(req.viewports).join(', ')}`)
  const plan = planShot(frame, req.viewports)
  const size = req.viewport ? req.viewports[req.viewport] : { width: plan.width, height: plan.initialHeight }
  const viewport = req.viewport ?? frame.viewport ?? (frame.slide ? 'its slide stage' : frame.contentWidth ? `${size.width}px wide` : 'mobile')

  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<AnchorCheck>((done) => { timer = setTimeout(() => done({ ok: false, unchecked: `the check passed its ${CHECK_MS / 1000} s deadline` }), deadlineMs) })
  const by = Date.now() + deadlineMs
  const run = withBrowser('check', async (b): Promise<AnchorCheck> => {
    const me = {}
    const stop = setTimeout(() => b.abort(me, 'the check timed out'), Math.max(0, by - Date.now()))
    let thrown = ''
    let off = () => {}
    try {
      const send = (method: string, params: Record<string, unknown> = {}, sid?: string) => b.send(method, params, sid, me)
      const targetId = (await send('Target.createTarget', { url: 'about:blank' })).targetId as string
      const sid = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId as string
      off = b.on((m) => {
        if (m.sessionId === sid && m.method === 'Runtime.exceptionThrown') thrown = String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? '').split('\n')[0]
      })
      await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false }, sid)
      await send('Page.enable', {}, sid)
      await send('Runtime.enable', {}, sid)
      const nav = await send('Page.navigate', { url: frameUrl(req.origin, frame, theme) }, sid)
      if (nav?.errorText && nav.errorText !== 'net::ERR_ABORTED') return { ok: false, unchecked: `the frame did not load (${nav.errorText})` }
      const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid))?.result?.value
      while (!(await evaluate(MOUNTED).catch(() => false))) {
        if (Date.now() > by - 500) return { ok: false, unchecked: `the frame never rendered${thrown ? ` - it threw: ${thrown}` : ''}` }
        await new Promise((r) => setTimeout(r, 150))
      }
      // fonts and two frames of layout: the words are where a person would see them
      await evaluate('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))')
      const error = await evaluate('window.__mvFrameError || ""')
      if (error) return { ok: false, unchecked: `the frame rendered an error - ${error}` }
      const found = await evaluate(`window.__mvAnchorCheck ? window.__mvAnchorCheck(${JSON.stringify(req.target)}, ${JSON.stringify(req.others ?? [])}) : null`)
      if (!found) return { ok: false, unchecked: 'the frame has no Marver bridge to ask' }
      if (found.bad) throw new CheckInputError(found.bad)
      if (found.none) return { ok: false, refused: 'none', visible: found.none, viewport, theme }
      if (found.several) return { ok: false, refused: 'several', matches: found.several, viewport, theme }
      return { ok: true, anchor: found.anchor, holders: found.holders ?? [], viewport, theme }
    } finally {
      // the browser belongs to this one check and closes with it (withBrowser), its tab included
      clearTimeout(stop)
      off()
      b.abort(me, 'the check finished')
    }
  })
  try {
    return await Promise.race([run, late])
  } catch (err) {
    if (err instanceof CheckInputError) throw err
    return { ok: false, unchecked: (err as Error).message }
  } finally {
    clearTimeout(timer)
    run.catch(() => {})   // a run that lost the race settles on its own; its browser closes with it
  }
}
