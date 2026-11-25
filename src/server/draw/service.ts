/**
 * The drawing service (spec 38): one place every write to a drawing goes through - the frame's save, an agent's edit
 * of the file, a `marver draw` op. Per drawing, under one lock: merge, stamp the next rev, append the op log, write the
 * file atomically, broadcast the patch. The log line goes first (decision 7); a foreign version on disk is ingested
 * before any commit (decision 1).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { DrawElement, DrawHeader, DrawPatch, DrawSave } from '../../shared/draw-protocol.ts'
import { DrawFileError, assignIndexes, emptyDoc, parseDrawFile, serializeDrawFile, contentKey, wholeElement, type DrawDoc } from './file.ts'
import { agentOps, moveOps, ownerOps, repairRefs, type Lost, type Op } from './merge.ts'

export interface LogEntry {
  rev: number
  at: number
  by: string
  via: 'frame' | 'file' | 'cli' | 'create' | 'recover'
  epoch: string
  ops: Op[]
  header?: Partial<DrawHeader>
  files?: Record<string, unknown>
  lost?: Lost[]
}

export interface DrawServiceDeps {
  root: string
  /** the frame id -> its file, from the manifest (decision 25: drawings resolve through the manifest) */
  fileOf(id: string): string | null
  broadcast(event: 'sh:draw', patch: DrawPatch): void
  /** a header's title or size changed: the manifest should regenerate */
  headerChanged(id: string): void
  now?: () => number
}

export const SNAP_EVERY = 50
const OWN_HASHES = 16
const sha = (s: string) => createHash('sha1').update(s).digest('hex')
const newEpoch = () => randomBytes(6).toString('hex')

interface Drawing {
  id: string
  /** the file carried its epoch (else this session gave it one, written at the first commit) */
  fileEpoch: boolean
  abs: string
  key: string
  epoch: string
  doc: DrawDoc
  tomb: Map<string, number>
  log: LogEntry[]
  /** revs with a snapshot on disk (the first one: the state this session found) */
  snaps: number[]
  own: string[]
  diskHash: string
  /** the rev the disk's content stands for, and the `marver.rev` written in it */
  diskRev: number
  diskHeaderRev: number
  diskMtime: number
  seqs: Map<string, number>
  ops: string[]
  lock: Promise<unknown>
  /** changes of the agent's lost to the person's, for the next describe */
  lost: Lost[]
}

export class DrawService {
  private drawings = new Map<string, Drawing>()
  private dir: string
  private sweep: ReturnType<typeof setInterval> | null = null
  constructor(private deps: DrawServiceDeps) {
    this.dir = join(deps.root, 'design', '.local', 'draw')
  }
  private now() { return this.deps.now?.() ?? Date.now() }

  /** watch open drawings' mtimes (the watcher can miss events across atomic renames) */
  startSweep(ms = 1500): void {
    if (this.sweep) return
    this.sweep = setInterval(() => { for (const d of this.drawings.values()) void this.checkDisk(d.id) }, ms)
    this.sweep.unref?.()
  }
  stop(): void { if (this.sweep) clearInterval(this.sweep); this.sweep = null }

  // ---- reads ------------------------------------------------------------------------------------------------------

  async get(id: string): Promise<{ rev: number; header: DrawHeader; elements: DrawElement[]; files: Record<string, unknown>; background: string }> {
    const d = await this.open(id)
    return this.locked(d, async () => {
      this.absorb(d)
      return { rev: d.doc.header.rev, header: { ...d.doc.header, rev: d.doc.header.rev }, elements: [...d.doc.elements.values()], files: d.doc.files, background: d.doc.background }
    })
  }

  /** every rev after `rev`, as patches (or one full patch when the log no longer reaches that far) */
  async since(id: string, rev: number): Promise<{ rev: number; patches: DrawPatch[] }> {
    const d = await this.open(id)
    return this.locked(d, async () => ({ rev: d.doc.header.rev, patches: this.patchesSince(d, rev) }))
  }

  async describe(id: string, since?: number): Promise<string> {
    const d = await this.open(id)
    const { describeDrawing } = await import('./describe.ts')
    return this.locked(d, async () => {
      const text = describeDrawing(id, d.doc, d.log, since, d.lost)
      d.lost = []
      return text
    })
  }

