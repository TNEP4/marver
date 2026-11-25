/**
 * The draw host's side of the revs (spec 38): saves what the person changed, applies what others changed.
 *
 * - `known` holds, per element, the version the server has confirmed for it here. An element whose local version is
 *   above it was changed here and is in the next save. A rev from the server raises it.
 * - Revs apply strictly in order (a buffer holds early ones; a gap is closed by asking the server). A full snapshot
 *   (the log no longer reaches back) is applied as one authoritative replacement.
 * - One save in flight at a time; it acknowledges only the versions it actually sent (a snapshot taken before the
 *   request). Elements changed here and not yet confirmed are protected: a rev never overwrites them - their latest
 *   server state is kept aside and applied once the protection lifts, so an agent's later change is never lost.
 * - A rev touching what the person is dragging or typing in waits for pointer-up (2 s at most).
 * - `drain()` resolves once nothing is pending (leaving play, the page hiding).
 */
import type { DrawElement, DrawPatch, DrawSave } from '../../shared/draw-protocol.ts'

export interface SyncEngine {
  elements(): readonly DrawElement[]
  applyRemote(upserts: DrawElement[], deletes: { id: string; version: number }[], protect: Set<string>, repair: boolean, files?: Record<string, unknown>): void
  appState(): any
  files(): Record<string, unknown>
}
export interface SyncIO {
  put(body: DrawSave & { sid: string; seq: number }, keepalive?: boolean): Promise<{ rev: number; patches?: DrawPatch[] }>
  since(rev: number): Promise<{ rev: number; patches: DrawPatch[] }>
}

export const SAVE_IDLE_MS = 250
export const HOLD_MAX_MS = 2000
export const GAP_MS = 400

type Deferred = { el: DrawElement | null; version: number; by: string }

export class DrawSync {
  rev: number
  private known = new Map<string, number>()
  private inFlight = false
  private again = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private down = false
  private buffer = new Map<number, DrawPatch>()
  private fullWaiting: DrawPatch | null = null
  private holdSince = 0
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private gapTimer: ReturnType<typeof setTimeout> | null = null
  private headerNext: DrawSave['header'] | null = null
  /** ids sent in the save in flight */
  private sending = new Set<string>()
  /** the server's latest state of elements that were protected when it arrived */
  private deferred = new Map<string, Deferred>()
  private sentFiles = new Set<string>()
  private sid = Math.random().toString(36).slice(2, 12)
  private seq = 0
  private drains: (() => void)[] = []
  pending = 0
  onState: () => void = () => {}
  onError: (msg: string) => void = () => {}

  private engine: () => SyncEngine | null
  private io: SyncIO
  private editable: boolean
  constructor(engine: () => SyncEngine | null, io: SyncIO, rev: number, initial: readonly DrawElement[], editable: boolean) {
    this.engine = engine; this.io = io; this.editable = editable
    this.rev = rev
    for (const e of initial) this.known.set(e.id, e.version)
  }

  knownFiles(ids: string[]): void { for (const id of ids) this.sentFiles.add(id) }

  /** catch up once (the engine is ready, a reconnect): everything after our rev */
  resync(): void { void this.catchUp() }

  /** the engine became ready: apply what waited for it */
  ready(): void {
    if (this.fullWaiting) { const f = this.fullWaiting; this.fullWaiting = null; this.applyFull(f) }
    this.drainBuffer()
  }

  changed(): void {
    if (!this.editable) return
    const eng = this.engine()
    if (!eng) return
    if (this.dirty(eng.elements())) this.schedule()
  }

  pointer(down: boolean): void {
    this.down = down
    if (down) return
    this.drainBuffer()
    this.changed()
  }

  header(h: NonNullable<DrawSave['header']>): void {
    if (!this.editable) return
    this.headerNext = { ...this.headerNext, ...h }
    this.schedule(0)
  }

