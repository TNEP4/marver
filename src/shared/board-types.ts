/**
 * Board types (spec 20) - what a board is FOR in the workspace, one vocabulary every canvas
 * shares so any sidebar reads at a glance. A board states its own `"type"`, or wears the type of
 * the nearest typed folder above it (its folder, then that folder's parent), else it is plain.
 * Moving a board changes an inherited type, never one the board states itself.
 *
 * Pure and shared: the dev API, the manifest, the build, the shell and the CLI all read types
 * through here, so a type means one thing everywhere.
 */

export const BOARD_TYPES = ['start', 'feature', 'surface', 'project', 'feedback', 'context', 'deck', 'archive'] as const
export type KnownType = (typeof BOARD_TYPES)[number]
export type BoardType = KnownType | 'plain'

/** What each type is for - the sidebar's tooltip, the CLI's help, the docs. */
export const TYPE_ROLES: Record<BoardType, string> = {
  start: 'the way in: the index, the shipped record, the timeline',
  feature: 'one capability: its spec, lo-fi and hi-fi',
  surface: 'the whole product to walk, from frames on feature boards',
  project: 'a deliverable or a question',
  feedback: 'one frame per theme',
  context: 'what came in from outside: meetings, threads, competitors',
  deck: 'slides',
  archive: 'snapshots and retired work',
  plain: 'a board',
}

/** The grammar a stored type keeps to. Any on-grammar word survives a write - a newer Marver's
 *  type is never dropped by an older shell - while only the known ones are drawn. */
export const TYPE_GRAMMAR = /^[a-z][a-z-]{0,31}$/
/** A type off a file: the word when it is on-grammar, else absent. */
export const readType = (v: unknown): string | undefined => (typeof v === 'string' && TYPE_GRAMMAR.test(v) ? v : undefined)
/** A type this Marver draws. */
export const knownType = (v: unknown): KnownType | undefined =>
  (BOARD_TYPES as readonly string[]).includes(v as string) ? (v as KnownType) : undefined

/** A board's type: its own when it states one (an unknown word reads as plain - the board spoke
 *  for itself), else its folder's, else that folder's parent's, else plain. */
export function resolveType(own: unknown, folder?: unknown, parent?: unknown): BoardType {
  if (readType(own)) return knownType(own) ?? 'plain'
  return knownType(folder) ?? knownType(parent) ?? 'plain'
}

/** The publish type a board's type proposes when its publish row names none - how a board
 *  PRESENTS when published, a separate question from what it is for. */
export const PROPOSED_PUBLISH: Partial<Record<BoardType, 'slides' | 'refs' | 'doc' | 'mix'>> = {
  deck: 'slides',
  context: 'refs',
  project: 'doc',
  feature: 'mix',
  surface: 'mix',
}

/** The types that carry a status (spec 20, open question 2: features and projects - the others
 *  have no lifecycle of their own). */
export const HAS_STATUS: readonly BoardType[] = ['feature', 'project']

/** The decisions a board may state by hand. `done` is never one: Done comes only from the shipped
 *  record. `todo`, `backlog` and `in-progress` count only where there is no `context/`. */
export const DECISIONS = ['archived', 'paused', 'blocked'] as const
export const BY_HAND = ['in-progress', 'todo', 'backlog'] as const
export const STATUS_WORDS = [...DECISIONS, ...BY_HAND, 'done'] as const
export type StatusWord = (typeof STATUS_WORDS)[number]
export const readStatusWord = (v: unknown): StatusWord | undefined =>
  (STATUS_WORDS as readonly string[]).includes(v as string) ? (v as StatusWord) : undefined

/** A capability slug - the same grammar as a board name, so a feature board and its contract
 *  share it. */
export const readCapability = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v) ? v : undefined
/** A blocked board's reason: one sentence, trimmed and capped. */
export const REASON_MAX = 300
export const readReason = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = v.trim().replace(/\s+/g, ' ').slice(0, REASON_MAX)
  return s || undefined
}

/** The sidebar every canvas shares (spec 19, The canvas): folder modules, each typed, so a board
 *  made inside one wears its type. `marver init --kind` creates a kind's set on a fresh canvas;
 *  `marver folders add <module>` adds one later. Names are slugs; only Start here needs a title. */
export const FOLDER_MODULES: Record<string, { name: string; title?: string; type: KnownType }> = {
  start: { name: 'start-here', title: 'Start here', type: 'start' },
  features: { name: 'features', type: 'feature' },
  surfaces: { name: 'surfaces', type: 'surface' },
  projects: { name: 'projects', type: 'project' },
  feedback: { name: 'feedback', type: 'feedback' },
  context: { name: 'context', type: 'context' },
  decks: { name: 'decks', type: 'deck' },
  archive: { name: 'archive', type: 'archive' },
}
/** A kind of work's folders, in sidebar order: the core (Start here, Feedback, Context, Archive)
 *  around the kind's own modules. Decks are an add-on for either. */
export const KIND_FOLDERS = {
  product: ['start', 'features', 'surfaces', 'feedback', 'context', 'archive'],
  knowledge: ['start', 'projects', 'feedback', 'context', 'archive'],
} as const
export type Kind = keyof typeof KIND_FOLDERS
