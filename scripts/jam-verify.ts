/**
 * Live Jam VERIFY-LOOP check - proves an agent can screenshot a frame and actually SEE it.
 *
 *   node scripts/jam-verify.ts <agent> [baseWorkspace]
 *
 * Spins up a REAL `marver dev` (so the shot endpoint + file-drop watcher are live), plants a
 * ledgered @marver mention asking the agent to screenshot a frame and report the ONE headline
 * word it can see, then checks the reply. The frame contains TWO words - one visible, one
 * hidden with display:none - both present in the source. An agent that merely read the .tsx
 * cannot tell which renders; only one that looked at the PNG can. So a correct answer is proof
 * of sight, not of source-reading.
 *
 * The workspace must have React installed for frames to render, so it is CLONED from a real
 * base repo (default: ../tour) - node_modules is symlinked (not copied), design/ is copied
 * minus its live state. A bare `marver init` dir has no deps and every frame errors.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync, cpSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendEvents, readLog, replay } from '../src/server/comments.ts'
import { record } from '../src/server/jam/ledger.ts'

const agent = process.argv[2]
if (!agent) { console.error('usage: node scripts/jam-verify.ts <claude|codex|cursor|droid|opencode|grok|pi> [baseWorkspace]'); process.exit(2) }

const VISIBLE = 'MARMALADE'
const HIDDEN = 'SUBMARINE'
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.mjs')
const base = process.argv[3] ?? join(import.meta.dirname, '..', 'tour')

const root = mkdtempSync(join(tmpdir(), `mv-verify-${agent}-`))
// Clone the base workspace so frames actually render: symlink node_modules (huge, read-only),
// copy the app + design minus live state, carry package.json/tsconfig/theme.
symlinkSync(join(base, 'node_modules'), join(root, 'node_modules'))
for (const f of ['package.json', 'tsconfig.json', 'vite.config.ts', 'index.html']) {
  if (existsSync(join(base, f))) cpSync(join(base, f), join(root, f))
}
cpSync(join(base, 'design'), join(root, 'design'), { recursive: true, filter: (s) => !s.includes('/.local') && !s.includes('/comments') })
for (const appDir of ['src', 'app', 'components', 'lib', 'styles']) {
  if (existsSync(join(base, appDir))) cpSync(join(base, appDir), join(root, appDir), { recursive: true })
}
const run = (args: string[], opts: Record<string, unknown> = {}) => new Promise<{ code: number; out: string }>((res) => {
  const c = spawn(process.execPath, [CLI, ...args], { cwd: root, ...opts })
  let out = ''
  c.stdout?.on('data', (d) => { out += d })
  c.stderr?.on('data', (d) => { out += d })
  c.on('close', (code) => res({ code: code ?? 1, out }))
})

// 1. init the workspace (writes the demo scene, config, and the CURRENT instructions/jam.md)
await run(['init'])

// 2. the verify frame: two words in source, one hidden - only a render tells them apart
mkdirSync(join(root, 'design', 'scenes', 'verify'), { recursive: true })
writeFileSync(join(root, 'design', 'scenes', 'verify', 'hero.tsx'), `export const meta = { title: 'Verify', viewport: 'laptop' }
export default function Hero() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b0b0f', color: '#fff', fontSize: 96, fontWeight: 800, fontFamily: 'system-ui' }}>
      <h1>${VISIBLE}</h1>
      <h1 style={{ display: 'none' }}>${HIDDEN}</h1>
    </div>
  )
}
`)

// 3. point jam at the agent under test
const cfgPath = join(root, 'design', 'config.ts')
writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace(/jam:\s*(\{[^}]*\}|false|true|"[^"]*"),/, `jam: { agent: ${JSON.stringify(agent)}, concurrency: 3 },`))

// 4. boot the real dev server; capture the jam line to confirm it armed the right agent
const dev = spawn(process.execPath, [CLI, 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
let devOut = ''
const ready = new Promise<boolean>((res) => {
  const to = setTimeout(() => res(false), 40_000)
  const onData = (d: Buffer) => { devOut += d; if (/jam: on \(/.test(devOut) && /localhost:\d+/.test(devOut)) { clearTimeout(to); res(true) } }
  dev.stdout?.on('data', onData); dev.stderr?.on('data', onData)
})
const armed = await ready
const jamLine = (devOut.match(/jam: [^\n]+/) ?? ['(no jam line)'])[0]
console.log(`[${agent}] ${jamLine.trim()}`)
if (!armed || !new RegExp(`jam: on \\(${agent}\\)`).test(devOut)) {
  console.log(`[${agent}] JAM-VERIFY FAIL: dev did not arm ${agent} (see boot line above)`)
  dev.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); process.exit(1)
}
await new Promise((r) => setTimeout(r, 2000))   // let the first manifest scan settle

// 5. plant the mention
const dir = join(root, 'design', 'comments')
const id = randomUUID()
appendEvents(dir, 'home', [{
  id, ts: Date.now(), type: 'create', commentId: id, frame: 'verify/hero', nodeKey: 'verify/hero',
  author: { email: 'nic@local', name: 'Nic' },
  body: `Hey @marver: WITHOUT editing anything, take a screenshot of frame verify/hero, LOOK at the rendered image, and reply with the ONE headline word you can actually SEE in it. One word.`,
} as any])
record(root, 'home', id)
console.log(`[${agent}] planted - waiting for the agent to shoot and reply (real tokens)...`)

// 6. wait for a FINAL agent reply (early acks have jam-e ids)
const finalReply = async (): Promise<string | null> => {
  for (let i = 0; i < 100; i++) {
    const replies = replay(readLog(dir, 'home')).flatMap((t) => t.replies.filter((r) => r.agent && !/^jam-c-e\d+-/.test(r.id ?? '')))
    if (replies.length) return replies[replies.length - 1].body ?? ''
    await new Promise((r) => setTimeout(r, 5000))
  }
  return null
}
const reply = await finalReply()

// 7. adjudicate: shot produced? reply names the VISIBLE word and not the HIDDEN one?
const shotsDir = join(root, 'design', '.local', 'shots')
const shots = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => f.endsWith('.png')) : []
const biggestShot = shots.map((f) => statSync(join(shotsDir, f)).size).sort((a, b) => b - a)[0] ?? 0
const results = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => f.endsWith('.result.json')).map((f) => readFileSync(join(shotsDir, f), 'utf8')) : []

console.log(`[${agent}] reply: ${reply ?? '(none)'}`)
console.log(`[${agent}] shots: ${shots.length} (biggest ${Math.round(biggestShot / 1024)}kb) · result files: ${results.length}`)
if (results.length) console.log(`[${agent}] result: ${results[0].replace(/\s+/g, ' ').slice(0, 200)}`)

const up = (reply ?? '').toUpperCase()
const sawVisible = up.includes(VISIBLE)
const sawHidden = up.includes(HIDDEN)
const shotOk = shots.length > 0 && biggestShot > 3000
const ok = !!reply && sawVisible && !sawHidden && shotOk

if (ok) {
  console.log(`[${agent}] JAM-VERIFY PASS - screenshotted and correctly read the VISIBLE word`)
  dev.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); process.exit(0)
} else {
  console.log(`[${agent}] JAM-VERIFY FAIL: reply=${!!reply} sawVisible=${sawVisible} sawHidden=${sawHidden} shot=${shotOk}`)
  console.log(`[${agent}] workspace kept: ${root}`)
  dev.kill('SIGKILL'); process.exit(1)
}
