// The one key guard (spec 27, "The keys, everywhere") - shared by canvas frames (bridge.js), the
// play stage (stage/main.tsx) and the shell's own play handler (Play.tsx).
//
// A key typed into a field is the field's: never from an input, textarea, select, contenteditable
// element, or an IME composition. The shell mirrors which keys it owns right now into every frame
// (`sh:keys { owned }`); a frame consumes an owned key itself - preventDefault() before the browser
// presses a focused button on Enter, and no handler of the frame sees it - and forwards it up as
// `sh:key { key, shift, alt, meta, ctrl, code }`. A key not owned behaves as it always did.
//
// Key descriptors: `[Ctrl+][Meta+][Alt+][Shift+]key`, a single character lowercased ('e', 's'),
// any other key by its DOM name ('Enter', 'Escape', 'ArrowLeft', 'Backspace'):
// 'Shift+Enter', 'Meta+Enter', 'Alt+ArrowLeft'. 'Shift+s' is not 's'.

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/** Is this event's target a field, or inside one (a contenteditable region counts)? */
export const inField = (t) => t instanceof Element && (t.isContentEditable || !!t.closest(FIELD))

/** Mid-composition (an IME is building a character): every key is the composition's. */
export const composing = (e) => !!e.isComposing || e.keyCode === 229

/** May a shortcut take this key at all? Not from a field, not mid-composition. */
export const keyAllowed = (e) => !composing(e) && !inField(e.target)

/** The descriptor `sh:keys` speaks. */
export function keyDescriptor(e) {
  const k = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key
  return [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift', k].filter(Boolean).join('+')
}

/** Listen for `sh:keys` from the shell and consume + forward the keys it owns. Installs a
 *  capture-phase keydown on the window - ahead of every handler the frame has - and returns
 *  { owns(e), dispose() }. `trusted(e)` checks a message really is the shell's. */
export function createKeys({ post, trusted }) {
  let owned = new Set()
  const onMessage = (e) => {
    if (!trusted(e)) return
    const m = e.data
    if (m && m.type === 'sh:keys' && Array.isArray(m.owned)) owned = new Set(m.owned.filter((k) => typeof k === 'string'))
  }
  const owns = (e) => owned.size > 0 && keyAllowed(e) && owned.has(keyDescriptor(e))
  const onKey = (e) => {
    if (!owns(e)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    post({ type: 'sh:key', key, code: e.code, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey })
  }
  window.addEventListener('message', onMessage)
  window.addEventListener('keydown', onKey, true)
  return {
    owns,
    dispose() { window.removeEventListener('message', onMessage); window.removeEventListener('keydown', onKey, true) },
  }
}
