/**
 * The document proof, per tab (spec 28 A2.3, A2.14 #11). Owner: the trust stream.
 *
 * SKELETON (ship stream): the interface. One `onBeforeSendHeaders` per local session (Electron keeps one
 * listener per event), filtered to `mainFrame` and `script`: it cancels any `Service-Worker: script` request,
 * adds `x-mv-nonce` (24 random bytes) and `x-mv-ws` to each main-frame request for the tab's origin and the
 * shell's own document, and stamps the adapter's generation. `onHeadersReceived` checks a final response's
 * `x-mv-instance` and `x-mv-proof` with the package's own formula - `docProof` from `src/server/proof.ts`,
 * the one import main takes from the package's server code (with the `SlotFile` type).
 */
import type { Session } from 'electron'
import { docProof, NONCE } from '../../../src/server/proof.ts'
import type { RegistryEntry } from './registry.ts'

export { docProof, NONCE }

/** What the dispatcher needs of the tab a webContents belongs to. */
export interface ProofTarget {
  entry: RegistryEntry
  /** the adapter's current generation, stamped on each main-frame request */
  gen(): number | null
}

export interface Dispatcher {
  /** a webContents of this session, mapped to its tab's target */
  attach(webContentsId: number, target: () => ProofTarget | undefined): void
  detach(webContentsId: number): void
}

/** Installs the one dispatcher of a local session (`persist:local:<ws>`). */
export function installDispatcher(_ses: Session): Dispatcher {
  throw new Error('proof.ts: the dispatcher is the trust stream\'s (spec 28 A2.3, A2.14 #11)')
}

/** Trusted at its commit, and its instance is still the tab's current, live registry instance (A2.14 #8). */
export function isTrusted(_webContentsId: number): boolean {
  return false
}
