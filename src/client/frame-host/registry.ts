/**
 * The glob registry - a JSX-free module so plugin-react never touches it.
 * It is the HMR boundary for glob-map invalidation (frame files added/removed):
 * accepting here reloads THIS iframe only, instead of Vite broadcasting a full
 * page reload to every client including the shell.
 * Component edits never reach this module - they stop at Fast Refresh in the frame itself.
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

if (import.meta.hot) import.meta.hot.accept(() => location.reload())
