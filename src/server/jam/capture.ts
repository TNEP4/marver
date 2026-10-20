/**
 * Captures on the server (spec 27, Part 3): the sealed record the shell posts at `E`, checked and
 * stored once under design/.local/jam/captures/<id>.json; what a capture names (its frames, its
 * words, its first point, its facts); and the jam picture index - capture pictures and a batch's
 * before and after shots, each an immutable file behind an opaque id.
 *
 * A capture has no category: nothing here sorts what was said and done. The record never changes
 * after it is sealed; the read-back's edit is stored on the card (queue.ts), and at confirm both are
 * frozen and their hashes ledgered, so a record or an edit changed afterwards stops the job.
 */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { sanitize } from './packet.ts'
import { speechLines } from '../../shared/speech.ts'
import { touchedFrames } from '../../shared/capture-frames.ts'
import type { Bundle, CaptureRecord, Step, View } from './types.ts'

export const CAPTURE_ID = /^cap-\d{10,16}-[a-z0-9]{4,12}$/
export const PICTURE_ID = /^p-[0-9a-f]{16}$/
const BOARD = /^[a-z0-9][a-z0-9-]*$/
/** At most this many pictures in one capture (the spec's 12), and this many steps. */
export const MAX_PICTURES = 12
const MAX_STEPS = 5000
const MAX_RECORD = 2_000_000

const jamDir = (root: string) => join(root, 'design', '.local', 'jam')
const capturesDir = (root: string) => join(jamDir(root), 'captures')
const picturesDir = (root: string) => join(jamDir(root), 'pictures')
const indexFile = (root: string) => join(jamDir(root), 'pictures.json')

// ---- the record ------------------------------------------------------------------------------------

const str = (v: unknown, cap = 4096): string | undefined => (typeof v === 'string' ? sanitize(v, cap) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const strs = (v: unknown, cap = 200): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, cap).map((x) => sanitize(x, 400)) : [])

function bundleOf(v: unknown): Bundle {
  const b = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: Bundle = {}
  for (const k of ['tag', 'quote', 'testId', 'ariaLabel', 'role', 'cssPath', 'source'] as const) { const s = str(b[k], 600); if (s) out[k] = s }
  return out
}
function viewOf(v: unknown): View {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: View = {}
  for (const k of ['board', 'theme', 'viewport', 'variant', 'mode'] as const) { const s = str(o[k], 200); if (s) out[k] = s }
  for (const k of ['width', 'height', 'zoom'] as const) { const n = num(o[k]); if (n !== undefined) out[k] = n }
  const frames = strs(o.frames); if (frames.length) out.frames = frames
  return out
}

/** One step as the record keeps it - every field typed and capped; an unknown event is dropped. */
function stepOf(v: unknown): Step | null {
  const o = (v && typeof v === 'object' ? v : null) as Record<string, any> | null
  const at = num(o?.at)
  if (!o || at === undefined) return null
  const base = { at, ...(str(o.frame, 300) ? { frame: str(o.frame, 300) } : {}) }
  switch (o.event) {
    case 'words': return { ...base, event: 'words', text: str(o.text, 20_000) ?? '', ...(Array.isArray(o.words) ? { words: o.words.slice(0, 10_000).flatMap((w: any) => (typeof w?.w === 'string' && num(w.at) !== undefined ? [{ w: sanitize(w.w, 100), at: w.at }] : [])) } : {}) }
    case 'note': return { ...base, event: 'note', text: str(o.text, 20_000) ?? '' }
    case 'pick': case 'click': case 'hover': {
      const mode = ['canvas', 'interact', 'play'].includes(o.mode) ? o.mode : 'canvas'
      return { ...base, event: o.event, bundle: bundleOf(o.bundle), mode, ...(num(o.point) !== undefined ? { point: o.point } : {}), ...(o.selects === true ? { selects: true } : {}) }
    }
    case 'field': return { ...base, event: 'field', bundle: bundleOf(o.bundle), value: str(o.value, 2000) ?? '' }
    case 'screen': return { ...base, event: 'screen', to: str(o.to, 300) ?? '' }
    case 'scroll': return num(o.y) !== undefined ? { ...base, event: 'scroll', y: o.y } : null
    case 'view': return { ...base, event: 'view', view: viewOf(o.view) }
    case 'select': return { ...base, event: 'select', frames: strs(o.frames) }
    case 'device': return { ...base, event: 'device', frame: str(o.frame, 300) ?? '', viewport: str(o.viewport, 100) ?? '', width: num(o.width) ?? 0, height: num(o.height) ?? 0 }
    case 'theme': return o.theme === 'light' || o.theme === 'dark' ? { ...base, event: 'theme', theme: o.theme } : null
    case 'copied': return o.what === 'path' || o.what === 'image' ? { ...base, event: 'copied', what: o.what, frame: str(o.frame, 300) ?? '' } : null
    case 'interact': return { ...base, event: 'interact', on: o.on === true }
    case 'picture': return typeof o.id === 'string' && PICTURE_ID.test(o.id) ? { ...base, event: 'picture', id: o.id, why: ['key', 'pick', 'end'].includes(o.why) ? o.why : 'key' } : null
    case 'missing': return { ...base, event: 'missing', what: str(o.what, 300) ?? '' }
    default: return null
  }
}

