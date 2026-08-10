import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface HostInfo {
  tailwind: 3 | 4 | null
  router: 'react-router' | 'next' | null
  toaster: 'sonner' | 'react-hot-toast' | null
  shadcn: { themeCss: string; uiAlias: string } | null
  /** repo-relative path of the theme CSS entry, if we could find one */
  themeCss: string | null
  tsconfigSweepsDesign: boolean
}

function readJson(file: string): any | null {
  try { return JSON.parse(stripJsonComments(readFileSync(file, 'utf8'))) } catch { return null }
}
// tsconfig/components.json allow comments and trailing commas; be forgiving.
function stripJsonComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/,\s*([}\]])/g, '$1')
}

export function detectHost(root: string): HostInfo {
  const pkg = readJson(join(root, 'package.json')) ?? {}
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }

  const twRange: string | undefined = deps['tailwindcss']
  const tailwind = !twRange ? null : /(^|[^\d])4\./.test(twRange) || twRange.startsWith('^4') || twRange.startsWith('~4') ? 4 : 3

  const router = deps['next'] ? 'next' as const : deps['react-router'] || deps['react-router-dom'] ? 'react-router' as const : null
  const toaster = deps['sonner'] ? 'sonner' as const : deps['react-hot-toast'] ? 'react-hot-toast' as const : null

  let shadcn: HostInfo['shadcn'] = null
  const comp = readJson(join(root, 'components.json'))
  if (comp?.tailwind?.css) shadcn = { themeCss: comp.tailwind.css, uiAlias: comp.aliases?.ui ?? '@/components/ui' }

  const themeCss = shadcn?.themeCss && existsSync(join(root, shadcn.themeCss))
    ? shadcn.themeCss
    : firstExisting(root, ['src/index.css', 'src/styles/theme.css', 'src/styles/globals.css', 'src/app/globals.css', 'app/globals.css', 'src/globals.css', 'src/style.css', 'styles/globals.css'])

  // Does the host tsconfig sweep design/ in? (no `include` = includes everything)
  const ts = readJson(join(root, 'tsconfig.json'))
  const include: string[] | undefined = ts?.include
  const exclude: string[] = ts?.exclude ?? []
  const sweeps = ts != null && !exclude.some((e: string) => e === 'design' || e.startsWith('design/'))
    && (!include || include.some((i: string) => i === '.' || i === '**/*' || i.startsWith('design')))

  return { tailwind, router, toaster, shadcn, themeCss, tsconfigSweepsDesign: !!sweeps }
}

function firstExisting(root: string, candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(join(root, c))) return c
  return null
}
