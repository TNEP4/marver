// SPEC-M7 — the persisted-artifact store. Content-addressed IMMUTABLE object files + an atomic manifest.
// Two identities (codex): buildKey = hash of the recipe (deps/theme/viewport/route/serializer/browser);
// objectHash = sha256 of the final portable HTML bytes. The manifest maps buildKey -> object. Same buildKey
// producing different bytes means the frame is dynamic (the caller marks it so). Objects are never
// overwritten - a temp file is atomically renamed, and the manifest is written LAST.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export const SCHEMA_VERSION = 1

export type ArtifactStatus = 'ready' | 'incompatible' | 'dynamic'
export interface Dep { path: string; hash: string }
export interface Variant {
  buildKey: string          // recipe identity
  objectHash: string        // sha256 of the HTML bytes ('' when status != ready)
  href: string              // served URL for the object ('' when not ready)
  status: ArtifactStatus
  bytes: number
  deps: Dep[]               // resolved dependency closure {path,hash} - restart-safe identity
  note?: string             // degradation reason for incompatible/dynamic
}
export interface FrameArtifacts { variants: Record<string, Variant> }   // variantKey e.g. "light@1280"
export interface Manifest { schemaVersion: number; captureEngine: string; frames: Record<string, FrameArtifacts> }

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
export const variantKey = (theme: string, viewport: string): string => `${theme}@${viewport}`

/** Recipe identity for a capture. Stable across processes so a disk artifact can be validated on restart. */
export function buildKey(i: {
  depRevision: string; globalEnvRevision: string; theme: string; viewport: string
  routeKey: string; serializerVersion: string; browserEngineVersion: string
}): string {
  return sha256(JSON.stringify([
    SCHEMA_VERSION, i.depRevision, i.globalEnvRevision, i.theme, i.viewport, i.routeKey,
    i.serializerVersion, i.browserEngineVersion,
  ]))
}
export const objectHashOf = (html: string): string => sha256(html)

export class ArtifactStore {
  private manifest: Manifest = { schemaVersion: SCHEMA_VERSION, captureEngine: 'unset', frames: {} }
  private loaded = false
  constructor(private root: string, private urlBase: string) {}   // root e.g. design/.local/artifacts/v1 ; urlBase e.g. /__mv/artifacts/v1

  private objectsDir(): string { return join(this.root, 'objects') }
  private manifestPath(): string { return join(this.root, 'manifest.json') }
  objectHref(objectHash: string): string { return `${this.urlBase}/objects/${objectHash}.html` }
  objectFilePath(objectHash: string): string { return join(this.objectsDir(), `${objectHash}.html`) }

  async load(engine: string): Promise<Manifest> {
    await fs.mkdir(this.objectsDir(), { recursive: true })
    try {
      const raw = JSON.parse(await fs.readFile(this.manifestPath(), 'utf8')) as Manifest
      // a schema or capture-engine change invalidates the whole cache (serializer/browser version bumps)
      this.manifest = (raw.schemaVersion === SCHEMA_VERSION && raw.captureEngine === engine)
        ? raw : { schemaVersion: SCHEMA_VERSION, captureEngine: engine, frames: {} }
    } catch { this.manifest = { schemaVersion: SCHEMA_VERSION, captureEngine: engine, frames: {} } }
    this.manifest.captureEngine = engine
    this.loaded = true
    return this.manifest
  }

  getManifest(): Manifest { return this.manifest }
  getVariant(frameId: string, vKey: string): Variant | undefined { return this.manifest.frames[frameId]?.variants[vKey] }

  /** Is there a READY object on disk for this buildKey (validated against the recorded manifest)? */
  async lookup(frameId: string, vKey: string, key: string): Promise<Variant | null> {
    const v = this.getVariant(frameId, vKey)
    if (!v || v.buildKey !== key || v.status !== 'ready') return null
    // the immutable object must still exist on disk
    try { await fs.access(this.objectFilePath(v.objectHash)); return v } catch { return null }
  }

  /** Write a READY artifact: temp object -> atomic rename -> manifest updated last. Immutable object. */
  async writeReady(frameId: string, vKey: string, key: string, html: string, deps: Dep[]): Promise<Variant> {
    const objectHash = objectHashOf(html)
    const dest = this.objectFilePath(objectHash)
    try { await fs.access(dest) } catch {                                  // don't rewrite an existing immutable object
      const tmp = `${dest}.${process.pid}.${objectHash.slice(0, 8)}.tmp`
      await fs.writeFile(tmp, html, 'utf8')
      await fs.rename(tmp, dest)                                            // atomic on same fs
    }
    const variant: Variant = { buildKey: key, objectHash, href: this.objectHref(objectHash), status: 'ready', bytes: Buffer.byteLength(html), deps }
    await this.commit(frameId, vKey, variant)
    return variant
  }

  /** Record a non-persistable outcome (incompatible / dynamic) so the compiler doesn't retry forever. */
  async writeStatus(frameId: string, vKey: string, key: string, status: 'incompatible' | 'dynamic', note: string, deps: Dep[]): Promise<Variant> {
    const variant: Variant = { buildKey: key, objectHash: '', href: '', status, bytes: 0, deps, note }
    await this.commit(frameId, vKey, variant)
    return variant
  }

  /** Drop a frame's artifacts from the manifest (file deleted/renamed). Objects are GC'd separately. */
  async removeFrame(frameId: string): Promise<void> { delete this.manifest.frames[frameId]; await this.persist() }
  /** Mark every variant of a frame stale so it recompiles (revision changed). */
  invalidateFrame(frameId: string): void { delete this.manifest.frames[frameId] }

  private async commit(frameId: string, vKey: string, variant: Variant): Promise<void> {
    ;(this.manifest.frames[frameId] ??= { variants: {} }).variants[vKey] = variant
    await this.persist()
  }
  private async persist(): Promise<void> {
    if (!this.loaded) return
    const tmp = `${this.manifestPath()}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.manifest), 'utf8')
    await fs.rename(tmp, this.manifestPath())                              // atomic manifest swap, written last
  }
}