  // ---- writes -----------------------------------------------------------------------------------------------------

  /** The person's save from the frame (owner-gated by the route). `sid`/`seq` drop a retried or reordered save. */
  async save(id: string, body: DrawSave, sid: string, seq: number): Promise<{ rev: number; patches: DrawPatch[] }> {
    const d = await this.open(id)
    return this.locked(d, async () => {
      this.absorb(d)
      const last = d.seqs.get(sid)
      if (last !== undefined && seq <= last) return { rev: d.doc.header.rev, patches: this.patchesSince(d, body.baseRev) }
      d.seqs.set(sid, seq)
      const ops = ownerOps(d.doc.elements, d.tomb, body.upserts ?? [], body.deletes ?? [], this.now())
      const header = cleanHeader(body.header)
      const files = cleanFiles(body.files)
      this.commit(d, ops, 'owner', 'frame', header, files)
      return { rev: d.doc.header.rev, patches: this.patchesSince(d, body.baseRev) }
    })
  }

  /** An agent's op (`marver draw add|set|move|rm`), applied to the current state. `opId` makes a retry a no-op. */
  async op(id: string, op: AgentOp, opId: string, by = 'agent'): Promise<{ rev: number; ids: string[] }> {
    const d = await this.open(id)
    return this.locked(d, async () => {
      this.absorb(d)
      if (opId && d.ops.includes(opId)) return { rev: d.doc.header.rev, ids: [] }
      const now = this.now()
      let ops: Op[] = []
      const els = d.doc.elements
      if (op.kind === 'add') {
        const fresh = op.elements.map((raw) => {
          const e = wholeElement(raw, by, now)
          if (els.has(e.id) || d.tomb.has(e.id)) e.id = `${e.id}-${randomBytes(2).toString('hex')}`
          return e
        })
        if (op.at && fresh.length) {
          const minX = Math.min(...fresh.filter((e) => !e.containerId).map((e) => Number(e.x)))
          const minY = Math.min(...fresh.filter((e) => !e.containerId).map((e) => Number(e.y)))
          for (const e of fresh) { e.x = Number(e.x) - minX + op.at.x; e.y = Number(e.y) - minY + op.at.y }
        }
        assignIndexes(els, fresh)
        ops = fresh.map((e) => ({ id: e.id, el: e, v: e.version }))
      } else if (op.kind === 'set') {
        const e = els.get(op.id)
        if (!e) throw new DrawOpError(`no element "${op.id}" in ${id}`)
        const patch: Record<string, unknown> = { ...op.fields }
        for (const k of ['id', 'version', 'versionNonce', 'isDeleted', 'index']) delete patch[k]
        if (typeof patch.text === 'string' && patch.originalText === undefined) patch.originalText = patch.text
        const v = e.version + 1
        ops = [{ id: e.id, v, el: { ...e, ...patch, version: v, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: now, customData: { ...(e.customData ?? {}), mv: { by, at: now } } } as DrawElement }]
      } else if (op.kind === 'move') {
        const missing = op.ids.filter((i) => !els.has(i))
        if (missing.length) throw new DrawOpError(`no element ${missing.map((m) => `"${m}"`).join(', ')} in ${id}`)
        ops = moveOps(els, op.ids, op.dx, op.dy, by, now)
      } else if (op.kind === 'rm') {
        const gone = new Set(op.ids.filter((i) => els.has(i)))
        for (const e of els.values()) if (e.containerId && gone.has(e.containerId as string)) gone.add(e.id)
        ops = [...gone].map((i) => ({ id: i, el: null, v: els.get(i)!.version + 1 }))
      }
      this.commit(d, ops, by, 'cli')
      if (opId) { d.ops.push(opId); if (d.ops.length > 200) d.ops.shift() }
      return { rev: d.doc.header.rev, ids: ops.map((o) => o.id) }
    })
  }

  /** The file changed on disk (the watcher, or the sweep): an agent's edit is merged; our own echo is skipped. */
  async onDisk(abs: string): Promise<void> {
    for (const d of this.drawings.values()) if (d.abs === abs) { await this.checkDisk(d.id); return }
  }

