/** A deck PDF's report as the shell's notice says it (spec 31): pure, so the suite reads it without the shell. */
export interface PdfReportLite { skipped?: unknown[]; slides?: { status?: string; clipped?: boolean; unsettled?: boolean; spilled?: boolean; changed?: boolean; printDiffers?: boolean }[] }
/** The report's warnings in a few words ("· 2 pictures, 1 clipped"), or nothing - `marver pdf` prints them in full. */
export function reportNotes(r: PdfReportLite | undefined): string {
  if (!r?.slides) return ''
  const n = (pred: (s: NonNullable<PdfReportLite['slides']>[number]) => boolean) => r.slides!.filter(pred).length
  const parts = [
    [r.skipped?.length ?? 0, 'skipped'], [n((s) => s.status === 'failed'), 'failed'], [n((s) => s.status === 'raster'), 'as pictures'],
    [n((s) => !!s.unsettled), 'unsettled'], [n((s) => !!s.clipped), 'clipped'], [n((s) => !!s.spilled), 'spilled'],
    [n((s) => !!s.changed), 'changed while printing'], [n((s) => !!s.printDiffers), 'printed differently'],
  ].filter(([c]) => (c as number) > 0).map(([c, w]) => `${c} ${w}`)
  return parts.length ? ` · ${parts.join(', ')} (npx marver pdf says which)` : ''
}