/** Check a record the page posted: its shape, its id, its board; every step typed and capped. A
 *  `kind` (a category) anywhere is refused - a capture has none. Returns the record or why not. */
export function checkRecord(raw: unknown): CaptureRecord | string {
  if (!raw || typeof raw !== 'object') return 'expected a record'
  const r = raw as Record<string, any>
  if (r.format !== 'marver.jam.capture' || r.v !== 1) return 'not a marver.jam.capture v1 record'
  if (typeof r.id !== 'string' || !CAPTURE_ID.test(r.id)) return 'bad capture id'
  if ('kind' in r || (r.context && typeof r.context === 'object' && 'kind' in r.context)) return 'a capture has no category'
  const c = (r.context && typeof r.context === 'object' ? r.context : {}) as Record<string, any>
  if (typeof c.board !== 'string' || !BOARD.test(c.board)) return 'bad board'
  if (!Array.isArray(r.timeline) || r.timeline.length > MAX_STEPS) return 'bad timeline'
  if (JSON.stringify(raw).length > MAX_RECORD) return 'record too large'
  const rv = c.reviewing && typeof c.reviewing === 'object' ? c.reviewing : null
  const reviewing = rv && typeof rv.card === 'string' && typeof rv.batch === 'string' && Number.isInteger(rv.rev)
    ? { card: sanitize(rv.card, 200), batch: sanitize(rv.batch, 200), rev: rv.rev } : undefined
  const timeline = r.timeline.map(stepOf).filter((s: Step | null): s is Step => !!s)
    .sort((a: Step, b: Step) => a.at - b.at)
  const pictures = strs(r.pictures).filter((p) => PICTURE_ID.test(p)).slice(0, MAX_PICTURES)
  const rs = c.resumes && typeof c.resumes === 'object' ? c.resumes : null
  const resumes = rs && typeof rs.id === 'string' && CAPTURE_ID.test(rs.id) && rs.id !== r.id && num(rs.at) !== undefined ? { id: rs.id, at: rs.at as number } : undefined
  // each frame's size on screen: whole pixels within what a shot takes, a few dozen frames at most
  const px = (v: unknown) => { const n = num(v); return n !== undefined && n >= 1 && n <= 10_000 ? Math.round(n) : undefined }
  const sizes = Object.fromEntries(Object.entries(r.sizes && typeof r.sizes === 'object' && !Array.isArray(r.sizes) ? r.sizes as Record<string, any> : {}).slice(0, 50)
    .flatMap(([f, v]) => { const w = px(v?.w), h = px(v?.h); return /^[\w./-]{1,300}$/.test(f) && w && h ? [[f, { w, h, ...(v?.play === true ? { play: true as const } : {}) }]] : [] }))
  return {
    format: 'marver.jam.capture', v: 1, id: r.id,
    context: { canvas: str(c.canvas, 300) ?? '', board: c.board, ...(str(c.session, 200) ? { session: str(c.session, 200) } : {}), ...(reviewing ? { reviewing } : {}), ...(resumes ? { resumes } : {}), ...(c.interrupted === true ? { interrupted: true as const } : {}) },
    view: viewOf(r.view), timeline, pictures, ...(Object.keys(sizes).length ? { sizes } : {}),
  }
}

