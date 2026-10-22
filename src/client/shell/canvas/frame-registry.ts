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
const byKey = new Map<string, HTMLIFrameElement>()

export const registerFrame = (win: WindowProxy, reg: FrameReg): void => { byWindow.set(win, reg); byKey.set(reg.key, reg.iframe) }
export const unregisterFrame = (win: WindowProxy): void => {
  const reg = byWindow.get(win)
  byWindow.delete(win)
  if (reg && byKey.get(reg.key) === reg.iframe) byKey.delete(reg.key)
}
/** The iframe a node shows now - the recorder reads its live document's id off it (spec 28 A1.7). */
export const iframeOf = (key: string): HTMLIFrameElement | undefined => byKey.get(key)
export const frameByWindow = (win: unknown): FrameReg | undefined =>
  win ? byWindow.get(win as WindowProxy) : undefined

/** The id of the document an iframe shows now, as its frame bridge set it (`__mvBoot`, spec 28 A1.7) - absent while a
 *  new document has not run its bridge yet, or when the frame was navigated off this origin (the read throws). */
export function bootOf(iframe: HTMLIFrameElement | undefined): string | undefined {
  try {
    const b = (iframe?.contentWindow as { __mvBoot?: unknown } | null | undefined)?.__mvBoot
    return typeof b === 'string' ? b : undefined
  } catch { return undefined }
}

/** A frame's message comes from the document its iframe shows now: the URL revision the shell gave that document
 *  (`gen`, against the iframe's src) and the document's own id (`boot`, against the live one). A WindowProxy survives
 *  navigation, and a same-URL reload keeps `gen`, so only both tell the document there now from one since replaced
 *  whose message was still on its way. Asked before a message changes anything. */
export function fromLiveDocument(iframe: HTMLIFrameElement, data: { gen?: unknown; boot?: unknown }): boolean {
  const gen = iframe.src.match(/[?&]r=(\d+)/)?.[1] ?? ''
  if (String(data.gen ?? '') !== gen) return false
  return typeof data.boot === 'string' && data.boot !== '' && data.boot === bootOf(iframe)
}
