/** R16's negative fixture: an app menu item whose click reaches nothing that records. The walk must report it. */
declare function doSomething(): void
export const template = [{ label: 'Unrecorded Item', click: () => doSomething() }]
