/**
 * `marver perf` (spec 26 Part 1): the reload log read back - per edited file, the frames it reached
 * and how; every page-wide reload (sent or dropped) and every time the canvas page itself booted,
 * with what came just before; the slowest frames to settle. Reads design/.local/perf/reloads.jsonl.
 */
import { readReloads } from '../server/perf.ts'
import { readJam } from '../server/perf-jam.ts'

export function perfCommand(root: string, opts: { minutes?: number; json?: boolean; jam?: boolean }): void {
  if (opts.jam) return jamPerf(root, opts)
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
  const booted = log.filter((e) => e.kind === 'ready')
  const by = (c: string) => booted.filter((e) => e.cause === c).length
  const reloaded = by('job')
  if (opts.json) {
    console.log(JSON.stringify({ minutes, files: Object.fromEntries([...files].map(([k, v]) => [k, { edits: v.edits, reached: [...v.reload], inPlace: [...v.inPlace] }])), documents: { afterEdit: reloaded, byHand: by('manual'), retried: by('retry'), self: by('self'), first: by('first') }, reloads, boots, slow }, null, 2))
    return
  }
  const t = (ts: number) => new Date(ts).toLocaleTimeString()
  console.log(`last ${minutes} min - design/.local/perf/reloads.jsonl`)
  console.log(`\nedits (${files.size} files)`)
  for (const [file, f] of [...files].sort((a, b) => b[1].edits - a[1].edits))
    console.log(`  ${file}  ${f.edits}x  reached ${f.reload.size} frame${f.reload.size === 1 ? '' : 's'}${f.inPlace.size ? `, ${f.inPlace.size} updated in place` : ''}`)
  console.log(`\nframe documents booted: ${reloaded} after an edit (a frame off screen reloads when it comes into view), ${by('first')} first loads, ${by('manual')} by hand, ${by('retry')} watchdog retries, ${by('self')} reloaded themselves`)
  console.log(`\npage-wide reloads: ${reloads.filter((r) => r.passed).length} sent (dependency rebuilds), ${reloads.filter((r) => !r.passed).length} dropped`)
  for (const r of reloads) console.log(`  ${t(r.ts)}  ${r.passed ? 'sent   ' : 'dropped'}  ${r.triggeredBy ?? 'no file named'}`)
  console.log(`\ncanvas page loads: ${boots.length}`)
  for (const b of boots) console.log(`  ${t(b.ts)}${b.before.length ? `  after: ${b.before.map((x) => x.kind + (x.file ? ` ${x.file}` : '')).join(', ')}` : ''}`)
  if (slow.length) {
    console.log('\nslowest to settle')
    for (const s of slow) console.log(`  ${s.frame}  ${s.ms} ms`)
  }
}

/** Count, median, p90 and max of a list of ms. */
export function spread(xs: number[]): { n: number; median?: number; p90?: number; max?: number } {
  if (!xs.length) return { n: 0 }
  const v = [...xs].sort((a, b) => a - b)
  const at = (q: number) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)]
  return { n: v.length, median: at(0.5), p90: at(0.9), max: v[v.length - 1] }
}

/** `marver perf --jam`: each step of a capture and its run - count, median, p90, max - the runs by outcome, and the
 *  last problems, from design/.local/perf/jam.jsonl (numbers and codes only). */
