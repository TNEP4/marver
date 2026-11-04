/** R16's negative fixture: an app page's button that reaches neither main's funnel nor an entry. The walk must report it. */
declare function h(tag: string, props: Record<string, unknown>, ...kids: string[]): unknown
declare function doSomething(): void
export const button = h('button', { 'aria-label': 'Unrecorded', onclick: () => doSomething() }, 'Press')