export const hashOf = (v: unknown): string => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex')

/** Store a sealed record once. A second post of the same record is a no-op; a different record under
 *  an id already stored is refused (the record never changes). */
export function storeCapture(root: string, record: CaptureRecord): { hash: string; existed: boolean } | string {
  const dir = capturesDir(root)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${record.id}.json`)
  const body = JSON.stringify(record)
  const hash = hashOf(body)
  if (existsSync(file)) return hashOf(readFileSync(file, 'utf8')) === hash ? { hash, existed: true } : 'a different capture is stored under this id'
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try { writeSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
  return { hash, existed: false }
}

/** A stored record and the hash of its bytes as they are now (a file edited after the seal hashes
 *  differently, and claim refuses it). */
export function readCapture(root: string, id: string): { record: CaptureRecord; hash: string } | null {
  if (!CAPTURE_ID.test(id)) return null
  try {
    const body = readFileSync(join(capturesDir(root), `${id}.json`), 'utf8')
    return { record: JSON.parse(body) as CaptureRecord, hash: hashOf(body) }
  } catch { return null }
}

/** When the capture started: the time in its id. */
export const madeOf = (id: string): number => Number(/^cap-(\d+)-/.exec(id)?.[1] ?? 0)

/** The frames a capture is about (what its run reserves, and pictures before and after): the ones you
 *  touched, not every frame that was on screen - the rule is shared with the page (shared/capture-frames.ts). */
export function captureFrames(r: CaptureRecord): string[] {
  return touchedFrames(r.timeline, r.view, true, r.context.resumes?.at)
}

/** What you said and wrote, in time order: the words and the notes merged - or your edit. */
export function captureWords(r: CaptureRecord, edited?: string): string {
  // an edit - even an empty one, which deleted everything - stands in for the words and the notes
  if (edited !== undefined) return edited.trim()
  return speechLines(r.timeline.flatMap((s) => (s.event === 'words' || s.event === 'note' ? [{ kind: s.event, text: s.text }] : [])))
}


/** The words and notes said or written after `since` (a resumed capture's new part - every step it
 *  carried over sits before that instant), in time order. */
export function wordsSince(r: CaptureRecord, since: number): string {
  return speechLines(r.timeline.filter((s) => s.at > since).flatMap((s) => (s.event === 'words' || s.event === 'note' ? [{ kind: s.event, text: s.text }] : [])))
}

/** Does `next` continue `prev` (Resume)? Every step of `prev`, in order, moved by one offset, comes
 *  first, all before `at`; then only steps after `at`; and every picture of `prev` is kept. */
export function continues(prev: CaptureRecord, next: CaptureRecord, at: number): boolean {
  const a = prev.timeline, b = next.timeline
  if (b.length < a.length || !prev.pictures.every((p) => next.pictures.includes(p))) return false
  if (!a.length) return b.every((x) => x.at > at)
  const d = b[0].at - a[0].at
  // times on the page clock are fractional milliseconds: "moved by d" holds to a microsecond
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-3
  const bare = (x: Step): string => { const { at: _a, ...r } = x as Step & { words?: unknown }; return JSON.stringify('words' in r && Array.isArray(r.words) ? { ...r, words: (r.words as { w: string }[]).map((w) => w.w) } : r) }
  const wordsMoved = (x: Step, y: Step): boolean => {
    const wx = (x as { words?: { at: number }[] }).words, wy = (y as { words?: { at: number }[] }).words
    if (!wx || !wy) return !wx && !wy
    // each word moved by d, and still before the resume
    return wx.length === wy.length && wx.every((w, i) => near(wy[i].at - w.at, d) && wy[i].at < at)
  }
  for (let i = 0; i < a.length; i++) if (!near(b[i].at - a[i].at, d) || b[i].at >= at || bare(a[i]) !== bare(b[i]) || !wordsMoved(a[i], b[i])) return false
  return b.slice(a.length).every((x) => x.at > at)
}

/** The first pick or click: where the capture's comment is pinned. */
export function firstPoint(r: CaptureRecord): { frame?: string; bundle: Bundle } | undefined {
  const s = r.timeline.find((x) => x.event === 'pick' || x.event === 'click') as (Step & { bundle: Bundle }) | undefined
  return s ? { frame: s.frame, bundle: s.bundle } : undefined
}

/** "0:19 · 2 points · 1 picture" - the short line a capture's comment carries. */
export function factsOf(r: CaptureRecord): string {
  const first = r.timeline[0]?.at ?? 0, last = r.timeline[r.timeline.length - 1]?.at ?? first
  const s = Math.max(0, Math.round((last - first) / 1000))
  const points = r.timeline.filter((x) => x.event === 'pick' || x.event === 'click').length
  const notes = r.timeline.filter((x) => x.event === 'note').length
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  return [`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, points ? plural(points, 'point') : '', r.pictures.length ? plural(r.pictures.length, 'picture') : '', notes ? plural(notes, 'note') : '']
    .filter(Boolean).join(' · ')
}

