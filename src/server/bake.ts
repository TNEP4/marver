/**
 * Effect compilation - what lets a hi-fi frame SLEEP on the canvas (spec 16).
 *
 * A frame at rest is its own live document. What makes a glass design unrenderable at scale is not
 * layout or text but its effects: every `backdrop-filter` is a compositor render surface that reads
 * back what is behind it on every composited frame, and under a scaled canvas the tiles behind it
 * re-raster on every zoom step. At rest nothing behind a glass surface changes, so its filtered
 * backdrop is a constant - a texture. This module computes those textures with Chrome itself, so
 * the pixels are the compositor's own, and CERTIFIES each one before it ships:
 *
 *   1. render the frame headless at the node's width/height/theme (DPR 2) and settle it like the
 *      shot pipeline does, plus SVG images, running animations and a DOM-quiet window
 *   2. DETECT every element with a computed backdrop-filter; level overlapping elements (an element
 *      over an earlier one bakes one level later, so its backdrop contains the earlier one's result)
 *   3. a WARMED, STABLE reference: one hide-and-show cycle first (tiles under the targets then sit in
 *      the state every later capture is in), captured until two consecutive captures are identical
 *   4. per level: hide this level and above with opacity (a descendant can undo `visibility`), ONE
 *      screenshot, and one filter page that cuts every crop at integer device pixels, tiles it 3x3
 *      with mirrored copies (Chrome's backdrop blur reads only the element's own region and mirrors
 *      at its edges) and applies the element's own filter list by CSS; one screenshot of that page,
 *      sliced back into the textures at TEXTURE_DSF
 *   5. certification: apply everything, render, and diff the INSIDE of each element's rounded
 *      shape (eroded 3 device px - a composited edge and an inline edge differ by an AA halo) against
 *      the reference; then re-apply only what passed and certify THAT composition (a rejected
 *      neighbour changes a backdrop); then check that no element's box moved
 *
 * The override the shell will use is the one certified here (src/shared/sleep-rule.ts):
 * `backdrop-filter: none` under a static `filter` (the containing block stays, the compositor layer
 * goes) with the texture under the element's own background layers. Layout is never touched.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { Browser } from './cdp.ts'
import { AREA, SURFACE, pool, shotConcurrency, withBrowser } from './shot.ts'
import { readOwn, sleepRule } from '../shared/sleep-rule.ts'

export interface BakeTarget {
  sel: string
  rect: { x: number; y: number; w: number; h: number }
  filter: string
  level: number
  /** the texture: a data URL straight from the compiler, or the file's URL once cached */
  texture: string
  verified: boolean
  maxErr: number
  bad: number
}
export type BakeResult =
  /** `posterSkipped`: the frame's document skipped a missing poster (a headless perf run's frame URL, spec 28 A3.8
   *  #19) - a texture of the frame without its poster, which never fills the shared cache */
  | { ok: true; targets: BakeTarget[]; levels: number; rejected: number; ms: number; outside?: Outside; effects?: number; posterSkipped?: true }
  | { ok: false; error: string }

const DSF = 2
/** Texture device px per CSS px. Blur is scale-tolerant: 1x matches 2x on identity at 2x zoom
 *  (29 px > 8 of 5.18 M, none > 32) at a quarter of the memory; 0.5x fails on 30 px pills. */
const TEXTURE_DSF = 1
const DEADLINE_MS = 45_000
/** What a compile past its deadline answers. */
export const TIMED_OUT = 'the bake timed out'
/** The refusal for a frame with a looping animation: it rests paused, never compiled. */
export const LOOPING = 'a looping animation - the frame rests paused, uncompiled'
/** The largest frame an ask may name, in CSS px: the shot pipeline's bitmap budget at DPR 2. */
export const ASK_MAX = { side: Math.floor(SURFACE / DSF), area: Math.floor(AREA / (DSF * DSF)) }
const MAX_TARGETS = 200
/** One element's texture, in CSS px (its 3x3 mirrored tiling is filtered in a page of its own). */
const MAX_TARGET_AREA = 4_000_000
const KEYS_PER_GEN = 400

/** Runs INSIDE the frame document: the effect census and the paint-order levelling. Assigns
 *  data-mv-bake ids so later passes address elements without re-walking. */
const DETECT = `(() => {
  const sel = (el) => {
    const seg = []
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
      if (cur.id) { seg.unshift('#' + CSS.escape(cur.id)); break }
      const tag = cur.tagName.toLowerCase()
      let n = 1
      for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === cur.tagName) n++
      seg.unshift(tag + ':nth-of-type(' + n + ')')
    }
    return seg.join('>')
  }
  const glass = []
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    const bf = cs.backdropFilter || cs.webkitBackdropFilter
    if (!bf || bf === 'none') continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    el.setAttribute('data-mv-glass', '')
    glass.push({ el, bf, r })
  }
  window.__mvBakeDetected = glass.length
  // glass inside glass: the inner element reads its ancestor's UNFILTERED backdrop (measured in
  // Chrome 152), which no texture on either of them reproduces - both stay live
  const out = []
  let i = 0
  for (const { el, bf, r } of glass) {
    if ((el.parentElement && el.parentElement.closest('[data-mv-glass]')) || el.querySelector('[data-mv-glass]')) continue
    el.setAttribute('data-mv-bake', String(i))
    out.push({ i: i++, sel: sel(el), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, filter: bf })
  }
  for (const { el } of glass) el.removeAttribute('data-mv-glass')
  const level = new Array(out.length).fill(0)
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  for (let k = 0; k < out.length; k++) for (let j = 0; j < k; j++) if (hit(out[k].rect, out[j].rect)) level[k] = Math.max(level[k], level[j] + 1)
  return out.map((t, k) => ({ ...t, level: level[k] }))
})()`

/** Runs inside the frame document: hide the targets at or above \`level\` (opacity, the authored
 *  inline declaration remembered and restored exactly), show the rest, apply \`bakes\` as the
 *  override the shell will use. */
