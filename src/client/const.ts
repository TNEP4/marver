/** Client-safe constants. The single source - src/cli/name.ts re-exports for node-side code.
 *  Lives under src/client because that is the only source directory shipped in the package. */
export const NAME = 'marver'
export const PKG = '@marver/design'   // registry identity; bin stays `marver`
export const ROUTE = '/__mv'
