/**
 * A project's one identity on this Mac (spec 28 A1.6): the first 16 hex of sha256 over its REAL path,
 * so a root reached through a symlink is the same project. CONFIG.workspace, the capture upload's
 * check, the slot file, the preference file and the app's partition all read it.
 *
 * A run holds two values (A1.13 #6): the canonical identity, which picks the project's preference
 * file, and the effective workspace - this run's documents, API, captures and registry record. They
 * differ only in a `--recover` run, which serves under the workspace key an earlier address used.
 *
 * The CLI already hands `dev()` the root's real path (cli/index.ts), so for every canvas started with
 * `npx marver dev` this equals 0.26's key: unsent captures keep their key, and only the origin moves.
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'

const key = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** realpath, or the path itself when it cannot be resolved (never throws at boot). */
export const realRoot = (root: string): string => { try { return realpathSync(root) } catch { return root } }

/** The project's canonical identity. */
export const workspaceId = (root: string): string => key(realRoot(root))

/** 0.26's key, for `--recover` alone: sha256 of the root exactly as it was given (0.26 hashed the
 *  given root in plugin.ts and api.ts alike). Equals `workspaceId` for every CLI start. */
export const legacyWorkspace = (root: string): string => key(root)

/** One run's identity: the real root, the canonical id (the preference file) and the effective
 *  workspace (everything this run serves). */
export interface RunIdentity { root: string; id: string; ws: string }
export const runIdentity = (root: string, recoverWs?: string): RunIdentity => {
  const real = realRoot(root)
  const id = key(real)
  return { root: real, id, ws: recoverWs ?? id }
}