  /** A file removed: forget it (its log stays, keyed by the id, for a file that comes back). */
  forget(abs: string): void {
    for (const [id, d] of this.drawings) if (d.abs === abs) this.drawings.delete(id)
  }

  private async checkDisk(id: string): Promise<void> {
    const d = this.drawings.get(id)
    if (!d || mtime(d.abs) === d.diskMtime) return
    await this.locked(d, async () => { this.absorb(d) })
  }

  // ---- internals --------------------------------------------------------------------------------------------------

  private locked<T>(d: Drawing, fn: () => Promise<T>): Promise<T> {
    const run = d.lock.then(fn, fn)
    d.lock = run.catch(() => {})
    return run
  }

  private async open(id: string): Promise<Drawing> {
    const have = this.drawings.get(id)
    if (have) return have
    const file = this.deps.fileOf(id)
    if (!file || !file.endsWith('.excalidraw')) throw new DrawOpError(`no drawing "${id}" on this canvas`)
    const abs = join(this.deps.root, file)
    const design = join(this.deps.root, 'design') + sep
    if (!abs.startsWith(design)) throw new DrawOpError(`drawing "${id}" is outside design/`)
    const text = readText(abs)
    const doc = parseDrawFile(text)
    const key = sha(id).slice(0, 12) + '-' + id.replace(/[^\w-]+/g, '_').slice(-40)
    const d: Drawing = {
      id, abs, key, epoch: doc.header.epoch ?? newEpoch(), fileEpoch: !!doc.header.epoch, doc, tomb: new Map(), log: [], snaps: [], own: [],
      diskHash: sha(text), diskRev: doc.header.rev, diskHeaderRev: doc.header.rev, diskMtime: mtime(abs), seqs: new Map(), ops: [], lock: Promise.resolve(), lost: [],
    }
    this.loadLog(d)
    this.drawings.set(id, d)
    return d
  }