const APPLY = `((level, bakes) => {
  const readOwn = ${readOwn.toString()}
  const sleepRule = ${sleepRule.toString()}
  let st = document.getElementById('mv-bake-style')
  if (!st) { st = document.createElement('style'); st.id = 'mv-bake-style'; document.head.appendChild(st) }
  const rules = []
  // no authored transition may animate the override in: the shell installs it the same way
  for (const el of document.querySelectorAll('[data-mv-bake]')) el.style.setProperty('transition-property', 'none', 'important')
  for (const el of document.querySelectorAll('[data-mv-bake]')) {
    const i = el.getAttribute('data-mv-bake')
    const b = bakes.find((x) => String(x.i) === i)
    if (!b) continue
    // the element's OWN background, read once before any override touches it
    const own = el.dataset.mvOwn ? JSON.parse(el.dataset.mvOwn) : readOwn(getComputedStyle(el))
    if (!el.dataset.mvOwn) el.dataset.mvOwn = JSON.stringify(own)
    rules.push(sleepRule('[data-mv-bake="' + i + '"]', own, b.texture))
  }
  st.textContent = rules.join('\\n')
  for (const el of document.querySelectorAll('[data-mv-bake]')) {
    const i = Number(el.getAttribute('data-mv-bake'))
    const t = window.__mvBakeTargets.find((x) => x.i === i)
    if (t && t.level >= level) {
      if (!('mvOpacity' in el.dataset)) el.dataset.mvOpacity = JSON.stringify([el.style.getPropertyValue('opacity'), el.style.getPropertyPriority('opacity')])
      el.style.setProperty('opacity', '0', 'important')
    } else if ('mvOpacity' in el.dataset) {
      const [v, p] = JSON.parse(el.dataset.mvOpacity)
      if (v) el.style.setProperty('opacity', v, p); else el.style.removeProperty('opacity')
      delete el.dataset.mvOpacity
    }
  }
  return true
})`

/** Every element's box, for the geometry guard (a lost containing block would move a fixed child). */
const GEOMETRY = `Array.from(document.querySelectorAll('body *')).map((el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] })`

const PAINTED = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`

/** The filter page: ONE screenshot of the level comes in; every element's crop is cut from it in-page
 *  at integer device pixels, tiled 3x3 with mirrored copies, filtered by CSS with the element's own
 *  filter list and clipped to its box - stacked so one screenshot yields every texture. */
function filterPage(full: string, items: { i: number; x: number; y: number; w: number; h: number; filter: string }[], dsf: number, tex: number): string {
  return `<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0;background:transparent}.clip{overflow:hidden;position:absolute;left:0}canvas{position:absolute;display:block}</style></head><body>
