import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'

/**
 * The app's bundles (spec 28 A2.14 #29), run by scripts/build.mjs - never on its own, since the build also
 * copies the pages' HTML and CSS, the shell's tokens and writes `pages/manifest.json`.
 *
 * - main, as CJS: `electron` and Node's built-ins stay outside; the package code main imports by path
 *   (`src/server/proof.ts`, `src/shared/*`) is bundled in.
 * - each preload on its own build, so no chunk is ever shared: a sandboxed preload may `require` only
 *   `electron` (test/unit/bundle.test.ts checks the output).
 * - each page (`pages/<page>/main.ts`) as one browser IIFE.
 *
 * MV_FLAVOUR=release builds the release flavour (the guard on, no test hooks); anything else the dev
 * flavour. MV_OUT moves the output (the release build writes into its stage).
 */
const release = process.env.MV_FLAVOUR === 'release'
const outDir = process.env.MV_OUT ?? 'dist'
const define = { __MARVER_RELEASE__: JSON.stringify(release), __MV_TEST__: JSON.stringify(!release) }

const common: UserConfig = {
  outDir, define, clean: false, dts: false, hash: false, report: false, publint: false,
  sourcemap: !release, treeshake: true, logLevel: 'warn',
  deps: { neverBundle: ['electron'] },
}

// the release bundle carries no comments: the test hooks' JSDoc would otherwise survive their code
const comments = !release

const node = (name: string, entry: string): UserConfig => ({
  ...common, entry: { [name]: entry }, format: 'cjs', platform: 'node', target: 'node22',
  outExtensions: () => ({ js: '.cjs' }), outputOptions: { comments },
})

const pagesDir = join(import.meta.dirname, 'pages')
const pages = existsSync(pagesDir)
  ? readdirSync(pagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(pagesDir, d.name, 'main.ts')))
      .map((d) => d.name)
  : []

const page = (p: string): UserConfig => ({
  ...common, entry: { [`pages/${p}/main`]: `pages/${p}/main.ts` }, format: 'iife', platform: 'browser',
  target: 'chrome140', deps: {},
  // tsdown names an IIFE `<name>.iife.js`; the pages load `main.js`
  outputOptions: { entryFileNames: '[name].js', comments },
})

export default defineConfig([
  node('main', 'src/main/main.ts'),
  node('preload-canvas', 'src/preload/canvas.ts'),
  node('preload-app', 'src/preload/app.ts'),
  ...pages.map(page),
])
