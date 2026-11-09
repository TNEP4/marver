/**
 * File > Export PDF… and the shell's Export PDF in the app (spec 31 Part A): the canvas made the PDF; the shell sends
 * only the finished job's id (`mv:export-pdf`). Main does the rest itself, from the admitted canvas origin:
 *
 *   1. the id must be a job id (128 random bits, base64url) - nothing else is ever put in a URL;
 *   2. the job is asked on the canvas tab's own session (its owner cookie, echoed as `x-mv-c`, so the canvas's owner
 *      gate applies), with no redirect followed: it must be finished, and its file name is checked (else `deck.pdf`);
 *   3. the save panel opens on ~/Downloads/<name>; closed, nothing more happens;
 *   4. the document that asked is checked again (still the admitted, trusted one) - the panel took the person's time -
 *      and once more right before the write;
 *   5. the file is fetched the same way: `application/pdf`, 200 MB at most as it arrives, starting `%PDF-`;
 *   6. it is written whole (a temp file beside it, then a rename) where the panel said.
 *
 * Pure (its ports are injected): bridge.ts admits the ask, main.ts gives it the tab's session, the panel and the disk.
 */
import { join } from 'node:path'
import { PDF_JOB, PDF_MAX, type ExportPdfAnswer } from '../../../src/shared/app-api.ts'

export interface PdfSavePorts {
  /** the admitted canvas origin (`http://localhost:<port>`) */
  origin: string
  /** a GET on the canvas tab's own session (its cookies); never follows a redirect */
  fetch(url: string, headers: Record<string, string>): Promise<Response>
  /** the canvas's owner cookie (`mv_c`) as the tab's session holds it, or null */
  csrf(): Promise<string | null>
  downloads(): string
  /** the save panel on `defaultPath`: the path chosen, or null */
  savePanel(defaultPath: string): Promise<string | null>
  /** the asking document is still the tab's admitted, trusted one */
  still(): boolean
  write(file: string, bytes: Buffer): Promise<void>
}

/** A job's file name as the canvas offers it, when it is a plain `.pdf` name; else `deck.pdf`. */
export const pdfName = (n: unknown): string => (typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.pdf$/.test(n) && !n.includes('..') ? n : 'deck.pdf')

/** Read a response's body, `max` bytes at most as it arrives: the bytes, or 'large'. */
export async function readCapped(r: Response, max: number): Promise<Buffer | 'large'> {
  const len = Number(r.headers.get('content-length'))
  if (Number.isFinite(len) && len > max) { try { await r.body?.cancel() } catch { /* gone */ } return 'large' }
  if (!r.body) return Buffer.alloc(0)
  const reader = r.body.getReader()
  const chunks: Buffer[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) { try { await reader.cancel() } catch { /* gone */ } return 'large' }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export async function savePdf(job: unknown, p: PdfSavePorts): Promise<ExportPdfAnswer> {
  if (typeof job !== 'string' || !PDF_JOB.test(job)) return { ok: false, why: 'bad-job' }
  let csrf: string | null
  try { csrf = await p.csrf() } catch { csrf = null }
  if (!csrf) return { ok: false, why: 'untrusted' }
  const headers = { 'x-mv-c': csrf }
  const base = `${p.origin}/__mv/api/pdf/${job}`
  let name: string
  try {
    const r = await p.fetch(base, headers)
    if (!r.ok) return { ok: false, why: 'bad-job' }
    const st = await readCapped(r, 1 << 20)
    if (st === 'large') return { ok: false, why: 'bad-job' }
    const body = JSON.parse(st.toString('utf8')) as { state?: unknown; filename?: unknown }
    if (body?.state !== 'done') return { ok: false, why: 'bad-job' }
    name = pdfName(body.filename)
  } catch { return { ok: false, why: 'failed' } }
  let file: string | null
  try { file = await p.savePanel(join(p.downloads(), name)) } catch { return { ok: false, why: 'failed' } }
  if (!file) return { ok: false, why: 'cancelled' }
  // the panel took the person's time: the document that asked must still be the one admitted
  if (!p.still()) return { ok: false, why: 'untrusted' }
  let bytes: Buffer
  try {
    const f = await p.fetch(`${base}/file`, headers)
    if (!f.ok || !/^application\/pdf\b/i.test(f.headers.get('content-type') ?? '')) { try { await f.body?.cancel() } catch { /* gone */ } return { ok: false, why: f.status === 404 ? 'bad-job' : 'failed' } }
    const b = await readCapped(f, PDF_MAX)
    if (b === 'large') return { ok: false, why: 'too-large' }
    if (b.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, why: 'failed' }
    bytes = b
  } catch { return { ok: false, why: 'failed' } }
  // and again right before the write: the fetch and the read took time too
  if (!p.still()) return { ok: false, why: 'untrusted' }
  try { await p.write(file, bytes) } catch { return { ok: false, why: 'failed' } }
  return { ok: true }
}