  /** save now; resolves when this save (and any it queued) is done */
  flush(keepalive = false): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    void this.save(keepalive)
    return this.drain()
  }

  /** resolves once nothing is queued, in flight or dirty */
  drain(): Promise<void> {
    if (this.idle()) return Promise.resolve()
    return new Promise((r) => { this.drains.push(r) })
  }
  private idle(): boolean {
    const eng = this.engine()
    return !this.inFlight && !this.timer && !this.again && !this.headerNext && !(eng && this.editable && this.dirty(eng.elements()))
  }
  private settle(): void {
    if (!this.idle()) return
    for (const r of this.drains.splice(0)) r()
  }

  // ---- receiving ------------------------------------------------------------------------------------------------

  receive(p: DrawPatch): void {
    if ((p as DrawPatch & { full?: boolean }).full) { this.applyFull(p); return }
    if (p.rev <= this.rev) return
    this.buffer.set(p.rev, p)
    this.drainBuffer()
  }

  private drainBuffer(): void {
    if (!this.engine()) return
    while (this.buffer.has(this.rev + 1)) {
      const p = this.buffer.get(this.rev + 1)!
      if (this.down && this.touchesActive(p) && Date.now() - this.holdSince < HOLD_MAX_MS) {
        if (!this.holdTimer) { this.holdSince = Date.now(); this.holdTimer = setTimeout(() => { this.holdTimer = null; this.holdSince = -Infinity; this.drainBuffer() }, HOLD_MAX_MS) }
        return
      }
      this.buffer.delete(this.rev + 1)
      this.apply(p)
    }
    if (!this.buffer.size) { if (this.holdTimer) clearTimeout(this.holdTimer); this.holdTimer = null; this.holdSince = 0 }
    // a gap: something was missed - ask for everything after our rev
    if (this.buffer.size && !this.buffer.has(this.rev + 1) && !this.gapTimer) this.gapTimer = setTimeout(() => { this.gapTimer = null; if (this.buffer.size) void this.catchUp() }, GAP_MS)
  }

  private protectedIds(): Set<string> {
    const eng = this.engine()
    const out = new Set<string>(this.sending)
    if (eng) for (const e of eng.elements()) if (e.version > (this.known.get(e.id) ?? -1) && !(e.isDeleted && !this.known.has(e.id))) out.add(e.id)
    return out
  }

  private apply(p: DrawPatch): void {
    const eng = this.engine()!
    const protect = this.protectedIds()
    const local = new Map(eng.elements().map((e) => [e.id, e]))
    for (const u of p.upserts) if (protect.has(u.id)) this.deferred.set(u.id, { el: u, version: u.version, by: p.by })
    for (const d of p.deletes) if (protect.has(d.id)) this.deferred.set(d.id, { el: null, version: d.version, by: p.by })
    const ups = p.upserts.filter((u) => !protect.has(u.id)).filter((u) => { const l = local.get(u.id); return !l || l.version !== u.version || l.versionNonce !== u.versionNonce })
    const dels = p.deletes.filter((d) => !protect.has(d.id)).filter((d) => { const l = local.get(d.id); return l && !l.isDeleted })
    const files = p.files && Object.keys(p.files).length ? p.files : undefined
    if (files) for (const id of Object.keys(files)) this.sentFiles.add(id)
    if (ups.length || dels.length || files) eng.applyRemote(ups, dels, protect, p.by !== 'owner', files)
    this.acknowledge(p.upserts.filter((u) => !protect.has(u.id)).map((u) => [u.id, u.version]), p.deletes.filter((d) => !protect.has(d.id)).map((d) => [d.id, d.version]))
    this.rev = Math.max(this.rev, p.rev)
    this.onState()
  }

  /** the server's versions are known here - and whatever Excalidraw raised them to while applying them (its
   *  normalising pass runs inside updateScene), read at once, so a later edit by the person is never absorbed */
  private acknowledge(ups: [string, number][], dels: [string, number][]): void {
    const now = new Map(this.engine()?.elements().map((e) => [e.id, e.version]) ?? [])
    for (const [id, v] of ups) this.known.set(id, Math.max(this.known.get(id) ?? 0, v, now.get(id) ?? 0))
    for (const [id, v] of dels) this.known.set(id, Math.max(this.known.get(id) ?? 0, v, now.get(id) ?? 0))
  }

  /** the log did not reach back: the server's whole state, replacing everything not protected */
  private applyFull(p: DrawPatch): void {
    const eng = this.engine()
    if (!eng) { this.fullWaiting = p; return }
    const protect = this.protectedIds()
    const have = new Set(p.upserts.map((u) => u.id))
    const extra = eng.elements().filter((e) => !e.isDeleted && !have.has(e.id) && !protect.has(e.id)).map((e) => ({ id: e.id, version: e.version + 1 }))
    for (const r of [...this.buffer.keys()]) if (r <= p.rev) this.buffer.delete(r)
    this.apply({ ...p, deletes: [...p.deletes, ...extra] })
    this.rev = p.rev
    this.drainBuffer()
  }

  /** a protection lifted: what the server holds for those elements now applies */
  private applyDeferred(): void {
    if (!this.deferred.size) return
    const eng = this.engine()
    if (!eng) return
    const protect = this.protectedIds()
    const ups: DrawElement[] = [], dels: { id: string; version: number }[] = []
    const local = new Map(eng.elements().map((e) => [e.id, e]))
    for (const [id, d] of [...this.deferred]) {
      if (protect.has(id)) continue
      this.deferred.delete(id)
      const l = local.get(id)
      if (d.el) { if (!l || l.version !== d.el.version || l.versionNonce !== d.el.versionNonce) ups.push(d.el) }
      else if (l && !l.isDeleted) dels.push({ id, version: d.version })
    }
    if (ups.length || dels.length) {
      eng.applyRemote(ups, dels, protect, true)
      this.acknowledge(ups.map((u) => [u.id, u.version]), dels.map((d) => [d.id, d.version]))
      this.onState()
    }
  }

  private touchesActive(p: DrawPatch): boolean {
    const s = this.engine()?.appState()
    if (!s) return false
    const active = new Set<string>()
    for (const id of Object.keys(s.selectedElementIds ?? {})) if (s.selectedElementIds[id]) active.add(id)
    for (const k of ['newElement', 'resizingElement', 'editingTextElement', 'multiElement', 'selectedLinearElement']) {
      const v = s[k]
      const id = v?.id ?? v?.elementId
      if (id) active.add(id)
    }
    return p.upserts.some((u) => active.has(u.id)) || p.deletes.some((d) => active.has(d.id))
  }

  // ---- saving ---------------------------------------------------------------------------------------------------

  private dirty(els: readonly DrawElement[]): boolean {
    for (const e of els) if (e.version > (this.known.get(e.id) ?? -1) && !(e.isDeleted && !this.known.has(e.id))) return true
    return !!this.headerNext
  }

  private schedule(ms = SAVE_IDLE_MS): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.pending) { this.pending = 1; this.onState() }
    this.timer = setTimeout(() => { this.timer = null; if (this.down) { this.schedule(); return } void this.save() }, ms)
  }

  private async save(keepalive = false): Promise<void> {
    if (!this.editable) { this.settle(); return }
    if (this.inFlight) { this.again = true; return }
    const eng = this.engine()
    if (!eng) { this.settle(); return }
    // a snapshot of what is sent: the request carries these versions, and only these are acknowledged
    const upserts: DrawElement[] = []
    const deletes: { id: string; version: number }[] = []
    for (const e of eng.elements()) {
      const k = this.known.get(e.id)
      if (k !== undefined && e.version <= k) continue
      if (e.isDeleted) { if (k !== undefined) deletes.push({ id: e.id, version: e.version }) }
      else upserts.push(JSON.parse(JSON.stringify(e)))
    }
    const allFiles = eng.files()
    const files: Record<string, unknown> = {}
    for (const u of upserts) { const fid = u.fileId as string | undefined; if (fid && !this.sentFiles.has(fid) && allFiles[fid]) files[fid] = allFiles[fid] }
    const header = this.headerNext
    this.headerNext = null
    if (!upserts.length && !deletes.length && !header) { this.pending = 0; this.onState(); this.settle(); return }
    this.inFlight = true
    for (const u of upserts) this.sending.add(u.id)
    for (const d of deletes) this.sending.add(d.id)
    const seq = ++this.seq
    try {
      const ans = await this.io.put({ baseRev: this.rev, upserts, deletes, sid: this.sid, seq, ...(header ? { header } : {}), ...(Object.keys(files).length ? { files } : {}) }, keepalive)
      for (const u of upserts) this.known.set(u.id, Math.max(this.known.get(u.id) ?? 0, u.version))
      for (const d of deletes) this.known.set(d.id, Math.max(this.known.get(d.id) ?? 0, d.version))
      for (const fid of Object.keys(files)) this.sentFiles.add(fid)
      this.sending.clear()
      for (const p of ans.patches ?? []) this.receive(p)
      this.applyDeferred()
    } catch (err) {
      this.sending.clear()
      if (header) this.headerNext = { ...header, ...(this.headerNext ?? {}) }
      this.onError((err as Error).message || 'save failed')
      setTimeout(() => this.changed(), 2000)
    } finally {
      this.inFlight = false
      const eng2 = this.engine()
      // someone waits for everything to be saved (leaving play, the page hiding): what was drawn meanwhile goes now
      const owed = this.drains.length > 0 && !!eng2 && this.dirty(eng2.elements())
      if (this.again || owed) { this.again = false; if (this.timer) { clearTimeout(this.timer); this.timer = null } void this.save() }
      else if (!this.timer) { this.pending = 0; this.onState() }
      this.settle()
    }
  }

  private catching = false
  private async catchUp(): Promise<void> {
    if (this.catching) return
    this.catching = true
    try {
      const ans = await this.io.since(this.rev)
      for (const p of ans.patches) this.receive(p)
    } catch { /* the next rev or save tries again */ } finally {
      this.catching = false
      if (this.buffer.size && !this.buffer.has(this.rev + 1) && !this.gapTimer) this.gapTimer = setTimeout(() => { this.gapTimer = null; void this.catchUp() }, GAP_MS * 4)
    }
  }
}
