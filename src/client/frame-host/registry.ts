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

if (import.meta.hot) import.meta.hot.accept(() => location.reload())
