/** Pure display-label helpers. Standalone (no virtual-module imports) so they are unit-testable
 *  and cheap to import anywhere. Re-exported from store.ts for existing call sites. */

export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** D5: derive a display label from a kebab slug - drop the dashes, Title Case each word.
 *  For board/folder/scene NAMES only (device/theme names are single words, cap is right
 *  there). An explicit `title` (boards, folders, scenes - v1.6.1) is shown verbatim and never
 *  passes through here; `labelOf` in shared/board-tree.ts picks. */
export { humanize } from '../../shared/board-tree.ts'
