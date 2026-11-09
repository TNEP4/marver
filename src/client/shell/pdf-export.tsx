/**
 * Export PDF in the shell (spec 31 Part A): the board menu, slides and present mode's bar, and the app's File menu all
 * come here. The dev server makes the PDF (`/__mv/api/pdf`, one job per canvas); a notice shows its progress; when it
 * is done a browser downloads the file, and the Mac app - sent only the job id - fetches it itself and saves it where
 * its save panel says.
 */
import { create } from 'zustand'
import { api } from './api.ts'
import { APP } from './marver-app.ts'
import { boardLabel, PUBLISHED, useStore } from './store.ts'
import { cmd, type CmdOpts } from './commands.ts'
import { ExportIcon, XIcon } from './icons.tsx'

const csrf = () => /(?:^|;\s*)mv_c=([\w-]+)/.exec(document.cookie)?.[1] ?? ''

interface PdfState {
  job: string | null
  board: string
  page: number
  pages: number
  phase: string
  /** `saving`: the app's save panel is open */
  state: 'idle' | 'running' | 'saving'
}
export const usePdfExport = create<PdfState>(() => ({ job: null, board: '', page: 0, pages: 0, phase: '', state: 'idle' }))

/** Can the shell export here? A dev canvas only (a published one has no browser to print with). */
export const canExportPdf = (): boolean => !PUBLISHED

const toast = (t: string) => useStore.getState().toast(t)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Start a PDF of `board` and see it through: progress in the notice, then the file downloaded (or, in the app, saved
 *  through its panel). `theme`: what the stage shows, when asked from slides or present mode. */
export async function exportPdf(board: string, o: { theme?: string }, how: CmdOpts): Promise<void> {
  const h = cmd('export-pdf', { ...how, board })
  if (!canExportPdf()) { h.noop('busy'); return }
  if (usePdfExport.getState().state !== 'idle') { h.noop('busy'); toast('a PDF is already being made'); return }
  // the server prints the board file: this board's edits waiting for their autosave go first
  const s = () => useStore.getState()
  if (s().board === board) for (let i = 0; i < 5 && s().dirty; i++) if (!(await s().save())) break
  if (s().board === board && s().dirty) { h.fail('api'); toast('this board\'s latest changes are not saved yet - try again in a moment'); return }
  let job: string
  try {
    const r = await api('pdf', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-c': csrf() }, body: JSON.stringify({ board, ...(o.theme ? { theme: o.theme } : {}) }) })
    const b = await r.json().catch(() => ({})) as { job?: string; error?: string; pages?: number }
    if (!r.ok || !b.job) { h.fail('api'); toast(b.error ?? `the PDF could not start (${r.status})`); return }
    job = b.job
    usePdfExport.setState({ job, board, page: 0, pages: b.pages ?? 0, phase: 'starting', state: 'running' })
    h.done()
  } catch { h.fail('api'); toast('could not reach the dev server'); return }
  // this export is still the one the notice shows: a Cancel (here or a newer export) ends it after any await
  const alive = () => usePdfExport.getState().job === job
  try {
    let st: { state?: string; page?: number; pages?: number; phase?: string; error?: string; filename?: string } = {}
    for (;;) {
      await wait(500)
      if (!alive()) return
      const r = await api(`pdf/${job}`, { headers: { 'x-mv-c': csrf() } })
      st = await r.json().catch(() => ({}))
      if (!alive()) return
      if (!r.ok) { toast(st.error ?? 'the PDF job was lost'); return }
      usePdfExport.setState({ page: st.page ?? 0, pages: st.pages ?? 0, phase: st.phase ?? '' })
      if (st.state !== 'running') break
    }
    if (st.state === 'cancelled') return
    if (st.state !== 'done') { toast(`the PDF failed${st.error ? ` - ${st.error}` : ''}`); return }
    const name = st.filename ?? `${board}.pdf`
    if (APP?.exportPdf) {
      // the app fetches the file itself from this canvas and saves it where its panel says: only the id crosses
      if (!alive()) return
      usePdfExport.setState({ state: 'saving' })
      const a = await APP.exportPdf({ job })
      if (a.ok) toast(`${name} saved`)
      else if (a.why !== 'cancelled') toast(`the PDF was not saved (${a.why})`)
      return
    }
    const f = await api(`pdf/${job}/file`, { headers: { 'x-mv-c': csrf() } })
    if (!alive()) return
    if (!f.ok) { toast(`could not fetch the PDF (${f.status})`); return }
    const blob = await f.blob()
    if (!alive()) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = name; a.rel = 'noopener'
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    toast(`${name} downloaded`)
  } catch { toast('the PDF was interrupted - is the dev server still running?') }
  finally { if (alive()) usePdfExport.setState({ job: null, state: 'idle', page: 0, pages: 0, phase: '' }) }
}

/** Cancel the PDF being made (the server closes its browser; nothing of it stays). */
export async function cancelPdf(how: CmdOpts): Promise<void> {
  const { job, board } = usePdfExport.getState()
  const h = cmd('export-pdf-cancel', { ...how, ...(board ? { board } : {}) })
  if (!job) { h.done(); return }
  usePdfExport.setState({ job: null, state: 'idle', page: 0, pages: 0, phase: '' })
  try {
    const r = await api(`pdf/${job}`, { method: 'DELETE', headers: { 'x-mv-c': csrf() } })
    if (r.ok) { h.done(); toast('PDF cancelled') } else h.fail('api')
  } catch { h.fail('api') }
}

/** The notice while a PDF is made: its board, its page, and Cancel. */
export function PdfNotice() {
  const s = usePdfExport()
  if (s.state === 'idle') return null
  const what = s.state === 'saving' ? 'Saving' : s.phase === 'merging' ? 'Finishing' : s.phase === 'handout' ? 'Printing the handout' : s.pages ? `Page ${Math.min(s.page + 1, s.pages)} of ${s.pages}` : 'Starting'
  return (
    <div className="sh-toast sh-pdf-notice" role="status" aria-live="polite">
      <ExportIcon size={13} />
      <span><b>{boardLabel(s.board)}</b> PDF · {what}</span>
      {s.pages > 0 && s.state === 'running' && <span className="bar"><i style={{ width: `${Math.round((s.page / s.pages) * 100)}%` }} /></span>}
      {s.state === 'running' && <button aria-label="Cancel the PDF" onClick={() => void cancelPdf({ via: 'click', in: 'shell' })}><XIcon size={11} /></button>}
    </div>
  )
}