<script>
const items = ${JSON.stringify(items)}, dsf = ${dsf}, tex = ${tex}
const img = new Image()
img.onload = () => {
  let top = 0
  for (const it of items) {
    const sx = Math.round(it.x * dsf), sy = Math.round(it.y * dsf), sw = Math.round(it.w * dsf), sh = Math.round(it.h * dsf)
    const cw = it.w, ch = it.h
    const tw = Math.max(1, Math.round(cw * tex)), th = Math.max(1, Math.round(ch * tex))
    const clip = document.createElement('div'); clip.className = 'clip'; clip.id = 'c' + it.i
    clip.style.top = top + 'px'; clip.style.width = cw + 'px'; clip.style.height = ch + 'px'
    clip.dataset.box = [Math.round(top * tex), tw, th].join(',')
    const c = document.createElement('canvas'); c.width = 3 * tw; c.height = 3 * th
    c.style.left = -cw + 'px'; c.style.top = -ch + 'px'; c.style.width = (3 * cw) + 'px'; c.style.height = (3 * ch) + 'px'; c.style.filter = it.filter
    const g = c.getContext('2d')
    for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 3; tx++) {
      g.save(); g.translate(tx * tw, ty * th)
      const fx = tx === 1 ? 1 : -1, fy = ty === 1 ? 1 : -1
      g.translate(fx < 0 ? tw : 0, fy < 0 ? th : 0); g.scale(fx, fy)
      g.drawImage(img, sx, sy, sw, sh, 0, 0, tw, th); g.restore()
    }
    clip.appendChild(c); document.body.appendChild(clip)
    top += Math.ceil(ch) + 8
  }
  document.body.style.height = top + 'px'
  window.__mvReady = true
}
img.src = ${JSON.stringify(full)}
</script></body></html>`
}

const SLICE = `((shot) => new Promise((res) => { const im = new Image(); im.onload = () => {
  const out = {}
  for (const clip of document.querySelectorAll('.clip')) {
    const [y, w, h] = clip.dataset.box.split(',').map(Number)
    const c = document.createElement('canvas'); c.width = w; c.height = h
    c.getContext('2d').drawImage(im, 0, y, w, h, 0, 0, w, h)
    out[clip.id.slice(1)] = c.toDataURL('image/png')
  }
  res(out)
}; im.src = 'data:image/png;base64,' + shot }))`

/** Runs in the frame page: are two captures the same picture within GPU dither (no channel differs by more than 2)? */
const NEAR = `((a, b) => (async () => {
  const load = (d) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + d })
  const [ia, ib] = await Promise.all([load(a), load(b)])
  const px = (im) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height).data }
  const A = px(ia), B = px(ib)
  if (A.length !== B.length) return false
  for (let i = 0; i < A.length; i++) if (Math.abs(A[i] - B[i]) > 2) return false
  return true
})())`

/** Runs in the frame page: diff \`baked\` against \`reference\` inside each target's rounded shape,
 *  and over the rest of the frame - an override may not change one pixel outside the boxes it owns. */
const CERTIFY = `((reference, baked, rects, width) => (async () => {
  const load = (d) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + d })
  const [ia, ib] = await Promise.all([load(reference), load(baked)])
  const px = (im) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); return { d: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height } }
  const A = px(ia), B = px(ib), k = A.w / width, E = 3
  const owned = new Uint8Array(A.w * A.h)
  const verdicts = rects.map((t) => {
    const x0 = Math.max(0, Math.floor(t.rect.x * k) + E), y0 = Math.max(0, Math.floor(t.rect.y * k) + E)
    const x1 = Math.min(A.w, Math.ceil((t.rect.x + t.rect.w) * k) - E), y1 = Math.min(A.h, Math.ceil((t.rect.y + t.rect.h) * k) - E)
    const el = document.querySelector(t.sel); const cs = el ? getComputedStyle(el) : null
    const rad = (v) => Math.max(0, Math.min(parseFloat(v) || 0, Math.min(t.rect.w, t.rect.h) / 2) * k - E)
    const R = cs ? [rad(cs.borderTopLeftRadius), rad(cs.borderTopRightRadius), rad(cs.borderBottomRightRadius), rad(cs.borderBottomLeftRadius)] : [0, 0, 0, 0]
    const inside = (x, y) => {
      const cx = [x0 + R[0], x1 - R[1], x1 - R[2], x0 + R[3]], cy = [y0 + R[0], y0 + R[1], y1 - R[2], y1 - R[3]]
      const c = x < x0 + R[0] && y < y0 + R[0] ? 0 : x >= x1 - R[1] && y < y0 + R[1] ? 1 : x >= x1 - R[2] && y >= y1 - R[2] ? 2 : x < x0 + R[3] && y >= y1 - R[3] ? 3 : -1
      if (c < 0) return true
      const dx = x + 0.5 - cx[c], dy = y + 0.5 - cy[c]
      return dx * dx + dy * dy <= R[c] * R[c]
    }
    // the perimeter - the box minus the eroded shape - is where a composited edge and an inline
    // edge differ by an anti-aliasing halo; a tint painted into a transparent border shows there
    // as a solid band, so it has its own, looser gate
    const X0 = Math.max(0, Math.floor(t.rect.x * k)), Y0 = Math.max(0, Math.floor(t.rect.y * k))
    const X1 = Math.min(A.w, Math.ceil((t.rect.x + t.rect.w) * k)), Y1 = Math.min(A.h, Math.ceil((t.rect.y + t.rect.h) * k))
    let maxErr = 0, bad = 0, n = 0, ringBad = 0, ringN = 0
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      owned[y * A.w + x] = 1
      const i = (y * A.w + x) * 4
      const d = Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i+1] - B.d[i+1]), Math.abs(A.d[i+2] - B.d[i+2]))
      if (x >= x0 && x < x1 && y >= y0 && y < y1 && inside(x, y)) { if (d > maxErr) maxErr = d; if (d > 8) bad++; n++ }
      else { if (d > 48) ringBad++; ringN++ }
    }
    return { maxErr, bad, n, ringBad, ringN }
  })
  // outside every box: a changed pixel here is an anti-aliased edge next to a former layer (sparse,
  // a few per block) or a real change of paint (a blob) - counted per 16x16 device-pixel block
  const cols = Math.ceil(A.w / 16), blocks = new Uint16Array(cols * Math.ceil(A.h / 16))
  let maxErr = 0, bad = 0, gt32 = 0, n = 0, blockMax = 0
  for (let p = 0; p < owned.length; p++) {
    if (owned[p]) continue
    const i = p * 4
    const d = Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i+1] - B.d[i+1]), Math.abs(A.d[i+2] - B.d[i+2]))
    if (d > maxErr) maxErr = d; if (d > 8) bad++; n++
    if (d > 32) { gt32++; const b = ((p / A.w) >> 4) * cols + ((p % A.w) >> 4); if (++blocks[b] > blockMax) blockMax = blocks[b] }
  }
  return { verdicts, outside: { maxErr, bad, gt32, n, blockMax } }
})())`

type Verdict = { maxErr: number; bad: number; n: number; ringBad: number; ringN: number }
type Outside = { maxErr: number; bad: number; gt32: number; n: number; blockMax: number }
const passes = (v: Verdict | undefined): boolean =>
  !!v && v.n >= 64 && v.maxErr <= 32 && v.bad <= v.n * 0.005 && v.ringBad <= v.ringN * 0.05
/** The frame outside the boxes: at most 0.05 % of its pixels beyond 32 levels and no 16x16 block
 *  more than a quarter changed (measured: 154 of 2.5 M, 22 per block at worst, on the largest real
 *  frame; a 60x40 CSS px blob fills its blocks). */
const untouched = (o: Outside | undefined): boolean => !!o && o.gt32 <= o.n * 0.0005 && o.blockMax <= 64

/** Compile one frame inside a browser the caller owns. */
export async function bakeIn(b: Browser, opts: { url: string; width: number; height: number }): Promise<BakeResult> {
  const { url, width, height } = opts
  const t0 = Date.now()
  const me = {}
  let targetId: string | undefined
  // a deadline's abort settles the call under way as `<method>: <why>`: the answer says the bare reason, so the
  // failure cache knows it for a timeout (the review of a3-runs' fixes, minor #7)
  let timedOut = false
  const deadline = setTimeout(() => { timedOut = true; b.abort(me, TIMED_OUT) }, bakeSeams.deadlineMs ?? DEADLINE_MS)
  // a close that cannot hang the operation: bounded, outside the abort owner
  const closeTarget = async (id: string) => { let t: ReturnType<typeof setTimeout> | undefined; await Promise.race([b.send('Target.closeTarget', { targetId: id }).catch(() => {}), new Promise((r) => { t = setTimeout(r, 2000) })]); clearTimeout(t) }
  try {
    targetId = (await b.send('Target.createTarget', { url: 'about:blank' }, undefined, me)).targetId
    const sessionId = (await b.send('Target.attachToTarget', { targetId, flatten: true }, undefined, me)).sessionId as string
    const send = (m: string, p: Record<string, unknown> = {}, sid: string | undefined = sessionId) => b.send(m, p, sid, me)
    const ev = async (expression: string, awaitPromise = false) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })).result?.value
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const capture = async () => (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } })).data as string

    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: DSF, mobile: false })
    await send('Page.enable'); await send('Runtime.enable')
    const nav = await send('Page.navigate', { url })
    if (nav?.errorText && nav.errorText !== 'net::ERR_ABORTED') return { ok: false, error: `could not load the frame (${nav.errorText})` }
    // settle: readiness, fonts, in-view images + the frame's own async signals, SVG images, animations, quiet
    const readyBy = Date.now() + 30_000
    let rendered = false
    while (!rendered && Date.now() < readyBy) {
      rendered = !!(await ev(`(() => { const el = document.getElementById('root') ?? document.body; return !!el && el.childElementCount > 0 && document.readyState !== 'loading' })()`))
      if (!rendered) await wait(100)
    }
    if (!rendered) return { ok: false, error: 'the frame never rendered' }
    await ev(`document.fonts.ready.then(() => true)`, true)
    // fail closed: a frame still loading images or charts after the budget is not a frame to certify
    const unsettled = await ev(`new Promise((r) => { const t = Date.now(); const tick = () => {
      const H = innerHeight, W = innerWidth
      let pending = 0
      if (typeof window.__mvLodBusy === 'function' && window.__mvLodBusy() > 0) pending++
      if (typeof window.__mvPosterBusy === 'function' && window.__mvPosterBusy() > 0) pending++
      for (const im of document.images) { if (im.complete) continue; const b = im.getBoundingClientRect(); if (b.bottom < 0 || b.top > H || b.right < 0 || b.left > W) continue; pending++ }
      for (const c of document.querySelectorAll('.mv-chart')) if (!c.querySelector('svg, canvas')) pending++
      for (const d of document.querySelectorAll('.mv-diagram')) if (!d.querySelector('.mv-diagram-svg svg, .mv-diagram-err')) pending++
      if (!pending || Date.now() - t > 6000) r(pending); else setTimeout(tick, 60) }; tick() })`, true)
    if (unsettled) return { ok: false, error: `the frame did not settle (${unsettled} image(s) or chart(s) still loading)` }
    await ev(`Promise.all(Array.from(document.querySelectorAll('image')).map((el) => { const href = el.getAttribute('href') || el.getAttribute('xlink:href'); if (!href) return 1; const im = new Image(); im.src = new URL(href, location.href).href; return im.decode().catch(() => 1) })).then(() => true)`, true)
    // a looping animation (a spinner, a pulsing dot) never finishes: the live sleep freezes it at
    // whatever phase it reached in the canvas, which no texture made here can promise to match, so
    // the frame is refused at once and rests paused, uncompiled (issue #23: it used to be compiled
    // for seconds, refused as "never stopped changing", and asked again on every rest)
    if (await ev(`document.getAnimations().some((a) => { const t = a.effect && a.effect.getComputedTiming(); return !!t && t.iterations === Infinity && a.playState === 'running' })`)) return { ok: false, error: LOOPING }
    await ev(`Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => 1))), new Promise((r) => setTimeout(r, 5000))]).then(() => true)`, true)
    await ev(`new Promise((resolve) => { let timer = 0; const done = () => { mo.disconnect(); resolve(true) }; const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 250) }); mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); timer = setTimeout(done, 250); setTimeout(done, 3000) })`, true)
    await ev(PAINTED, true)
    const err = await ev(`window.__mvFrameError || ''`)
    if (err) return { ok: false, error: `the frame rendered an error - ${err}` }

    // a perf run's frame (its URL names the run): a Video whose poster is missing rested without it (video.tsx)
    const posterSkipped = (await ev(`document.documentElement.hasAttribute('data-mv-poster-skipped')`)) === true ? { posterSkipped: true as const } : {}
    const targets = (await ev(`(window.__mvBakeTargets = ${DETECT})`)) as { i: number; sel: string; rect: BakeTarget['rect']; filter: string; level: number }[]
    const effects = Number(await ev('window.__mvBakeDetected')) || 0   // every backdrop-filter element, nested ones included
    if (!targets?.length) return { ok: true, targets: [], levels: 0, rejected: 0, ms: Date.now() - t0, effects, ...posterSkipped }
    if (targets.length > MAX_TARGETS) return { ok: false, error: `too many effects to compile (${targets.length})` }
    if (targets.some((t) => t.rect.w * t.rect.h > MAX_TARGET_AREA)) return { ok: false, error: 'an effect larger than the texture budget' }
    const levels = Math.max(...targets.map((t) => t.level)) + 1
    const geometryBefore = (await ev(GEOMETRY)) as number[][]

    // the reference: warmed (one hide-and-show cycle) and stable (two identical consecutive captures)
    await ev(`${APPLY}(0, [])`); await ev(PAINTED, true)
    await ev(`${APPLY}(${levels}, [])`); await ev(PAINTED, true)
    await wait(300)
    // stable = two consecutive captures within GPU dither (a gradient rasters with 1-level noise
    // from frame to frame; certification tolerates far more than that)
    let reference = await capture(), stable = false
    let previous = ''
    for (let i = 0; i < 8; i++) { await wait(400); const again = await capture(); if (again === reference || (await ev(`${NEAR}(${JSON.stringify(reference)}, ${JSON.stringify(again)})`, true))) { stable = true; break }; previous = reference; reference = again }
    if (!stable) {
      if (process.env.MV_BAKE_DEBUG) { mkdirSync(process.env.MV_BAKE_DEBUG, { recursive: true }); writeFileSync(join(process.env.MV_BAKE_DEBUG, `unstable-a-${Date.now()}.png`), Buffer.from(previous, 'base64')); writeFileSync(join(process.env.MV_BAKE_DEBUG, `unstable-b-${Date.now()}.png`), Buffer.from(reference, 'base64')) }
      return { ok: false, error: 'the frame never stopped changing - nothing to certify against' }
    }

    const bakes: { i: number; texture: string }[] = []
    const done = new Map<number, BakeTarget>()
    for (let level = 0; level < levels; level++) {
      await ev(`${APPLY}(${level}, ${JSON.stringify(bakes)})`); await ev(PAINTED, true)
      const mine = targets.filter((t) => t.level === level)
      const full = await capture()
      const items = mine.map((t) => ({ i: t.i, x: t.rect.x, y: t.rect.y, w: t.rect.w, h: t.rect.h, filter: t.filter }))
      const { targetId: ft } = await b.send('Target.createTarget', { url: 'about:blank' }, undefined, me)
      try {
        const { sessionId: fs } = await b.send('Target.attachToTarget', { targetId: ft, flatten: true }, undefined, me)
        const totalH = items.reduce((a, c) => a + Math.ceil(c.h) + 9, 0)
        await b.send('Emulation.setDeviceMetricsOverride', { width: Math.ceil(Math.max(...items.map((c) => c.w))), height: Math.min(16_000, totalH), deviceScaleFactor: TEXTURE_DSF, mobile: false }, fs, me)
        await b.send('Page.enable', {}, fs, me)
        const { frameTree } = await b.send('Page.getFrameTree', {}, fs, me)
        await b.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: filterPage(`data:image/png;base64,${full}`, items, DSF, TEXTURE_DSF) }, fs, me)
        await b.send('Runtime.evaluate', { expression: `new Promise((r) => { const t = () => window.__mvReady ? requestAnimationFrame(() => requestAnimationFrame(() => r(true))) : setTimeout(t, 20); t() })`, awaitPromise: true, returnByValue: true }, fs, me)
        const fshot = (await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, fs, me)).data as string
        const textures = (await b.send('Runtime.evaluate', { expression: `${SLICE}(${JSON.stringify(fshot)})`, awaitPromise: true, returnByValue: true }, fs, me)).result.value as Record<string, string>
        for (const t of mine) {
          const texture = textures[String(t.i)]
          if (!texture) continue
          bakes.push({ i: t.i, texture })
          done.set(t.i, { sel: t.sel, rect: t.rect, filter: t.filter, level, texture, verified: false, maxErr: 255, bad: -1 })
        }
      } finally {
        await closeTarget(ft)
      }
    }

    // certification, twice: every candidate, then the composition that actually passed
    const certify = async (set: { i: number; texture: string }[]) => {
      await ev(`${APPLY}(${levels}, ${JSON.stringify(set)})`); await ev(PAINTED, true)
      const baked = await capture()
      if (process.env.MV_BAKE_DEBUG) { const d = join(process.env.MV_BAKE_DEBUG, new URL(url).pathname.replace(/[^\w.-]+/g, '_')); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'reference.png'), Buffer.from(reference, 'base64')); writeFileSync(join(d, `baked-${set.length}.png`), Buffer.from(baked, 'base64')) }
      const rects = set.map((s) => done.get(s.i)!).map((t) => ({ sel: t.sel, rect: t.rect }))
      return (await ev(`${CERTIFY}(${JSON.stringify(reference)}, ${JSON.stringify(baked)}, ${JSON.stringify(rects)}, ${width})`, true)) as { verdicts: Verdict[]; outside: Outside }
    }
    // certification until the admitted set IS the composition that was rendered: a rejected
    // neighbour changes a backdrop, so every rejection re-certifies the rest (one round per level
    // at most; a set that never settles ships nothing)
    let set = bakes, settled = false, outside: Outside | undefined
    for (let round = 0; set.length && round <= levels + 1 && !settled; round++) {
      const { verdicts, outside: o } = await certify(set)
      outside = o
      set.forEach((s, k) => { const t = done.get(s.i)!; t.verified = passes(verdicts[k]); t.maxErr = verdicts[k]?.maxErr ?? 255; t.bad = verdicts[k]?.bad ?? -1 })
      const next = set.filter((s) => done.get(s.i)!.verified)
      settled = next.length === set.length
      set = next
    }
    // the rest of the frame, under the composition that settled: a filter groups an element's whole
    // painted subtree, so what the boxes do not own is certified too, or nothing ships
    if (settled && set.length && !untouched(outside)) settled = false
    if (!settled) for (const s of set) done.get(s.i)!.verified = false
    // the geometry guard: the shipped override must not move any box (a lost containing block would)
    const geometryAfter = (await ev(GEOMETRY)) as number[][]
    const moved = geometryBefore.length !== geometryAfter.length || geometryBefore.some((r, k) => r.some((v, j) => Math.abs(v - geometryAfter[k][j]) > 0.01))
    if (moved) for (const t of done.values()) t.verified = false

    const out = [...done.values()]
    return { ok: true, targets: out, levels, rejected: out.filter((t) => !t.verified).length, ms: Date.now() - t0, outside, effects, ...posterSkipped }
  } catch (err) {
    return { ok: false, error: timedOut ? TIMED_OUT : (err as Error).message }
  } finally {
    clearTimeout(deadline)
    b.abort(me, 'the bake finished')
    if (targetId && !b.dead) await closeTarget(targetId)
  }
}

// ---- the cache and the batch --------------------------------------------------------------------

export interface BakeAsk { frame: string; theme: string; w: number; h: number }
export type BakeAnswer = { frame: string; theme: string; w: number; h: number } & BakeResult

/** Where a compiled frame lives on disk: design/.local/bakes/<generation>/<key>/. The generation
 *  is the dev server's source generation (bumped on any watched change), so a stale bake can never
 *  be served after an edit; older generations are removed as new ones appear. */
export function bakeKey(ask: BakeAsk): string {
  return createHash('sha1').update(`${ask.frame}|${ask.theme}|${Math.round(ask.w)}|${Math.round(ask.h)}`).digest('hex').slice(0, 16)
}

function cacheDir(root: string, gen: number, key: string): string { return join(root, 'design', '.local', 'bakes', String(gen), key) }

/** The cache lives INSIDE the project: a `bakes` directory that resolves elsewhere (a symlink) is
 *  never read, written or pruned. */
function cacheInside(root: string): boolean {
  const base = join(root, 'design', '.local', 'bakes')
  if (!existsSync(base)) return true
  try { return realpathSync(base).startsWith(realpathSync(root) + sep) } catch { return false }
}

function readCached(root: string, gen: number, ask: BakeAsk, urlBase: string): BakeAnswer | null {
  const key = bakeKey(ask)
  const dir = cacheDir(root, gen, key)
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'bake.json'), 'utf8')) as { targets: BakeTarget[]; levels: number; rejected: number; ms: number }
    try { const now = new Date(); utimesSync(dir, now, now) } catch { /* recency is best-effort */ }
    return { ...ask, ok: true, targets: meta.targets.map((t) => ({ ...t, texture: t.verified ? `${urlBase}/${gen}/${key}/${t.texture}` : '' })), levels: meta.levels, rejected: meta.rejected, ms: 0 }
  } catch { return null }
}

function writeCached(root: string, gen: number, ask: BakeAsk, r: Extract<BakeResult, { ok: true }>, urlBase: string, protect: Set<string>): BakeAnswer {
  const key = bakeKey(ask)
  const dir = cacheDir(root, gen, key)
  // bounded: at most KEYS_PER_GEN compiled sizes and themes per generation, the least recently
  // used evicted - never one the current response names
  const gdir = join(root, 'design', '.local', 'bakes', String(gen))
  // the generation belongs to this server for as long as it lives (see pruneBakes)
  mkdirSync(gdir, { recursive: true })
  if (!existsSync(join(gdir, 'owner'))) writeFileSync(join(gdir, 'owner'), String(process.pid))
  try {
    const names = readdirSync(gdir).filter((n) => !n.includes('.tmp-') && n !== key && n !== 'owner' && !protect.has(n))
    if (names.length >= KEYS_PER_GEN) names.map((n) => ({ n, t: statSync(join(gdir, n)).mtimeMs })).sort((a, b) => a.t - b.t).slice(0, names.length - KEYS_PER_GEN + 1).forEach(({ n }) => rmSync(join(gdir, n), { recursive: true, force: true }))
  } catch { /* no generation directory yet */ }
  const tmp = `${dir}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const targets = r.targets.map((t, i) => {
    if (!t.verified) return { ...t, texture: '' }
    const name = `${i}.png`
    writeFileSync(join(tmp, name), Buffer.from(t.texture.slice(t.texture.indexOf(',') + 1), 'base64'))
    return { ...t, texture: name }
  })
  writeFileSync(join(tmp, 'bake.json'), JSON.stringify({ targets, levels: r.levels, rejected: r.rejected, ms: r.ms, outside: r.outside }))
  rmSync(dir, { recursive: true, force: true })
  try { renameSync(tmp, dir) } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`could not write the compiled frame: ${(e as Error).message}`) }
  return { ...ask, ok: true, targets: targets.map((t) => ({ ...t, texture: t.verified ? `${urlBase}/${gen}/${key}/${t.texture}` : '' })), levels: r.levels, rejected: r.rejected, ms: r.ms }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

