/**
 * `marver pdf <board>` - a board's deck as a PDF (spec 31 Part A), made by the running `marver dev` (it owns the frames
 * and the browser) and written to `design/exports/<board>.pdf` (`--notes`: `<board>-notes.pdf`, the handout).
 *
 * The job runs in the dev server; this command starts it, shows its progress, cancels it on Ctrl-C, then fetches the
 * finished file and writes it whole. What it prints is the report: pages, size, time, and every slide that was skipped,
 * clipped, unsettled, patched, rasterised, changed while printing or failed.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { readDevInfo } from '../server/work.ts'
import { NAME } from './name.ts'
import type { PdfReport } from '../server/pdf.ts'

export interface PdfOpts { theme?: string; notes?: boolean; paper?: string; out?: string; raster?: boolean; vector?: boolean; keepGoing?: boolean; json?: boolean }

const mb = (n: number) => (n >= 1e6 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** The report as lines a person reads: the file, then each kind of slide that needs a look. */
export function reportLines(r: PdfReport, out: string): string[] {
  const lines = [`${out} - ${r.pages} page${r.pages === 1 ? '' : 's'}, ${mb(r.bytes)}, ${(r.ms / 1000).toFixed(1)} s`]
  const of = (pred: (s: PdfReport['slides'][number]) => boolean, say: (s: PdfReport['slides'][number]) => string) => r.slides.filter(pred).map(say)
  const group = (label: string, items: string[]) => { if (items.length) lines.push(`  ${label}: ${items.join(', ')}`) }
  group('skipped', r.skipped.map((s) => `${s.frame} (${s.why})`))
  group('failed', of((s) => s.status === 'failed', (s) => `${s.frame} (${s.error ?? 'failed'})`))
  group('patched', of((s) => s.status === 'patched', (s) => `${s.frame} (${[...new Set(s.patches ?? [])].join('; ')})`))
  group('raster', of((s) => s.status === 'raster', (s) => `${s.frame} (${s.raster ?? 'raster'})`))
  group('unsettled', of((s) => !!s.unsettled, (s) => s.frame))
  group('clipped', of((s) => !!s.clipped, (s) => s.frame))
  group('spilled', of((s) => !!s.spilled, (s) => s.frame))
  group('changed while printing', of((s) => !!s.changed, (s) => s.frame))
  const differs = of((s) => !!s.printDiffers, (s) => s.frame)
  group('printed differently from the screen (kept: --vector)', differs)
  if (!r.notes) lines.push(r.certified === 'print' ? '  every page print-certified (rasterised and compared with the screen)' : differs.length ? '  not print-certified: the pages above differ in print' : '  screen-certified only (no PDF rasteriser here)')
  return lines
}

export async function pdfCommand(root: string, board: string | undefined, opts: PdfOpts): Promise<number> {
  const usage = `${NAME} pdf <board> [--theme <name>] [--notes] [--paper letter|a4] [--out <file>] [--raster|--vector] [--keep-going] [--json]`
  if (!board) throw new Error(`name the board: ${usage}`)
  if (opts.raster && opts.vector) throw new Error('--raster or --vector, not both')
  if (opts.paper !== undefined && opts.paper !== 'letter' && opts.paper !== 'a4') throw new Error('--paper is letter or a4')
  if (opts.paper && !opts.notes) throw new Error('--paper is for the handout (--notes): a deck page is its slide\'s own size')
  const info = readDevInfo(root)
  if (!info) throw new Error(`\`${NAME} dev\` is not running in this repo (design/.local/dev.json not found) - start it first.`)
  const base = `http://localhost:${info.port}/__mv/api/pdf`
  const headers = { 'x-mv-work': info.token, 'content-type': 'application/json' }
  const ask = { board, ...(opts.theme ? { theme: opts.theme } : {}), ...(opts.notes ? { notes: true } : {}), ...(opts.paper ? { paper: opts.paper } : {}),
    ...(opts.raster ? { mode: 'raster' } : opts.vector ? { mode: 'vector' } : {}), ...(opts.keepGoing ? { keepGoing: true } : {}) }
  const call = async (url: string, init?: RequestInit) => {
    try { return await fetch(url, init) } catch { throw new Error(`could not reach \`${NAME} dev\` on port ${info.port} - is it still running?`) }
  }
  const started = await call(base, { method: 'POST', headers, body: JSON.stringify(ask) })
  const s0 = await started.json().catch(() => ({})) as { job?: string; error?: string; pages?: number; filename?: string }
  if (!started.ok || !s0.job) throw new Error(s0.error ? `${s0.error}${started.status === 409 && s0.job ? ` (job ${s0.job})` : ''}` : `the PDF could not start (${started.status})`)
  const job = s0.job
  // Ctrl-C cancels the job in the server, then exits
  const onInt = () => { void fetch(`${base}/${job}`, { method: 'DELETE', headers }).finally(() => process.exit(130)) }
  process.once('SIGINT', onInt)
  const tty = process.stderr.isTTY && !opts.json
  let status: { state?: string; page?: number; pages?: number; phase?: string; error?: string; report?: PdfReport; filename?: string } = {}
  try {
    for (;;) {
      const r = await call(`${base}/${job}`, { headers })
      status = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(status.error ?? `lost the job (${r.status})`)
      if (tty) process.stderr.write(`\r  ${status.phase === 'merging' ? 'merging' : status.phase === 'handout' ? 'printing the handout' : `page ${status.page ?? 0} of ${status.pages ?? '?'}`}   `)
      if (status.state !== 'running') break
      await new Promise((res) => setTimeout(res, 400))
    }
  } finally {
    process.removeListener('SIGINT', onInt)
    if (tty) process.stderr.write('\r\x1b[K')
  }
  if (status.state !== 'done' || !status.report) throw new Error(`the PDF ${status.state ?? 'failed'}${status.error ? ` - ${status.error}` : ''}`)
  const file = await call(`${base}/${job}/file`, { headers })
  if (!file.ok) throw new Error(((await file.json().catch(() => ({}))) as { error?: string }).error ?? `could not fetch the PDF (${file.status})`)
  const bytes = Buffer.from(await file.arrayBuffer())
  const out = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(process.cwd(), opts.out)) : join(root, 'design', 'exports', status.filename ?? `${board}.pdf`)
  mkdirSync(dirname(out), { recursive: true })
  const tmp = `${out}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, bytes)
  try { renameSync(tmp, out) } catch (err) { rmSync(tmp, { force: true }); throw err }
  const shown = relative(process.cwd(), out).startsWith('..') ? out : relative(process.cwd(), out) || out
  if (opts.json) console.log(JSON.stringify({ file: out, ...status.report }, null, 2))
  else for (const l of reportLines(status.report, shown)) console.log(l)
  return status.report.slides.some((s) => s.status === 'failed') ? 1 : 0
}