export function jamSummary(events: Record<string, any>[]) {
  const of = (kind: string) => events.filter((e) => e.kind === kind)
  const nums = (xs: unknown[]) => xs.filter((x): x is number => typeof x === 'number')
  const caps = of('capture'), runs = of('run').filter((r) => !r.redelivered), shots = of('shot'), words = of('words')
  const steps = {
    'capture: E to sealed': spread(nums(caps.map((c) => c.sealMs))),
    'capture: last words': spread(nums(caps.map((c) => c.wordsWaitMs))),
    'capture: a picture': spread(nums(caps.flatMap((c) => c.pictures?.ms ?? []))),
    'upload': spread(nums(of('upload').map((u) => u.ms))),
    'naming': spread(nums(of('name').map((n) => n.ms))),
    'words: wait': spread(nums(words.map((w) => w.waitMs))),
    'words: transcription': spread(nums(words.map((w) => w.decodeMs))),
    'words: model load': spread(nums(words.map((w) => w.modelLoadMs))),
    'run: queued': spread(nums(runs.flatMap((r) => (r.members ?? []).map((m: any) => m.waitMs)))),
    'run: pictures before': spread(nums(runs.map((r) => r.beforeMs))),
    'run: agent': spread(nums(runs.flatMap((r) => r.agentMs ?? []))),
    'run: pictures after': spread(nums(runs.map((r) => r.afterMs))),
    'run: delivery': spread(nums(of('run').map((r) => r.deliverMs))),
    'shot': spread(nums(shots.map((s) => s.ms))),
  }
  const outcomes: Record<string, number> = {}
  for (const r of runs) for (const m of r.members ?? []) outcomes[m.outcome ?? 'unknown'] = (outcomes[m.outcome ?? 'unknown'] ?? 0) + 1
  const problems = [
    // every run line with a failure - a redelivery that gave up too (the counts above take first runs only)
    ...of('run').filter((r) => r.failure).map((r) => ({ ts: r.ts, what: `run ${String(r.batch).slice(0, 8)} ${r.redelivered ? 'could not post its replies' : `failed: ${r.failure}`}` })),
    ...shots.filter((s) => s.outcome && s.outcome !== 'ok').map((s) => ({ ts: s.ts, what: `shot ${s.frame ?? '?'}: ${s.outcome}${s.recaptures ? ` after ${s.recaptures} retakes` : ''}` })),
    ...caps.filter((c) => c.pictures?.late || c.pictures?.failed).map((c) => ({ ts: c.ts, what: `capture ${c.capture}: ${c.pictures.late ?? 0} picture(s) too late, ${c.pictures.failed ?? 0} failed` })),
    ...of('name').filter((n) => !n.ok).map((n) => ({ ts: n.ts, what: `naming ${n.capture} gave no name` })),
    ...of('dropped').map((d) => ({ ts: d.ts, what: `${d.count} event(s) dropped (the log was busy)` })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 10)
  return { steps, outcomes, problems, retakes: shots.reduce((n, s) => n + (s.recaptures ?? 0), 0) }
}

function jamPerf(root: string, opts: { minutes?: number; json?: boolean }) {
  const minutes = Number(opts.minutes) > 0 ? Number(opts.minutes) : 24 * 60
  const since = Date.now() - minutes * 60_000
  const { events, first } = readJam(root, since)
  const sum = jamSummary(events)
  const partial = first !== undefined && first > since
  if (opts.json) { console.log(JSON.stringify({ minutes, ...(partial ? { startsAt: first } : {}), ...sum }, null, 2)); return }
  const span = minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`
  console.log(`Jam timings, last ${span} - design/.local/perf/jam.jsonl${partial ? ` (the log starts ${new Date(first!).toLocaleString()})` : ''}`)
  if (!events.length) { console.log('\nnothing yet - captures, runs and shots log here as they happen'); return }
  console.log('')
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length))
  console.log(`  ${pad('step', 24)}${pad('count', 7)}${pad('median', 9)}${pad('p90', 9)}max`)
  const f = (v?: number) => (v === undefined ? '-' : v >= 10_000 ? `${(v / 1000).toFixed(0)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`)
  for (const [name, x] of Object.entries(sum.steps)) if (x.n) console.log(`  ${pad(name, 24)}${pad(String(x.n), 7)}${pad(f(x.median), 9)}${pad(f(x.p90), 9)}${f(x.max)}`)
  const out = Object.entries(sum.outcomes)
  if (out.length) console.log(`\nruns by outcome: ${out.map(([k, n]) => `${n} ${k}`).join(', ')}`)
  if (sum.retakes) console.log(`pictures taken again (a stale surface): ${sum.retakes}`)
  if (sum.problems.length) {
    console.log('\nlately')
    for (const p of sum.problems) console.log(`  ${new Date(p.ts).toLocaleTimeString()}  ${p.what}`)
  }
}
