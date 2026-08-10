#!/usr/bin/env node
/**
 * Packed-package smoke (SPEC §13 M0): proves packaging completeness, optimizeDeps.exclude,
 * route middleware, and glob-from-node_modules - on the tarball, not the working tree.
 * Usage: node scripts/smoke.mjs   (from the package root)
 */
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const pkgRoot = process.cwd()
const tmp = join(pkgRoot, 'tmp-smoke')
const app = join(tmp, 'app')
const PORT = 5533
let server = null
const fail = (msg) => { console.error(`SMOKE FAIL: ${msg}`); cleanup(); process.exit(1) }
const ok = (msg) => console.log(`  ✓ ${msg}`)
const cleanup = () => { try { server?.kill('SIGTERM') } catch {} }

// 1. pack
rmSync(tmp, { recursive: true, force: true })
mkdirSync(app, { recursive: true })
execSync('npm pack --pack-destination tmp-smoke', { cwd: pkgRoot, stdio: 'pipe' })
const tarball = execSync('ls tmp-smoke/*.tgz', { cwd: pkgRoot }).toString().trim()
ok(`packed ${tarball}`)

// 2. minimal host app (react + tailwind v4, shadcn-style layout)
writeFileSync(join(app, 'package.json'), JSON.stringify({
  name: 'smoke-app', private: true, type: 'module',
  dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
  devDependencies: { tailwindcss: '^4.0.0', '@tailwindcss/vite': '^4.0.0' },
}, null, 2))
writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { jsx: 'react-jsx', moduleResolution: 'bundler', paths: { '@/*': ['./src/*'] } }, include: ['src'],
}, null, 2))
mkdirSync(join(app, 'src/styles'), { recursive: true })
mkdirSync(join(app, 'src/components/ui'), { recursive: true })
writeFileSync(join(app, 'src/styles/theme.css'), '@import "tailwindcss";\n:root { --primary: #111; }\n')
writeFileSync(join(app, 'src/components/ui/button.tsx'),
  `export function Button(p: any) { return <button className="rounded-lg bg-black text-white px-4 py-2" {...p} /> }\n`)
execSync(`npm install --no-audit --no-fund ${join(pkgRoot, tarball)}`, { cwd: app, stdio: 'pipe' })
ok('tarball installed into clean app')

// 3. init
execSync('npx showhome init --mode studio', { cwd: app, stdio: 'pipe' })
if (!existsSync(join(app, 'design/AGENTS.md'))) fail('init did not scaffold AGENTS.md')
if (!existsSync(join(app, 'design/scenes/demo/welcome.tsx'))) fail('init did not scaffold demo scene')
ok('init scaffolded design/')

// 4. dev server
server = spawn('npx', ['showhome', 'dev', '--port', String(PORT)], { cwd: app, stdio: 'pipe' })
const get = async (path) => {
  const res = await fetch(`http://localhost:${PORT}${path}`)
  return { status: res.status, text: await res.text() }
}
let up = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await get('/design/manifest.json')).status === 200) { up = true; break } } catch {}
}
if (!up) fail('dev server never came up')
ok('dev server up')

// 5. assertions
const shell = await get('/')
if (shell.status !== 200 || !shell.text.includes('id="root"')) fail(`shell route: ${shell.status}`)
ok('shell served at /')
const frame = await get('/__sh/frame/?id=demo/welcome&theme=light')
if (frame.status !== 200 || !frame.text.includes('main.tsx')) fail(`frame route: ${frame.status}`)
ok('frame host served')
const manifest = JSON.parse((await get('/design/manifest.json')).text)
if (!manifest.frames.some((f) => f.id === 'demo/welcome')) fail('manifest missing demo frames')
ok(`manifest lists ${manifest.frames.length} frames`)
// glob-from-node_modules: the frame-host module must contain the expanded glob map
const reg = await get('/@fs/' + join(app, 'node_modules/showhome/src/client/frame-host/registry.ts').replaceAll('\\', '/'))
if (!reg.text.includes('/design/scenes/demo/welcome.tsx')) fail('import.meta.glob did not expand from node_modules (optimizeDeps.exclude broken?)')
ok('glob expanded from node_modules (exclude verified)')
// shell module GRAPH must resolve from the packed layout - this is the check that catches
// imports reaching outside the shipped `files` (e.g. src/cli from src/client)
const shellRoots = ['shell/main.tsx', 'shell/store.ts', 'shell/App.tsx', 'frame-host/main.tsx']
for (const mod of shellRoots) {
  const r = await get('/@fs/' + join(app, `node_modules/showhome/src/client/${mod}`).replaceAll('\\', '/'))
  if (r.status !== 200) fail(`shell graph: ${mod} → ${r.status} (import escaping the packed files?)`)
  if (/Failed to resolve import/.test(r.text)) fail(`shell graph: ${mod} has unresolved imports`)
}
ok('shell + frame-host module graphs resolve from the tarball')
// live add
writeFileSync(join(app, 'design/scenes/demo/added.tsx'), 'export default () => <div>added</div>\n')
let seen = false
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 300))
  const m = JSON.parse((await get('/design/manifest.json')).text)
  if (m.frames.some((f) => f.id === 'demo/added')) { seen = true; break }
}
if (!seen) fail('live-added frame never reached the manifest')
ok('live add reached manifest < 3s')

cleanup()
rmSync(tmp, { recursive: true, force: true })
console.log('\nSMOKE PASS')
