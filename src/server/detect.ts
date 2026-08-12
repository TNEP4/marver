import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface HostInfo {
  tailwind: 3 | 4 | null
  router: 'react-router' | 'next' | null
  routerPkg: string
  toaster: 'sonner' | 'react-hot-toast' | null
  shadcn: { themeCss: string; uiAlias: string } | null
  /** repo-relative path of the theme CSS entry, if we could find one */
  themeCss: string | null
  tsconfigSweepsDesign: boolean
}

export function readJson(file: string): any | null {
  try { return JSON.parse(stripJsonComments(readFileSync(file, 'utf8'))) } catch { return null }
}
// tsconfig/components.json allow comments and trailing commas; be forgiving.
// STRING-AWARE by necessity: glob patterns like ".next/types/**/*.ts" (create-next-app's
// default include) contain `/*` - a regex stripper eats them and the whole parse fails.
function stripJsonComments(s: string): string {
  let out = '', inStr = false, inLine = false, inBlock = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1]
    if (inLine) { if (c === '\n') { inLine = false; out += c }; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++ }; continue }
    if (inStr) { out += c; if (c === '\\') { out += n ?? ''; i++ } else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && n === '/') { inLine = true; i++; continue }
    if (c === '/' && n === '*') { inBlock = true; i++; continue }
    out += c
  }
  // trailing commas - string-aware for the same reason a regex can't strip comments
  let res = '', inS = false
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (inS) { res += c; if (c === '\\') { res += out[i + 1] ?? ''; i++ } else if (c === '"') inS = false; continue }
    if (c === '"') { inS = true; res += c; continue }
    if (c === ',') {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j])) j++
      if (out[j] === '}' || out[j] === ']') continue
    }
    res += c
  }
  return res
}

export function detectHost(root: string): HostInfo {
  const pkg = readJson(join(root, 'package.json')) ?? {}
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }

  const twRange: string | undefined = deps['tailwindcss']
  const tailwind = !twRange ? null : /(^|[^\d])4\./.test(twRange) || twRange.startsWith('^4') || twRange.startsWith('~4') ? 4 : 3

  const router = deps['next'] ? 'next' as const : deps['react-router'] || deps['react-router-dom'] ? 'react-router' as const : null
  const routerPkg = deps['react-router-dom'] ? 'react-router-dom' : 'react-router'
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
  // "sweeping" includes: '.', '**/*', and glob-prefixed patterns like '**/*.ts' /
  // '**/*.tsx' (create-next-app's default - missing these made `next build` typecheck
  // design/ and fail on marver's .ts-extension imports)
  const sweeps = ts != null && !exclude.some((e: string) => e === 'design' || e.startsWith('design/'))
    && (!include || include.some((i: string) => i === '.' || i.startsWith('**') || i.startsWith('design')))

  return { tailwind, router, routerPkg, toaster, shadcn, themeCss, tsconfigSweepsDesign: !!sweeps }
}

function firstExisting(root: string, candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(join(root, c))) return c
  return null
}
