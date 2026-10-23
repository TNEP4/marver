/**
 * Sessions, permissions, navigation (spec 28 A2.5, A2.14 #11, #14). Owner: the trust stream.
 *
 * SKELETON (ship stream): the interface, with a deny-everything navigation hook so the blank window is safe
 * as it stands. To build: `persist:app` and its `marver-app://` handler (only the files `pages/manifest.json`
 * lists, with A2.5's CSP); `persist:local:<record.ws>` per repo with `hardenSession`, the proof dispatcher and
 * `clearStorageData({ storages: ['serviceworkers'] })` awaited before its first navigation; the local
 * navigation policy (the tab's origin and the shell's own document; a same-origin `window.open` of it focuses
 * that canvas's tab; anything else to `shell.openExternal`, https/http/mailto only); pinned app pages.
 */
import { app, session, type Session } from 'electron'

export const APP_PARTITION = 'persist:app'
export const localPartition = (ws: string): string => `persist:local:${ws}`

/** `persist:app`, its `marver-app://` protocol and its deny-by-default handlers. Called once, at ready. */
export function setupAppSession(): Session {
  return session.fromPartition(APP_PARTITION)
}

/** A local canvas's partition, prepared once before its first navigation (A2.3). */
export async function localSession(ws: string): Promise<Session> {
  return session.fromPartition(localPartition(ws))
}

/**
 * The one `web-contents-created` hook, installed at ready before any view exists. The skeleton denies every
 * window and every navigation; the trust stream replaces it with A2.5's policy.
 */
export function installNavigationPolicy(): void {
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e) => e.preventDefault())
    wc.on('will-redirect', (e) => e.preventDefault())
  })
}
