// Negative fixture (R16): a context-menu item (an object literal's onClick) with no command must fail the walk.
declare function remove(): void
export const items = () => [{ label: 'Delete', onClick: () => remove() }]