  /** read the op log and snapshots; a log ahead of the file rebuilds it (decision 7); none: snapshot what we found */
  private loadLog(d: Drawing): void {
    mkdirSync(this.dir, { recursive: true })
    const logPath = join(this.dir, `${d.key}.jsonl`)
    const lines: LogEntry[] = []
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { lines.push(JSON.parse(line)) } catch { /* a torn last line */ }
      }
    }
    const snaps = this.snapRevs(d.key)
    const sameHistory = d.fileEpoch && lines.length > 0 && lines.every((l) => l.epoch === d.epoch)
    if (!sameHistory) {
      // a log of another history (a copied file, a fresh checkout): kept aside, and this file starts a new one
      if (lines.length) try { renameSync(logPath, `${logPath}.stale-${Date.now()}`) } catch { /* best-effort */ }
      d.log = []
      d.snaps = []
      this.writeSnap(d)
      return
    }
    d.log = lines
    d.snaps = snaps
    for (const l of lines) for (const o of l.ops) if (o.el === null) d.tomb.set(o.id, o.v)
    const lastRev = lines[lines.length - 1].rev
    if (lastRev > d.doc.header.rev) {
      const state = this.stateAt(d, lastRev)
      if (state) {
        d.doc = state.doc
        d.tomb = state.tomb
        this.writeFile(d, true)
      }
    }
    if (!d.snaps.length || d.snaps[d.snaps.length - 1] < d.doc.header.rev - SNAP_EVERY) this.writeSnap(d)
  }

  private snapRevs(key: string): number[] {
    try {
      return readdirSync(this.dir).map((f) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.snap-(\\d+)\\.json$`).exec(f)?.[1]).filter((r): r is string => !!r).map(Number).sort((a, b) => a - b)
    } catch { return [] }
  }

  private writeSnap(d: Drawing): void {
    const rev = d.doc.header.rev
    const snap = { epoch: d.epoch, rev, header: d.doc.header, elements: [...d.doc.elements.values()], tomb: [...d.tomb], files: d.doc.files, background: d.doc.background }
    try {
      writeFileSync(join(this.dir, `${d.key}.snap-${rev}.json`), JSON.stringify(snap))
      if (!d.snaps.includes(rev)) d.snaps.push(rev)
      d.snaps.sort((a, b) => a - b)
    } catch { /* a snapshot is an optimisation and a base; the log still holds */ }
  }

  /** the state at a rev: the latest snapshot at or before it, plus the log replayed (null when it cannot be rebuilt) */
  private stateAt(d: Drawing, rev: number): { doc: DrawDoc; tomb: Map<string, number> } | null {
    if (rev === d.doc.header.rev) return { doc: { ...d.doc, elements: new Map(d.doc.elements) }, tomb: new Map(d.tomb) }
    const at = [...d.snaps].reverse().find((s) => s <= rev)
    if (at === undefined) return null
    let snap: any
    try { snap = JSON.parse(readFileSync(join(this.dir, `${d.key}.snap-${at}.json`), 'utf8')) } catch { return null }
    if (snap.epoch !== d.epoch) return null
    const doc: DrawDoc = { header: { ...snap.header }, elements: new Map((snap.elements as DrawElement[]).map((e) => [e.id, e])), files: snap.files ?? {}, background: snap.background ?? '#ffffff', foreign: false }
    const tomb = new Map<string, number>(snap.tomb ?? [])
    for (const l of d.log) {
      if (l.rev <= at || l.rev > rev) continue
      applyEntry(doc, tomb, l)
    }
    return doc.header.rev === rev || rev <= (d.log[d.log.length - 1]?.rev ?? at) ? { doc, tomb } : null
  }

  private patchesSince(d: Drawing, rev: number): DrawPatch[] {
    if (rev >= d.doc.header.rev) return []
    const first = d.log.find((l) => l.rev > rev)
    if (!first || first.rev !== rev + 1) {
      // the log does not reach back that far: one patch with everything
      return [{ frame: d.id, rev: d.doc.header.rev, by: 'server', upserts: [...d.doc.elements.values()], deletes: [...d.tomb].map(([id, version]) => ({ id, version })), header: d.doc.header, files: d.doc.files } as DrawPatch]
    }
    return d.log.filter((l) => l.rev > rev).map((l) => toPatch(d.id, l))
  }

  /** a version on disk we did not write: ingest it (the agent's edit), before anything else commits (decision 1) */
  private absorb(d: Drawing): void {
    let text: string
    try { text = readFileSync(d.abs, 'utf8') } catch { return }
    const h = sha(text)
    d.diskMtime = mtime(d.abs)
    if (h === d.diskHash || d.own.includes(h)) { d.diskHash = h; return }
    let theirs: DrawDoc
    try { theirs = parseDrawFile(text) } catch (err) {
      if (err instanceof DrawFileError) { console.error(`[marver] ${relative(this.deps.root, d.abs)} is not a drawing right now (${err.message}) - left as it was; the next valid write is merged`); return }
      throw err
    }
    const tEpoch = theirs.header.epoch ?? ''
    const sameEpoch = tEpoch ? tEpoch === d.epoch : !d.fileEpoch
    // the base: the rev the agent's file was derived from - the disk's own when it kept the disk's header rev
    const baseRev = !theirs.foreign && sameEpoch
      ? (theirs.header.rev === d.diskHeaderRev ? d.diskRev : theirs.header.rev)
      : null
    const baseState = baseRev !== null ? this.stateAt(d, baseRev) : null
    const from = baseState ? baseRev! : d.diskRev
    const ownerSince = new Map<string, number>()
    for (const l of d.log) if (l.rev > from && l.by === 'owner') for (const o of l.ops) ownerSince.set(o.id, l.rev)
    const now = this.now()
    const { ops, lost } = agentOps(baseState ? baseState.doc.elements : null, theirs.elements, d.doc.elements, d.tomb, ownerSince, 'agent', now)
    const header: Partial<DrawHeader> = {}
    if (theirs.header.title !== undefined && theirs.header.title !== d.doc.header.title) header.title = theirs.header.title
    if (theirs.header.size && (theirs.header.size.w !== d.doc.header.size?.w || theirs.header.size.h !== d.doc.header.size?.h)) header.size = theirs.header.size
    if (theirs.header.view && JSON.stringify(theirs.header.view) !== JSON.stringify(d.doc.header.view)) header.view = theirs.header.view
    const files: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(theirs.files)) if (!(k in d.doc.files)) files[k] = v
    if (lost.length) d.lost.push(...lost)
    // the disk now holds the agent's text; it stands for the rev this commit makes (or the current one)
    d.diskHash = h
    d.diskHeaderRev = theirs.header.rev
    if (!ops.length && !Object.keys(header).length && !Object.keys(files).length) { d.diskRev = d.doc.header.rev; return }
    this.commit(d, ops, 'agent', 'file', Object.keys(header).length ? header : undefined, Object.keys(files).length ? files : undefined, lost, theirs)
  }

  private commit(d: Drawing, ops: Op[], by: string, via: LogEntry['via'], header?: Partial<DrawHeader>, files?: Record<string, unknown>, lost?: Lost[], agentFile?: DrawDoc): void {
    if (!ops.length && !header && !files) return
    const now = this.now()
    const rev = d.doc.header.rev + 1
    // apply, then repair what an agent's change may have broken (decision 11)
    const entry: LogEntry = { rev, at: now, by, via, epoch: d.epoch, ops, ...(header ? { header } : {}), ...(files ? { files } : {}), ...(lost?.length ? { lost } : {}) }
    const titleWas = d.doc.header.title, sizeWas = JSON.stringify(d.doc.header.size)
    applyEntry(d.doc, d.tomb, entry)
    if (by !== 'owner') {
      const fresh = ops.filter((o) => o.el).map((o) => d.doc.elements.get(o.id)!).filter(Boolean)
      assignIndexes(d.doc.elements, fresh.filter((e) => !e.index))
      const fixed = repairRefs(d.doc.elements, ops.map((o) => o.id), now)
      for (const f of fixed) { const i = entry.ops.findIndex((o) => o.id === f.id); const op = { id: f.id, el: f, v: f.version }; if (i >= 0) entry.ops[i] = op; else entry.ops.push(op) }
    }
    // the log first: a crash after it leaves a file the log can rebuild (decision 7)
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(join(this.dir, `${d.key}.jsonl`), JSON.stringify(entry) + '\n')
    d.log.push(entry)
    // an agent's file that already says everything the merge kept: not rewritten, so its next Edit still applies
    const rewrite = !agentFile || !sameDocContent(d.doc, agentFile)
    if (rewrite) this.writeFile(d)
    else d.diskRev = rev
    if (rev % SNAP_EVERY === 0) this.writeSnap(d)
    this.deps.broadcast('sh:draw', toPatch(d.id, entry))
    if (d.doc.header.title !== titleWas || JSON.stringify(d.doc.header.size) !== sizeWas) this.deps.headerChanged(d.id)
  }

  private writeFile(d: Drawing, quiet = false): void {
    const text = serializeDrawFile({ ...d.doc, header: { ...d.doc.header, epoch: d.epoch } })
    d.fileEpoch = true
    const tmp = `${d.abs}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, text, { flag: 'wx' })
    renameSync(tmp, d.abs)
    const h = sha(text)
    d.own.push(h)
    if (d.own.length > OWN_HASHES) d.own.shift()
    d.diskHash = h
    d.diskRev = d.doc.header.rev
    d.diskHeaderRev = d.doc.header.rev
    d.diskMtime = mtime(d.abs)
    void quiet
  }

  // ---- creating a drawing -----------------------------------------------------------------------------------------

  /** a new, empty drawing file (spec 38: `W`, `marver draw new`). Returns its frame id. Throws on a bad or taken name. */
  static create(root: string, scene: string, name: string | undefined, opts: { title?: string; size?: { w: number; h: number } } = {}): { id: string; file: string } {
    if (!NAME.test(scene)) throw new DrawOpError(`scene "${scene}" - use lowercase letters, digits and dashes`)
    const dir = join(root, 'design', 'scenes', scene)
    let n = name
    if (n !== undefined && !NAME.test(n)) throw new DrawOpError(`name "${n}" - use lowercase letters, digits and dashes`)
    if (!n) {
      let i = 1
      while (existsSync(join(dir, `sketch-${String(i).padStart(2, '0')}.excalidraw`))) i++
      n = `sketch-${String(i).padStart(2, '0')}`
    }
    const abs = join(dir, `${n}.excalidraw`)
    if (['.tsx', '.jsx', '.html', '.excalidraw'].some((ext) => existsSync(join(dir, `${n}${ext}`)))) throw new DrawOpError(`a frame "${scene}/${n}" already exists`)
    mkdirSync(dirname(abs), { recursive: true })
    const doc = emptyDoc({ title: opts.title, size: opts.size ?? { w: 960, h: 640 } })
    writeFileSync(abs, serializeDrawFile({ ...doc, header: { ...doc.header, epoch: newEpoch() } }), { flag: 'wx' })
    return { id: `${scene}/${n}`, file: `design/scenes/${scene}/${n}.excalidraw` }
  }
}

