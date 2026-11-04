/** R16: what is classified by its shape, with no entry - a guard, and typing that only sets state. And a page's relay. */
declare function h(tag: string, props: Record<string, unknown>): unknown
declare const api: { go(): void } | null
declare const field: { addEventListener(type: string, fn: (e: Event) => void): void }
declare function setDraft(v: string): void
export const guard = h('div', { onclick: (e: Event) => { e.stopPropagation() } })
export const guardBoth = h('div', { oncontextmenu: (e: Event) => { e.preventDefault(); e.stopPropagation() } })
export const typing = h('input', { onchange: (e: { target: { value: string } }) => setDraft(e.target.value) })
field.addEventListener('keydown', (e) => { e.preventDefault() })
export const relay = h('button', { onclick: () => api?.go() })
