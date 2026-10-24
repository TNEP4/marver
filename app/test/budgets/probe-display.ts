/**
 * How a display stream delivers frames on this Mac (spec 28 A3.8 #50's conclusiveness): for `ms` (default 1500), the
 * statuses, the gaps and the largest interval between display times - no pixel is kept, only whether a sentinel block
 * was seen. `node app/test/budgets/probe-display.ts [ms]`
 */
import { startCapture } from '../harness/capture.ts'

const ms = Number(process.argv[2] ?? 1500)
const cap = await startCapture({ mode: 'display', ...(process.argv[5] === 'nodetect' ? {} : { detect: { hex: '00c853', minPx: 64, belowY: 0 } }), heartbeat: process.argv[3] !== 'off', fps: process.argv[4] ? Number(process.argv[4]) : undefined })
await new Promise((r) => setTimeout(r, ms))
await cap.stop()
const by: Record<string, number> = {}
let maxGap = 0
let prev: bigint | null = null
for (const f of cap.frames) {
  by[f.status] = (by[f.status] ?? 0) + 1
  const t = BigInt(f.hostNs)
  if (prev !== null) maxGap = Math.max(maxGap, Number(t - prev) / 1e6)
  prev = t
}
process.stdout.write(JSON.stringify({ refreshHz: cap.ready.refreshHz, frames: cap.frames.length, by, gaps: cap.frames.filter((f) => f.gap).length, maxIntervalMs: Math.round(maxGap * 10) / 10, found: cap.frames.some((f) => f.detect?.found) }) + '\n')
