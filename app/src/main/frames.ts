/**
 * A page's frames, read without throwing (spec 28 A2.2, A2.14 #33). Once a page's renderer is gone - a crash, a kill,
 * or the helpers of a quitting app ended with it (a SIGTERM to its process group) - Electron 45's `mainFrame` getter,
 * and every getter of a WebFrameMain it handed out before (`url`, `osProcessId`, `framesInSubtree`...), throws
 * "Render frame was disposed before WebFrameMain could be accessed". In one of main's event handlers that throw is an
 * uncaught exception, which Electron answers with its modal error box: main blocks on the screen, and a quit waits
 * until the process is killed. Whoever reads a page's frames from an event reads them through these.
 */
import type { WebContents, WebFrameMain } from 'electron'

/** `fn()`, or undefined when it throws (a frame that went). */
export function safely<T>(fn: () => T): T | undefined {
  try { return fn() } catch { return undefined }
}

/** The page's main frame while its render frame lives, else undefined. */
export function mainFrameOf(wc: WebContents): WebFrameMain | undefined {
  return safely(() => {
    if (wc.isDestroyed()) return undefined
    const f = wc.mainFrame
    // a frame whose renderer went throws at its first getter: read one here, so the caller gets a frame that answers
    return f && !f.isDestroyed() && typeof f.processId === 'number' ? f : undefined
  })
}