export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
export class DrawOpError extends Error {}

export type AgentOp =
  | { kind: 'add'; elements: Record<string, unknown>[]; at?: { x: number; y: number } }
  | { kind: 'set'; id: string; fields: Record<string, unknown> }
  | { kind: 'move'; ids: string[]; dx: number; dy: number }
  | { kind: 'rm'; ids: string[] }

function applyEntry(doc: DrawDoc, tomb: Map<string, number>, l: LogEntry): void {
  for (const o of l.ops) {
    if (o.el) { doc.elements.set(o.id, { ...o.el, isDeleted: false }); tomb.delete(o.id) }
    else { doc.elements.delete(o.id); tomb.set(o.id, o.v) }
  }
  if (l.header) doc.header = { ...doc.header, ...l.header }
  if (l.files) doc.files = { ...doc.files, ...l.files }
  doc.header.rev = l.rev
}

function toPatch(frame: string, l: LogEntry): DrawPatch {
  return {
    frame, rev: l.rev, by: l.by,
    upserts: l.ops.filter((o) => o.el).map((o) => o.el!),
    deletes: l.ops.filter((o) => !o.el).map((o) => ({ id: o.id, version: o.v })),
    ...(l.header ? { header: l.header } : {}),
    ...(l.files ? { files: l.files } : {}),
  } as DrawPatch
}