/** Drop every generation but the current one and those another live server owns (called at start
 *  and when the generation bumps). */
export function pruneBakes(root: string, keep: number): void {
  const base = join(root, 'design', '.local', 'bakes')
  if (!existsSync(base) || !cacheInside(root)) return
  try {
    for (const name of readdirSync(base)) {
      if (name === String(keep)) continue
      // another server on the same project owns its generation for as long as it lives
      let owner = 0
      try { owner = Number(readFileSync(join(base, name, 'owner'), 'utf8')) } catch { /* no owner: nothing was ever written */ }
      if (owner && owner !== process.pid && alive(owner)) continue
      rmSync(join(base, name), { recursive: true, force: true })
    }
  } catch { /* best-effort */ }
}

/**
 * Who a compile is for (spec 28 A3.8 #19, r1 #3): a headless run's id, or `normal` for every ordinary caller. The
 * in-flight key and the failure cache's key both become `flightKey(root, gen, ask, owner)`, so a run never joins a
 * normal compile nor a normal one a run's, and a failure one cached (a timeout under the run's 4x throttling) is
 * never answered to the other. FROZEN (A3.8 #53); the headless stream moves bakeBatch onto it.
 */
export type BakeOwner = string
export const NORMAL_OWNER: BakeOwner = 'normal'
export const flightKey = (root: string, gen: number, ask: BakeAsk, owner: BakeOwner = NORMAL_OWNER): string => `${root}|${gen}|${bakeKey(ask)}|${owner}`
/**
 * An owner's compiles now (A3.8 #18): `queued` waiting for the pool, `running` in `bakeIn`, each bounded by its 45 s
 * deadline. The run's driver reads it directly: a run is bake-idle when the page's four counts and these two are zero.
 */
