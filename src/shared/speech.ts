// Shared by the server (a capture's words, jam/capture.ts) and the page (the read-back's text,
// shell/jam-panel.tsx): one way to write what was said and written.

/** Words and notes as you read them: what was said runs on as one line until a note, and every note is
 *  its own line. */
export function speechLines(parts: { kind: 'words' | 'note'; text: string }[]): string {
  const out: string[] = []
  let said = ''
  const flush = () => { if (said.trim()) out.push(said.replace(/\s+/g, ' ').trim()); said = '' }
  for (const p of parts) {
    if (p.kind === 'words') said += ' ' + p.text
    else { flush(); const t = p.text.replace(/\s+/g, ' ').trim(); if (t) out.push(t) }
  }
  flush()
  return out.join('\n')
}
