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

/** The one DEFAULT sizing rule for slide frames, shared by canvas and shot:
 *  `slide: true` sets the intrinsic 1280×720 stage, over any authored viewport.
 *  Board nodes stay resizable (the Slide root scales into whatever box it is
 *  given); this governs defaults, shots, and stage coordinates. */
export function slideSize(frame: { slide?: boolean }): { width: number; height: number } | null {
  return frame.slide ? SLIDE_INTRINSIC : null
}
