/** Client-safe constants. The single source - src/cli/name.ts re-exports for node-side code.
 *  Lives under src/client because that is the only source directory shipped in the package. */
export const NAME = 'marver'
export const PKG = '@marver-design/marver'   // registry identity; bin stays `marver`
export const ROUTE = '/__mv'

/** Content-frame natural widths: Doc layout -> own-size width.
 *  Shared by the Doc primitive (measurement messages) and the server-side
 *  manifest scan (defaultSize for content frames) - one source, no drift. */
export const CONTENT_WIDTH: Record<string, number> = { document: 760, wide: 1280 }

/** The slide stage (v1.5): a runtime-reserved intrinsic, deliberately NOT a
 *  config viewport - no migration for existing projects, no deck device in
 *  sweeps. Dependency-neutral so server (shot) and shell (store) share it. */
export const SLIDE_INTRINSIC = { width: 1280, height: 720 }

/** The one sizing precedence for slide frames, shared by canvas and shot:
 *  a RESOLVED authored viewport wins; an unknown viewport name on a slide is
 *  meaningless and the intrinsic wins; content sizing loses to the intrinsic. */
export function slideSize(
  frame: { slide?: boolean; viewport?: string },
  viewports: Record<string, { width: number; height: number }>,
): { width: number; height: number } | null {
  if (!frame.slide) return null
  if (frame.viewport && viewports[frame.viewport]) return null   // authored + resolved wins
  return SLIDE_INTRINSIC
}