export function jobsOf(owner: BakeOwner): { queued: number; running: number } {
  const j = jobs.get(owner)
  return j ? { queued: j.queued, running: j.running } : { queued: 0, running: 0 }
}
const jobs = new Map<BakeOwner, { queued: number; running: number }>()
const idleWaiters = new Map<BakeOwner, Set<() => void>>()
type JobState = 'queued' | 'running' | 'done'
/** A job of `owner` moves from one state to the next: the counts follow, and an owner left with none is idle. */
function move(owner: BakeOwner, from: JobState | null, to: JobState): void {
  const j = jobs.get(owner) ?? { queued: 0, running: 0 }
  if (from === 'queued') j.queued--; else if (from === 'running') j.running--
  if (to === 'queued') j.queued++; else if (to === 'running') j.running++
  if (j.queued > 0 || j.running > 0) { jobs.set(owner, j); return }
  jobs.delete(owner)
  const ws = idleWaiters.get(owner)
  idleWaiters.delete(owner)
  for (const w of ws ?? []) w()
}
/** Once `owner` has no compile queued or running: true, or false when `ms` passed first. */
export function jobsIdle(owner: BakeOwner, ms: number): Promise<boolean> {
  if (!jobs.has(owner)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let set = idleWaiters.get(owner)
    if (!set) idleWaiters.set(owner, set = new Set())
    const done = () => { clearTimeout(t); resolve(true) }
    const t = setTimeout(() => { set!.delete(done); resolve(false) }, ms)
    set.add(done)
  })
}

