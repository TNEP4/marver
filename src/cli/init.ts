import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME } from './name.ts'
import { detectHost } from '../server/detect.ts'
import { DEFAULTS } from '../server/config.ts'

interface InitOpts { mode: 'studio' | 'embedded'; demo: boolean }

const pkgDir = () => join(dirname(fileURLToPath(import.meta.url)), '..')

/** Idempotent scaffolder: never overwrites existing files; every host-repo touch prints a diff. */
export function init(root: string, opts: InitOpts) {
  const host = detectHost(root)
  const design = join(root, 'design')
  const templates = join(pkgDir(), 'templates')
  const created: string[] = []

  const write = (rel: string, content: string) => {
    const file = join(design, rel)
    if (existsSync(file)) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    created.push(`design/${rel}`)
  }

  // config (commented defaults + native-TS sharp edges). Theme is deliberately absent:
  // design/theme.css (the wrapper) is the source of truth and always wins over config.
  write('config.ts', configTemplate(opts.mode))

  // theme wrapper (spec §5.4) - the host CSS build stays byte-identical
  if (host.themeCss) {
    const relCss = relative(design, join(root, host.themeCss)).split('\\').join('/')
    write('theme.css', themeWrapper(relCss, host.tailwind === 4))
  } else {
    console.warn(`[${NAME}] no theme CSS detected - set \`theme\` in design/config.ts when you have one.`)
  }

  // providers (mock contexts by detection)
  write('providers.tsx', providersTemplate(host.router, host.toaster, host.routerPkg))

  // agent contract
  const agents = readFileSync(join(templates, `AGENTS-${opts.mode}.md`), 'utf8')
    .replaceAll('{{UI_ALIAS}}', host.shadcn?.uiAlias ?? '@/components/ui')
  write('AGENTS.md', agents)

  write('tsconfig.json', readFileSync(join(templates, 'design-tsconfig.json'), 'utf8'))
  write('.gitignore', '.local/\n.dist/\n')
  write('scenes/_layout.tsx', readFileSync(join(templates, 'root-layout.tsx'), 'utf8'))
  if (!existsSync(join(design, 'boards'))) { mkdirSync(join(design, 'boards'), { recursive: true }); writeFileSync(join(design, 'boards', '.gitkeep'), ''); created.push('design/boards/') }

  if (opts.demo && !existsSync(join(design, 'scenes', 'demo'))) {
    cpSync(join(templates, 'demo'), join(design, 'scenes', 'demo'), { recursive: true })
    created.push('design/scenes/demo/ (3 frames)')
  }

  // The one conditional host patch: tsconfig exclude (printed diff, reversible).
  if (host.tsconfigSweepsDesign) patchTsconfigExclude(root)

  console.log(`\n${NAME} initialized (${opts.mode} mode). Created:`)
  for (const f of created) console.log(`  + ${f}`)
  if (host.router === 'next') console.log(`\n  note: Next.js support is partial until M3 - HTML frames and next-free components work today.`)
  console.log(`\n  commit design/ - only .local/ is ignored`)
  console.log(`  uninstall = delete design/, remove the ${NAME} dependency${host.tsconfigSweepsDesign ? ', revert the "design" line in tsconfig exclude' : ''}`)
  console.log(`\n  next: npx ${NAME} dev   (canvas on http://localhost:${DEFAULTS.port} by default)\n`)
  console.log(`  then, to your agent: "Read design/AGENTS.md. Build an onboarding scene - welcome, form, done - mobile-first, using our components."\n`)
}

function patchTsconfigExclude(root: string) {
  const file = join(root, 'tsconfig.json')
  if (!existsSync(file)) return
  const raw = readFileSync(file, 'utf8')
  try {
    // Surgical string edit to preserve host formatting/comments as much as possible.
    let next: string
    if (/"exclude"\s*:/.test(raw)) {
      next = raw.replace(/("exclude"\s*:\s*\[)/, '$1"design", ')
    } else {
      const at = firstJsonBrace(raw)   // never a brace inside a leading comment
      if (at < 0) throw new Error('no object brace found')
      next = raw.slice(0, at + 1) + '\n  "exclude": ["design"],' + raw.slice(at + 1)
    }
    if (next === raw) throw new Error('no anchor matched')
    writeFileSync(file, next)
    console.log(`\n  patched tsconfig.json (the only host file touched):`)
    console.log(`    + "design" added to "exclude"  (revert this line to fully uninstall)`)
  } catch {
    console.warn(`  could not patch tsconfig.json - add "design" to its "exclude" yourself.`)
  }
}

/** Index of the first `{` outside //, /* *\/ comments and strings (tsconfig is JSONC). */
function firstJsonBrace(src: string): number {
  let inLine = false, inBlock = false, inStr = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (inLine) { if (c === '\n') inLine = false; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++ }; continue }
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue }
    if (c === '/' && n === '/') { inLine = true; i++; continue }
    if (c === '/' && n === '*') { inBlock = true; i++; continue }
    if (c === '"') { inStr = true; continue }
    if (c === '{') return i
  }
  return -1
}

const configTemplate = (mode: string) => `// ${NAME} config - OPTIONAL. Delete this file and everything still works on defaults.
// Theme lives in design/theme.css (it imports your app's real stylesheet) - not here.
// Sharp edges (native Node TS import): erasable syntax only (no enums/namespaces),
// relative imports need extensions, tsconfig paths are ignored here.
export default {
  mode: ${JSON.stringify(mode)},
  // Device widths for frames and the Devices view. Rename, retune, or uncomment tv.
  viewports: {
    mobile: { width: 390, height: 844 },
    tablet: { width: 768, height: 1024 },
    laptop: { width: 1280, height: 800 },
    monitor: { width: 1920, height: 1080 },
    // tv: { width: 3840, height: 2160 },
  },
  themes: ["light", "dark"],
  port: ${DEFAULTS.port},
  // Canvas zoom feel: 1 = default, 1.2 = 20% faster, 0.8 = 20% slower.
  // zoomSpeed: 1,
  // Publishing (\`${NAME} build\` + \`${NAME} serve\`): gate identity + branding footer.
  // name/logo default to the host package.json name and design/logo.svg (then public/).
  // share: { name: "My App", logo: "design/logo.svg", branding: true },
}
`

const themeWrapper = (relCss: string, v4: boolean) => `/* ${NAME} theme wrapper - imports the app's real theme; the app's own build never sees design/. */
@import "${relCss}";
${v4 ? `@source "./";\n` : ''}`

function providersTemplate(router: string | null, toaster: string | null, routerPkg = 'react-router-dom'): string {
  const imports: string[] = [`import type { ReactNode } from 'react'`]
  let open = '', close = ''
  if (router === 'react-router') {
    imports.push(`import { MemoryRouter } from '${routerPkg}'`)
    open += '<MemoryRouter>'; close = '</MemoryRouter>' + close
  }
  let toasterEl = ''
  if (toaster === 'sonner') { imports.push(`import { Toaster } from 'sonner'`); toasterEl = '<Toaster />' }
  if (toaster === 'react-hot-toast') { imports.push(`import { Toaster } from 'react-hot-toast'`); toasterEl = '<Toaster />' }
  return `// Mock contexts wrapped around every frame. Scaffolded by ${NAME} init from what it detected - yours to edit.
${imports.join('\n')}

export default function Providers({ children }: { children: ReactNode }) {
  return (
    ${open || '<>'}
      {children}
      ${toasterEl}
    ${close || '</>'}
  )
}
`
}