function sameDocContent(a: DrawDoc, b: DrawDoc): boolean {
  if (a.elements.size !== b.elements.size) return false
  for (const [id, e] of a.elements) { const o = b.elements.get(id); if (!o || contentKey(e) !== contentKey(o)) return false }
  return (a.header.title ?? '') === (b.header.title ?? '') && JSON.stringify(a.header.size) === JSON.stringify(b.header.size)
}

function cleanHeader(h: DrawSave['header']): Partial<DrawHeader> | undefined {
  if (!h || typeof h !== 'object') return undefined
  const out: Partial<DrawHeader> = {}
  if (h.view && [h.view.x, h.view.y, h.view.zoom].every((n) => Number.isFinite(n)) && h.view.zoom > 0) out.view = { x: h.view.x, y: h.view.y, zoom: h.view.zoom }
  if (typeof h.title === 'string') out.title = h.title.slice(0, 200)
  if (h.size && Number.isFinite(h.size.w) && Number.isFinite(h.size.h) && h.size.w >= 120 && h.size.h >= 80) out.size = { w: Math.round(h.size.w), h: Math.round(h.size.h) }
  return Object.keys(out).length ? out : undefined
}

function cleanFiles(f: unknown): Record<string, unknown> | undefined {
  if (!f || typeof f !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(f as Record<string, any>)) {
    if (!/^[\w-]{1,128}$/.test(k) || !v || typeof v !== 'object' || typeof v.dataURL !== 'string' || !/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(v.dataURL)) continue
    out[k] = { id: k, mimeType: String(v.mimeType ?? ''), dataURL: v.dataURL, created: Number(v.created) || Date.now() }
  }
  return Object.keys(out).length ? out : undefined
}

function readText(abs: string): string {
  try { return readFileSync(abs, 'utf8') } catch (e) { throw new DrawOpError(`cannot read ${abs}: ${(e as Error).message}`) }
}
function mtime(abs: string): number { try { return statSync(abs).mtimeMs } catch { return 0 } }
