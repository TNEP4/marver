import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME } from './name.ts'
import { detectHost, type HostInfo } from '../server/detect.ts'
import { DEFAULTS } from '../server/config.ts'
import { scanFrames, writeManifest } from '../server/manifest.ts'

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
    console.warn(`[${NAME}] no theme CSS detected - create design/theme.css importing your app's stylesheet when you have one (or set \`theme\` in design/config.ts).`)
  }

  // providers (mock contexts by detection)
  write('providers.tsx', providersTemplate(host.router, host.toaster, host.routerPkg))

  // agent contract - generated from what was DETECTED, never from wishful thinking:
  // an agent follows the contract it is given (friction log #1). Unlike every other
  // scaffolded file, a stale contract is actively harmful, so a marker-carrying
  // AGENTS.md regenerates when re-run detection disagrees with it ("set up the app,
  // then re-run init" has to actually work). Deleting the marker opts out for good.
  const agents = AGENTS_MARKER + '\n' + readFileSync(join(templates, `AGENTS-${opts.mode}.md`), 'utf8')
    .replaceAll('{{UI_GUIDANCE}}', uiGuidance(host))
    .replace(/\{\{NEXT_NOTES\}\}\n?/, host.router === 'next' ? NEXT_NOTES : '')
  const agentsPath = join(design, 'AGENTS.md')
  if (!existsSync(agentsPath)) write('AGENTS.md', agents)
  else {
    const current = readFileSync(agentsPath, 'utf8')
    if (current.startsWith(AGENTS_MARKER) && current !== agents) {
      writeFileSync(agentsPath, agents)
      created.push('design/AGENTS.md (regenerated - detected stack changed)')
    }
  }

  // design/tsconfig.json extends the root config only when one EXISTS (friction log #4)
  const rootTsconfig = existsSync(join(root, 'tsconfig.json'))
  write('tsconfig.json', rootTsconfig
    ? readFileSync(join(templates, 'design-tsconfig.json'), 'utf8')
    : STANDALONE_TSCONFIG)
  write('.gitignore', '.local/\n.dist/\n')
  write('scenes/_layout.tsx', readFileSync(join(templates, 'root-layout.tsx'), 'utf8'))
  if (!existsSync(join(design, 'boards'))) { mkdirSync(join(design, 'boards'), { recursive: true }); writeFileSync(join(design, 'boards', '.gitkeep'), ''); created.push('design/boards/') }

  if (opts.demo && !existsSync(join(design, 'scenes', 'demo'))) {
    cpSync(join(templates, 'demo'), join(design, 'scenes', 'demo'), { recursive: true })
    created.push('design/scenes/demo/ (3 frames)')
  }

  // The one conditional host patch: tsconfig exclude (printed diff, reversible).
  if (host.tsconfigSweepsDesign) patchTsconfigExclude(root)

  // the first manifest, so AGENTS.md's "read design/manifest.json" is true before dev runs
  writeManifest(root, scanFrames(root))

  console.log(`\n${NAME} initialized (${opts.mode} mode). Created:`)
  for (const f of created) console.log(`  + ${f}`)
  if (host.router === 'next') console.log(`\n  note: Next.js support is partial - frames render outside Next, so next/font, next/image and Server Components do not exist inside them (details in design/AGENTS.md).`)
  if (noApp(host)) {
    console.warn(`
  ┌─ NO APP DETECTED ─────────────────────────────────────────────────────┐
  │ This repo has no framework, no theme CSS, and no component library.   │
  │ ${NAME} builds frames from YOUR components - with none, frames become │
  │ hand-rolled CSS that cannot be promoted into an app later.            │
  │                                                                       │
  │ Set up the app first, then re-run init (it is idempotent and will     │
  │ fill in what it detects). For a web app or site:                      │
  │   npx create-next-app@latest . --ts --tailwind --app --src-dir        │
  │   npx shadcn@latest init                                              │
  │                                                                       │
  │ design/AGENTS.md was generated with a STOP instruction so your agent  │
  │ does not design against a component library that does not exist.     │
  └───────────────────────────────────────────────────────────────────────┘`)
  }
  console.log(`\n  commit design/ - only .local/ is ignored`)
  console.log(`  uninstall = delete design/, remove the ${NAME} dependency${host.tsconfigSweepsDesign ? ', revert the "design" line in tsconfig exclude' : ''}`)
  console.log(`\n  next: npx ${NAME} dev   (canvas on http://localhost:${DEFAULTS.port} by default)\n`)
  if (!noApp(host)) console.log(`  then, to your agent: "Read design/AGENTS.md. Build an onboarding scene - welcome, form, done - mobile-first, using our components."\n`)
}

const AGENTS_MARKER = '<!-- generated by marver init from the detected stack; re-running init regenerates this file when detection changes. Made edits you want to keep? Delete this line and init will never touch the file again. -->'

/** No framework, no theme, no component alias = nothing to build frames FROM. */
const noApp = (host: HostInfo) =>
  !host.router && !host.tailwind && !host.shadcn && !host.themeCss

/** The UI line of AGENTS.md, matched to what detection actually found (friction log #1). */
function uiGuidance(host: HostInfo): string {
  if (host.shadcn)
    return `Use the app's UI: import from ${host.shadcn.uiAlias}; style with the app's Tailwind classes.`
  if (host.tailwind)
    return `Style with the app's Tailwind classes and design tokens; there is no detected component library - extract shared pieces into design/components/.`
  return `STOP - this repo has no component library, no Tailwind, and no theme. Frames built from hand-rolled CSS cannot be promoted into an app later. Ask the human to set up the app first (framework + styling), then re-run \`npx ${NAME} init\` so this contract regenerates against the real stack.`
}

/** Next.js frames render OUTSIDE Next - say concretely what that means (friction log #10/#11). */
const NEXT_NOTES = `- Next.js caveats (frames render in Vite, outside Next):
  next/font does not exist here - CSS variables it injects (e.g. --font-geist-sans) are
  undefined in frames, so give every font token a real fallback chain in the app's CSS:
  --font-sans: var(--font-geist-sans, ui-sans-serif, system-ui, sans-serif).
  next/image and next/link render as plain img/a via shims at best - prefer <img> and
  data-goto in frames. Server Components and server actions cannot run: frames are
  client components importing client components.
`

const STANDALONE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["."]
}
`

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
  // branding is the small "Powered by Marver.design" line under the gate. Marver is
  // free, and that line is how it spreads - we'd love it if you leave it on, but it
  // is yours to remove, no strings: share: { branding: false }.
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
