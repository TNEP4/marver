/** Client-safe constants. The single source - src/cli/name.ts re-exports for node-side code.
 *  Lives under src/client because that is the only source directory shipped in the package. */
export const NAME = 'marver'
export const PKG = '@marver-design/marver'   // registry identity; bin stays `marver`
export const ROUTE = '/__mv'

/** Content-frame natural widths (SPEC-026): Doc layout -> own-size width.
 *  Shared by the Doc primitive (measurement messages) and the server-side
 *  manifest scan (defaultSize for content frames) - one source, no drift. */
export const CONTENT_WIDTH: Record<string, number> = { document: 760, wide: 1280 }