/** What a compile of a run that has ended answers, without rendering (A3.8 #19). */
export const RUN_ENDED = 'the run ended'
/** Runs that ended, cancelled or not: their compiles not started yet answer RUN_ENDED (bounded, oldest out). */
const ended = new Set<BakeOwner>()
/** A run's own answers, in memory while it runs: a compile whose document skipped a missing poster, which never
 *  fills the shared cache - its later asks find it here. */
const runAnswers = new Map<BakeOwner, Map<string, BakeAnswer>>()
/** Has this run ended (its compiles answer RUN_ENDED)? */
export const bakesEnded = (owner: BakeOwner): boolean => owner !== NORMAL_OWNER && ended.has(owner)
/** Each run's compiles not started yet - waiting for the lane or for the pool - by the function that ends one: a run's
 *  end settles them at once, never on their turn (the review of a3-runs' fixes, minor #3). */
const queuedJobs = new Map<BakeOwner, Set<() => void>>()
/**
 * A run ends (A3.8 #19, #20): its compiles not started answer RUN_ENDED at once, without rendering - those waiting for
 * the lane behind another batch and those waiting for the pool alike; one already rendering finishes (its frame URL
 * names the run, so it asks for no poster) and keeps nothing for the run; its answers and its failures go. The driver
 * then waits for its running jobs (`jobsIdle`).
 */
