/**
 * The glob registry - a JSX-free module so plugin-react never touches it.
 * Every design update reaches it (Fast Refresh is off under design/), and it is the one HMR
 * boundary of a frame document: it accepts the update and does nothing with it. The dev server
 * names the frames an edit touched and the shell reloads exactly those, queued and lease-aware
 * (spec 26) - a document never reloads itself, and its map refreshes so a new frame can open.
 */
export const frames = import.meta.glob(['/design/scenes/**/*.{tsx,jsx}', '/design/components/**/*.{tsx,jsx}'])
export const layouts = import.meta.glob(['/design/scenes/**/_layout.{tsx,jsx}', '/design/components/**/_layout.{tsx,jsx}'])
export const providers = import.meta.glob('/design/providers.{tsx,jsx}')

/** id -> glob key. scenes/ ids lost their prefix; components/ ids kept it. */
export function frameFile(frameId: string): string | null {
  for (const ext of ['tsx', 'jsx']) {
    for (const prefix of ['/design/scenes/', '/design/']) {
      const key = `${prefix}${frameId}.${ext}`
      if (key in frames) return key
    }
  }
  return null
}

/** Layout chain for a frame file: every _layout on the path from the glob base down, outermost = shallowest. */
export function layoutChain(fileKey: string): string[] {
  const dir = fileKey.slice(0, fileKey.lastIndexOf('/'))
  const chain: string[] = []
  const base = fileKey.startsWith('/design/scenes/') ? '/design/scenes' : '/design/components'
  let cur = dir
  while (cur.length >= base.length) {
    for (const ext of ['tsx', 'jsx']) {
      const key = `${cur}/_layout.${ext}`
      if (key in layouts) { chain.unshift(key); break }
    }
    if (cur === base) break
    cur = cur.slice(0, cur.lastIndexOf('/'))
  }
  return chain
}

if (import.meta.hot) import.meta.hot.accept(() => { /* the shell reloads what changed */ })
