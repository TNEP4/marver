/**
 * B0.3: O(1) source-window -> node lookup for the frame->shell message protocol.
 *
 * Every postMessage from a frame previously triggered a full `document.querySelectorAll
 * ('iframe')` scan plus a `closest('[data-node]')` DOM walk to find the sender's node.
 * A frame's WindowProxy is a stable object for the life of its iframe element (it survives
 * same-element navigations - the iframe law keeps one element per node key), so one
 * registration holds for the frame's whole life. The registry doubles as the security
 * gate: an event whose source is not registered is not a known frame and is dropped.
 */
export interface FrameReg { key: string; iframe: HTMLIFrameElement }

const byWindow = new WeakMap<WindowProxy, FrameReg>()

export const registerFrame = (win: WindowProxy, reg: FrameReg): void => { byWindow.set(win, reg) }
export const unregisterFrame = (win: WindowProxy): void => { byWindow.delete(win) }
export const frameByWindow = (win: unknown): FrameReg | undefined =>
  win ? byWindow.get(win as WindowProxy) : undefined