export function endRunBakes(owner: BakeOwner): void {
  if (owner === NORMAL_OWNER) return
  ended.add(owner)
  if (ended.size > 256) ended.delete(ended.values().next().value!)
  runAnswers.delete(owner)
  for (const k of [...failed.keys()]) if (k.endsWith(`|${owner}`)) failed.delete(k)
  for (const end of [...(queuedJobs.get(owner) ?? [])]) end()
}

/** Test seams - the environment's read only with MARVER_SLOT_BASE set (the suite's marker, as RUN_T's):
 *  MV_BAKE_HOLD_MS holds each compile that long before it renders, so a test can find one still compiling.
 *  `deadlineMs` (in-process only) shortens a compile's 45 s deadline, so a test can force "the bake timed out".
 *  MV_BAKE_STOP_ASKING=1 answers a caller who stops waiting STOP_ASKING instead of COMPILING: the page takes it for a
 *  failed compile, retries once and asks no more, so it goes idle while the server still compiles - the page's own 15
 *  looks at a COMPILING outlast any held compile (A3.8 r1 #4's case, added by the review of a3-runs). */
export const bakeSeams: { holdMs?: number; stopAsking?: boolean; deadlineMs?: number } = {}
const holdMs = (): number => {
  if (bakeSeams.holdMs !== undefined) return bakeSeams.holdMs
  const v = process.env.MARVER_SLOT_BASE ? Number(process.env.MV_BAKE_HOLD_MS) : NaN
  return Number.isFinite(v) && v > 0 ? Math.min(v, 60_000) : 0
}
/** The suite's answer for a compile still running, under MV_BAKE_STOP_ASKING (above). */
export const STOP_ASKING = 'still compiling - the suite asks the page to stop asking'
const stillCompiling = (): string => ((bakeSeams.stopAsking ?? (!!process.env.MARVER_SLOT_BASE && process.env.MV_BAKE_STOP_ASKING === '1')) ? STOP_ASKING : COMPILING)

/** Compiles in flight, by generation and key: identical asks - inside one request or across
 *  concurrent ones - share one compile. */
const inflight = new Map<string, Promise<BakeAnswer>>()

/** Compiles that FAILED for the frame's own reasons (it loops, never stops changing, never settles,
 *  timed out - a run's only, `keptFor` -, has too many effects), by generation and key, so it is answered at once from memory
 *  instead of being compiled again on every rest. The generation is in the key: an edit retries it.
 *  Only these are kept - anything else (the source moved mid-compile, the browser or its pipe died,
 *  a cache write failed) says nothing about the frame and is tried again. */
const failed = new Map<string, string>()
const FAILED_MAX = 2000
/** Is this failure kept for `owner`? Of the frame, and - for a timeout - a run's alone: a run's failures go with it,
 *  but a normal caller's 45 s deadline passed under a loaded machine as often as for the frame (a first compile of a
 *  fresh canvas took 24 s under the suite), and kept it would leave the frame live until an edit. A normal caller's
 *  timeout is tried again at its next ask, as before 0.27.2. */
const keptFor = (owner: BakeOwner, error: string): boolean => ofTheFrame(error) && !(owner === NORMAL_OWNER && error === TIMED_OUT)
export const ofTheFrame = (error: string): boolean => error === LOOPING || /^the frame (never stopped changing|did not settle|never rendered|rendered an error)|(^|: )the bake timed out$|^too many effects|^an effect larger than/.test(error)

/** The answer for a compile still running when a request stops waiting (`waitMs`): the frame stays
 *  live for now, and its next ask finds the result in the cache. */
export const COMPILING = 'compiling - ask again'

/** Compile many frames as ONE operation (one browser, `shotConcurrency()` at a time), the cache
 *  first. `urlFor(ask)` gives the frame's own URL; `urlBase` is where textures are served from;
 *  `live()` is the source generation NOW - a compile the source outran is not published. */
