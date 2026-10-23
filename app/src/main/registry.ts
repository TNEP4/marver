/**
 * Running canvases (spec 28 A2.3, A2.14 #10, #12). Owner: the trust stream.
 *
 * SKELETON (ship stream): the registry entry and the reader's interface. To build: watch
 * `<MARVER_HOME>/running/` (100 ms debounce) and reconcile every 5 s (pid liveness); `lstat` each file (a
 * regular file of this user, mode & 0o077 === 0, at most 16 KB), the record's shape, `slot-<n>.json` holding
 * slot n on `slotBase() + n` (MARVER_SLOT_BASE honoured), `url` equal to `http://localhost:<port>/`, a
 * loopback origin on that port, a 32-byte key, a 16-hex `ws`; a pid answering EPERM is gone. Every read async.
 * Never `readRunning()` from the package (it drops `key` and `instance`).
 */
import type { SlotFile } from '../../../src/server/slots.ts'

/** A slot file read and checked: the package's record with its key decoded. The key never leaves main. */
export interface RegistryEntry extends Omit<SlotFile, 'v' | 'key'> {
  /** `running/slot-<n>.json` or `running/port-<p>.json` */
  file: string
  /** the document proof's key, 32 bytes */
  key: Buffer
}

/** What the reader tells the tabs. `starting` binds a tab by `(ws, port)`; `ready` by `(ws, origin)` (A2.14 #10). */
export type RegistryEvent =
  | { kind: 'entry'; entry: RegistryEntry }
  | { kind: 'gone'; file: string; instance: string; why: 'pid' | 'removed' | 'closing' }

export interface Registry {
  /** makes `running/` (700) when missing, then watches and reconciles */
  start(): Promise<void>
  stop(): void
  entries(): RegistryEntry[]
  byPort(port: number): RegistryEntry | undefined
  /** one fresh read (the proof's "instance differs" path, A2.14 #11) */
  reread(): Promise<void>
  on(fn: (e: RegistryEvent) => void): () => void
}

export function createRegistry(): Registry {
  const listeners = new Set<(e: RegistryEvent) => void>()
  return {
    async start() { /* trust stream */ },
    stop() { listeners.clear() },
    entries: () => [],
    byPort: () => undefined,
    async reread() { /* trust stream */ },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
}