// ---- pictures ----------------------------------------------------------------------------------------

export interface PictureEntry { file: string; frame: string; when: number; capture?: string; batch?: string
  /** the stale-surface guard could not read it (0.26.1): kept, but not known to be free of Chrome's tiling */
  unchecked?: true }

const readIndex = (root: string): Record<string, PictureEntry> => {
  try { const v = JSON.parse(readFileSync(indexFile(root), 'utf8')); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
const writeIndex = (root: string, ix: Record<string, PictureEntry>) => {
  mkdirSync(jamDir(root), { recursive: true })
  const tmp = `${indexFile(root)}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(ix), { mode: 0o600 })
  renameSync(tmp, indexFile(root))
}

/** Keep a shot as a jam picture: copied into design/.local/jam/pictures under a new opaque id. Two
 *  shots of one frame are two files. */
export function addPicture(root: string, shotPath: string, entry: Omit<PictureEntry, 'file' | 'when'>): string {
  const id = `p-${randomBytes(8).toString('hex')}`
  mkdirSync(picturesDir(root), { recursive: true })
  const file = join('pictures', `${id}.png`)
  copyFileSync(resolve(root, shotPath), join(jamDir(root), file))
  const ix = readIndex(root)
  ix[id] = { file, when: Date.now(), ...entry }
  writeIndex(root, ix)
  return id
}

/** A picture's file by its id - looked up in the index, resolved, and it must stay inside
 *  design/.local/jam/ (an index entry that points elsewhere is refused). */
export function picturePath(root: string, id: string): { path: string; entry: PictureEntry } | null {
  if (!PICTURE_ID.test(id)) return null
  const entry = readIndex(root)[id]
  if (!entry || typeof entry.file !== 'string') return null
  try {
    const base = realpathSync(jamDir(root))
    const real = realpathSync(resolve(jamDir(root), entry.file))
    const rel = relative(base, real)
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return null
    return { path: real, entry }
  } catch { return null }
}

/** Pictures whose capture never sealed are removed after an hour. */
export function sweepPictures(root: string, now = Date.now()) {
  const ix = readIndex(root)
  let changed = false
  for (const [id, e] of Object.entries(ix)) {
    if (!e.capture || e.batch || now - e.when < 3_600_000) continue
    if (existsSync(join(capturesDir(root), `${e.capture}.json`))) continue
    try { rmSync(join(jamDir(root), e.file), { force: true }) } catch { /* gone */ }
    delete ix[id]; changed = true
  }
  if (changed) writeIndex(root, ix)
}

/** Every capture id stored (for the sweep and the tests). */
export const storedCaptures = (root: string): string[] => {
  try { return readdirSync(capturesDir(root)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) } catch { return [] }
}
export const pictureFileSize = (p: string): number => { try { return statSync(p).size } catch { return 0 } }