export async function bakeBatch(opts: { root: string; gen: number; asks: BakeAsk[]; urlFor: (ask: BakeAsk) => string; urlBase: string; live?: () => number; log?: (a: BakeAnswer) => void; waitMs?: number; owner?: BakeOwner }): Promise<BakeAnswer[]> {
  const { root, gen, asks, urlFor, urlBase, live, log, waitMs } = opts
  // who the compiles are for (A3.8 #19): a run's never meet a normal caller's - in flight, failed or remembered
  const owner = opts.owner ?? NORMAL_OWNER
  if (!cacheInside(root)) return asks.map((ask) => ({ ...ask, ok: false as const, error: 'design/.local/bakes resolves outside the project' }))
  const key = (ask: BakeAsk) => flightKey(root, gen, ask, owner)
  const theirs = owner === NORMAL_OWNER ? undefined : runAnswers.get(owner)
  const answers: (BakeAnswer | null)[] = asks.map((ask) => {
    const error = failed.get(key(ask))
    if (error !== undefined) return { ...ask, ok: false as const, error }
    // the shared cache was filled by compiles with their posters: a run reads it as any caller does
    return readCached(root, gen, ask, urlBase) ?? theirs?.get(key(ask)) ?? (bakesEnded(owner) ? { ...ask, ok: false as const, error: RUN_ENDED } : null)
  })
  const protect = new Set(asks.map(bakeKey))   // keys this response names: never evicted under it
  const misses = new Map<string, { ask: BakeAsk; at: number[] }>()
  asks.forEach((ask, i) => { if (answers[i]) return; const k = key(ask); const m = misses.get(k); if (m) m.at.push(i); else misses.set(k, { ask, at: [i] }) })
  type Job = { ask: BakeAsk; resolve: (a: BakeAnswer) => void; state: JobState; end?: () => void }
  const mine: Job[] = []
  // a run's job leaves the queue its end reads when it starts rendering or settles
  const unqueue = (job: Job) => {
    if (!job.end) return
    const s = queuedJobs.get(owner)
    s?.delete(job.end)
    if (s && !s.size) queuedJobs.delete(owner)
    job.end = undefined
  }
  const settle = (job: Job, a: BakeAnswer) => { if (job.state === 'done') return; unqueue(job); move(owner, job.state, 'done'); job.state = 'done'; job.resolve(a) }
  const runEnded = (job: Job) => settle(job, { ...job.ask, ok: false, error: RUN_ENDED })
  const waits = [...misses.entries()].map(([k, m]) => {
    let p = inflight.get(k)
    if (!p) {
      p = new Promise<BakeAnswer>((resolve) => {
        const job: Job = { ask: m.ask, resolve, state: 'queued' }
        mine.push(job); move(owner, null, 'queued')
        if (owner !== NORMAL_OWNER) { job.end = () => runEnded(job); let s = queuedJobs.get(owner); if (!s) queuedJobs.set(owner, s = new Set()); s.add(job.end) }
      })
      inflight.set(k, p)
      void p.then(() => inflight.delete(k))
    }
    return p.then((a) => { for (const i of m.at) answers[i] = { ...a, ...m.ask } })
  })
  async function compile(): Promise<void> {
    try {
      // a run that ended while its batch waited for the lane launches no browser for it
      await withBrowser('shot', (b) => pool(shotConcurrency(), mine, async (job) => {
        if (job.state !== 'queued') return   // ended while it waited (endRunBakes)
        if (bakesEnded(owner)) return runEnded(job)
        const cached = readCached(root, gen, job.ask, urlBase)   // another request may have filled it since we looked
        if (cached) return settle(job, cached)
        unqueue(job); move(owner, 'queued', 'running'); job.state = 'running'
        const hold = holdMs()
        if (hold) await new Promise((r) => setTimeout(r, hold))
        const r: BakeResult = await bakeIn(b, { url: urlFor(job.ask), width: Math.round(job.ask.w), height: Math.round(job.ask.h) }).catch((e) => ({ ok: false as const, error: (e as Error).message }))
        if (live && live() !== gen) return settle(job, { ...job.ask, ok: false, error: 'the source changed during the compile' })
        let a: BakeAnswer
        if (r.ok && r.posterSkipped) {
          // a texture of the frame without its poster: never the shared cache - its run's own, in memory, while it runs
          a = { ...job.ask, ok: true, targets: r.targets.map((t) => ({ ...t, texture: t.verified ? t.texture : '' })), levels: r.levels, rejected: r.rejected, ms: r.ms, posterSkipped: true }
          if (owner !== NORMAL_OWNER && !bakesEnded(owner)) { let m = runAnswers.get(owner); if (!m) runAnswers.set(owner, m = new Map()); m.set(key(job.ask), a) }
        } else {
          try { a = r.ok ? writeCached(root, gen, job.ask, r, urlBase, protect) : { ...job.ask, ...r } } catch (e) { a = { ...job.ask, ok: false, error: (e as Error).message } }
        }
        if (!a.ok && keptFor(owner, a.error) && !bakesEnded(owner)) {
          if (failed.size >= FAILED_MAX) failed.clear()
          failed.set(key(job.ask), a.error)
        }
        log?.(a)
        settle(job, a)
      }), { skip: () => bakesEnded(owner), skipped: [] })
      for (const job of mine) runEnded(job)   // skipped: the run ended while its batch waited for the lane
    } catch (e) {
      for (const job of mine) settle(job, { ...job.ask, ok: false, error: (e as Error).message })
    }
  }
  // The compile runs on its own; a caller with `waitMs` (the page, whose few connections must never
  // be held for minutes - issue #23) gets what is ready by then and COMPILING for the rest.
  const work = mine.length ? compile() : Promise.resolve()
  // a run's caller is answered once its jobs settled - at once when the run ends while they wait for the lane (the
  // review of a3-runs' fixes); a normal caller once the batch is over, its browser closed
  const all = owner === NORMAL_OWNER ? work.then(() => Promise.all(waits)) : Promise.all(waits)
  if (waitMs === undefined) { await all; return answers as BakeAnswer[] }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([all, new Promise((r) => { timer = setTimeout(r, waitMs) })])
  clearTimeout(timer)
  const still = stillCompiling()
  return answers.map((a, i) => a ?? { ...asks[i], ok: false as const, error: still })
}
