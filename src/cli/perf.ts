/**
 * `marver perf` (spec 26 Part 1): the reload log read back - per edited file, the frames it reached
 * and how; every page-wide reload (sent or dropped) and every time the canvas page itself booted,
 * with what came just before; the slowest frames to settle. Reads design/.local/perf/reloads.jsonl.
 */
import { readReloads } from '../server/perf.ts'

export function perfCommand(root: string, opts: { minutes?: number; json?: boolean }): void {
  const minutes = Number(opts.minutes) > 0 ? Number(opts.minutes) : 60
  const log = readReloads(root, Date.now() - minutes * 60_000)
  const files = new Map<string, { edits: number; reload: Set<string>; inPlace: Set<string> }>()
  for (const e of log) if (e.kind === 'update') {
    const f = files.get(e.file ?? '(no file)') ?? { edits: 0, reload: new Set(), inPlace: new Set() }
    f.edits++
    for (const id of e.reload ?? []) f.reload.add(id)
    for (const id of e.inPlace ?? []) f.inPlace.add(id)
    files.set(e.file ?? '(no file)', f)
  }
  const reloads = log.filter((e) => e.kind === 'full-reload')
  const boots = log.flatMap((e, i) => (e.kind === 'shell-boot' ? [{ ts: e.ts, before: log.slice(Math.max(0, i - 3), i).filter((x) => x.kind !== 'ready' && x.kind !== 'settled') }] : []))
  const slow = log.filter((e) => e.kind === 'settled' && typeof e.ms === 'number').sort((a, b) => b.ms - a.ms).slice(0, 5)
  if (opts.json) {
    console.log(JSON.stringify({ minutes, files: Object.fromEntries([...files].map(([k, v]) => [k, { edits: v.edits, reload: [...v.reload], inPlace: [...v.inPlace] }])), reloads, boots, slow }, null, 2))
    return
  }
  const t = (ts: number) => new Date(ts).toLocaleTimeString()
  console.log(`last ${minutes} min - design/.local/perf/reloads.jsonl`)
  console.log(`\nedits (${files.size} files)`)
  for (const [file, f] of [...files].sort((a, b) => b[1].edits - a[1].edits))
    console.log(`  ${file}  ${f.edits}x  reloaded ${f.reload.size} frame${f.reload.size === 1 ? '' : 's'}${f.inPlace.size ? `, ${f.inPlace.size} updated in place` : ''}`)
  console.log(`\npage-wide reloads: ${reloads.filter((r) => r.passed).length} sent (dependency rebuilds), ${reloads.filter((r) => !r.passed).length} dropped`)
  for (const r of reloads) console.log(`  ${t(r.ts)}  ${r.passed ? 'sent   ' : 'dropped'}  ${r.triggeredBy ?? 'no file named'}`)
  console.log(`\ncanvas page loads: ${boots.length}`)
  for (const b of boots) console.log(`  ${t(b.ts)}${b.before.length ? `  after: ${b.before.map((x) => x.kind + (x.file ? ` ${x.file}` : '')).join(', ')}` : ''}`)
  if (slow.length) {
    console.log('\nslowest to settle')
    for (const s of slow) console.log(`  ${s.frame}  ${s.ms} ms`)
  }
}
