/**
 * The draw host's side of the revs (spec 38): saves what the person changed, applies what others changed.
 *
 * - `known` holds, per element, the version the server last confirmed. An element whose local version is above it was
 *   changed here: it is in the next save. A rev from the server raises `known` (so an agent's change is never sent
 *   back as ours).
 * - One save in flight at a time; changes made meanwhile go in the next. A save leaves 250 ms after the last change,
 *   never while the pointer is down, and at once on `flush()` (leaving drawing mode, the page hiding).
 * - A rev that touches what the person is dragging or typing in waits for pointer-up (2 s at most) - everything else
 *   applies at once. A gap in revs (a missed broadcast) is closed by asking the server for everything since our rev.
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

export class DrawSync {
  rev: number
  private known = new Map<string, number>()
  private inFlight = false
  private again = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private down = false
  private held: DrawPatch[] = []
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private headerNext: DrawSave['header'] | null = null
  /** ids sent in the save in flight: theirs until the server answers (decision 3) */
  private sending = new Set<string>()
  /** image files the server has (by id): new ones ride the next save */
  private sentFiles = new Set<string>()
  /** this frame's session and its save sequence (decision 5: a retried or reordered save is dropped) */
  private sid = Math.random().toString(36).slice(2, 12)
  private seq = 0
  /** saves queued or in flight - the shell can show "saving" */
  pending = 0
  onState: () => void = () => {}
  onError: (msg: string) => void = () => {}

  constructor(private engine: () => SyncEngine | null, private io: SyncIO, rev: number, initial: readonly DrawElement[], private editable: boolean) {
    this.rev = rev
    for (const e of initial) this.known.set(e.id, e.version)
  }

  /** the files the drawing loaded with are the server's */
  knownFiles(ids: string[]): void { for (const id of ids) this.sentFiles.add(id) }

  /** catch up once (after mounting, on a reconnect): everything after our rev */
  resync(): void { void this.catchUp() }

  /** the engine changed: anything above `known` is ours to save */
  changed(): void {
    if (!this.editable) return
    const eng = this.engine()
    if (!eng) return
    if (this.dirty(eng.elements())) this.schedule()
  }

  pointer(down: boolean): void {
    this.down = down
    if (down) return
    this.release()
    this.changed()
  }

  /** the frame's own view, or its title or size: saved with the next save */
  header(h: NonNullable<DrawSave['header']>): void {
    if (!this.editable) return
    this.headerNext = { ...this.headerNext, ...h }
    this.schedule(0)
  }

  /** save now (leaving drawing mode, the page hiding) */
  flush(keepalive = false): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    return this.save(keepalive)
  }

  /** a merged rev from the server (the HMR broadcast, or a save's answer) */
  receive(p: DrawPatch): void {
    if (p.rev <= this.rev) return
    if (p.rev > this.rev + 1 && !this.inFlight) { void this.catchUp(); return }
    if (this.down && this.touchesActive(p)) {
      this.held.push(p)
      if (!this.holdTimer) this.holdTimer = setTimeout(() => this.release(), HOLD_MAX_MS)
      return
    }
    this.apply(p)
  }

  private apply(p: DrawPatch): void {
    if (p.rev <= this.rev) return
    const eng = this.engine()
    if (!eng) return
    // the person's unconfirmed changes stay (decision 3): what they changed and the server has not answered for
    const local = new Map(eng.elements().map((e) => [e.id, e]))
    const protect = new Set<string>(this.sending)
    for (const [id, e] of local) if (e.version > (this.known.get(id) ?? -1)) protect.add(id)
    const ups = p.upserts.filter((u) => { const l = local.get(u.id); return !l || l.version !== u.version || l.versionNonce !== u.versionNonce })
    const dels = p.deletes.filter((d) => { const l = local.get(d.id); return l && !l.isDeleted })
    const files = p.files && Object.keys(p.files).length ? p.files : undefined
    if (files) for (const id of Object.keys(files)) this.sentFiles.add(id)
    if (ups.length || dels.length || files) eng.applyRemote(ups, dels, protect, p.by !== 'owner', files)
    for (const u of p.upserts) if (!protect.has(u.id)) this.known.set(u.id, Math.max(this.known.get(u.id) ?? 0, u.version))
    for (const d of p.deletes) if (!protect.has(d.id)) this.known.set(d.id, Math.max(this.known.get(d.id) ?? 0, d.version))
    // Excalidraw may raise a version while it normalises what it got (text measure, binding repair): absorbed, never
    // saved as the person's (decision 4)
    const touched = [...p.upserts.map((u) => u.id), ...p.deletes.map((d) => d.id)].filter((id) => !protect.has(id))
    if (touched.length) requestAnimationFrame(() => {
      const now = new Map(this.engine()?.elements().map((e) => [e.id, e.version]) ?? [])
      for (const id of touched) { const v = now.get(id); if (v !== undefined && v > (this.known.get(id) ?? -1)) this.known.set(id, v) }
    })
    this.rev = p.rev
    this.onState()
  }

  private release(): void {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null }
    const held = this.held.sort((a, b) => a.rev - b.rev)
    this.held = []
    for (const p of held) this.apply(p)
  }

  /** does this rev touch what the person is dragging, resizing, drawing or typing in right now? */
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

  private dirty(els: readonly DrawElement[]): boolean {
    for (const e of els) if (e.version > (this.known.get(e.id) ?? -1) && !(e.isDeleted && !this.known.has(e.id))) return true
    return !!this.headerNext
  }

  private schedule(ms = SAVE_IDLE_MS): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.pending) { this.pending = 1; this.onState() }
    this.timer = setTimeout(() => { this.timer = null; if (this.down) return; void this.save() }, ms)
  }

  private async save(keepalive = false): Promise<void> {
    if (!this.editable) return
    if (this.inFlight) { this.again = true; return }
    const eng = this.engine()
    if (!eng) return
    const upserts: DrawElement[] = []
    const deletes: { id: string; version: number }[] = []
    for (const e of eng.elements()) {
      const k = this.known.get(e.id)
      if (k !== undefined && e.version <= k) continue
      if (e.isDeleted) { if (k !== undefined) deletes.push({ id: e.id, version: e.version }) }
      else upserts.push(e)
    }
    // image data the server does not have yet, for the image elements in this save
    const allFiles = eng.files()
    const files: Record<string, unknown> = {}
    for (const u of upserts) { const fid = u.fileId as string | undefined; if (fid && !this.sentFiles.has(fid) && allFiles[fid]) files[fid] = allFiles[fid] }
    const header = this.headerNext
    this.headerNext = null
    if (!upserts.length && !deletes.length && !header) { this.pending = 0; this.onState(); return }
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
      for (const p of (ans.patches ?? []).sort((a, b) => a.rev - b.rev)) this.receive(p)
    } catch (err) {
      this.sending.clear()
      if (header) this.headerNext = { ...header, ...(this.headerNext ?? {}) }
      this.onError((err as Error).message || 'save failed')
      // retried with the next change, or in 2 s
      setTimeout(() => this.changed(), 2000)
    } finally {
      this.inFlight = false
      if (this.again) { this.again = false; void this.save() }
      else if (!this.timer) { this.pending = 0; this.onState() }
    }
  }

  private catching = false
  private async catchUp(): Promise<void> {
    if (this.catching) return
    this.catching = true
    try {
      const ans = await this.io.since(this.rev)
      for (const p of ans.patches.sort((a, b) => a.rev - b.rev)) this.receive(p)
    } catch { /* the next rev or save tries again */ } finally { this.catching = false }
  }
}
