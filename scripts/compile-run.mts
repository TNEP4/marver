import { ArtifactStore } from '../src/server/artifacts.ts'
import { Compiler, type CompileJob } from '../src/server/compiler.ts'

const BASE = 'http://localhost:5350'
const ROOT = process.env.HOME + '/marver-pilot'
const store = new ArtifactStore(ROOT + '/design/.local/artifacts/v1', '/__mv/artifacts/v1')
const compiler = new Compiler(BASE, store, { concurrency: 4, globalEnvRevision: 'g1', serializerVersion: 'v4' })

// a handful of real pilot frames (mixed: form, dashboard, pricing, gate)
const jobs: CompileJob[] = [
  { frameId: 'demo/form', theme: 'light', width: 390, height: 844, kind: 'tsx', depRevision: 'r1' },
  { frameId: 'demo/pricing', theme: 'light', width: 1280, height: 900, kind: 'tsx', depRevision: 'r1' },
  { frameId: 'demo/welcome', theme: 'light', width: 390, height: 844, kind: 'tsx', depRevision: 'r1' },
  { frameId: 'checkout/cart', theme: 'light', width: 1280, height: 900, kind: 'tsx', depRevision: 'r1' },
  { frameId: 'dashboard/overview', theme: 'light', width: 1280, height: 900, kind: 'tsx', depRevision: 'r1' },
  { frameId: 'gate-v2/contract', theme: 'light', width: 1280, height: 900, kind: 'tsx', depRevision: 'r1' },
]
const t0 = Date.now()
const res = await compiler.compileMany(jobs, (v, j) => console.log(`  ${j.frameId.padEnd(22)} ${v.status.padEnd(12)} ${v.bytes} bytes  ${v.objectHash.slice(0,10)}`))
console.log(`\ncompiled ${jobs.length} in ${Date.now()-t0}ms  (ok:${res.ok} failed:${res.failed})  engine=${compiler.browserEngine()}`)
await compiler.close()
