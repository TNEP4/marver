/**
 * Jam's keys (spec 27, Part 3, "The keys, everywhere") - the table, in one place. For each key the
 * first state below that is on AND handles that key takes it; a key no state lists falls through to
 * the shell's own keys, unchanged (`J` during a capture, `S` during a review still work):
 *
 *   a read-back open      ⏎ confirm · K keep · R resume (it ended too soon) · Esc drop
 *   the notes card open   Esc closes the card · N puts the focus back in its field
 *   a capture open        E end · S says to end it first · N notes card · I picture · Esc drop
 *   a review open         ⏎ looks good · ⇧⏎ more work · → later / next · ← back · B before/after ·
 *                         ⌥← ⌥→ frame tabs · Esc leave
 *   the lane has the keys ← → move · ⏎ open · ⌘⏎ do next · K keep · ⌫ drop · Esc leave
 *   a session sheet open  ⏎ start (the start sheet) · Esc close it
 *   always                S start a capture · J the session (start it, or end it) · Q the lane · V next capture to review
 *
 * The same table says which keys the shell owns right now; they are mirrored into every frame (a
 * frame consumes an owned key - before a focused button sees ⏎ - and forwards it). `Tab` is never
 * owned. A tag's card never reaches `Q`, `V`, `K` or `⌘⏎`: it lives in its thread.
 */
import { useJamCapture, setOwnedKeys } from './jam-capture.ts'
import { changedShots, useJamQueue, type JamCard } from './jam-queue.ts'
import { DONE_CLOSE, DONE_GROUP, doneFold, useJamUi } from './jam-state.ts'
import { pressJ, startSession, wrapWrite } from './jam-session.tsx'
import { clearMoreDraft } from './jam-panel.tsx'
import { CONFIG, PUBLISHED, SOURCE_REVEALED, useStore } from './store.ts'
import { holdsReload } from './api.ts'

export interface KeyIn { key: string; shift?: boolean; alt?: boolean; meta?: boolean; ctrl?: boolean }
/** `[Ctrl+][Meta+][Alt+][Shift+]key`, a letter lowercase - the frames' descriptor (keys.js). */
export const descriptor = (k: KeyIn): string =>
  `${k.ctrl ? 'Ctrl+' : ''}${k.meta ? 'Meta+' : ''}${k.alt ? 'Alt+' : ''}${k.shift ? 'Shift+' : ''}${k.key.length === 1 ? k.key.toLowerCase() : k.key}`

/** The lane's captures (and a wrap-up), in the order made - the run when one lasts. */
export function laneCards(cards: JamCard[] | null, run: { since: number } | null): JamCard[] {
  if (!cards) return []
  // a dropped capture leaves the lane at once (done and kept ones stay in their run)
  return cards.filter((c) => (c.kind === 'capture' || c.kind === 'wrapup') && c.state !== 'dropped' && (run ? c.made >= run.since : c.state !== 'done' && c.state !== 'kept'))
    .sort((a, b) => a.made - b.made)
}
/** The lane as shown: a draft being resumed steps aside (the recording stands for it) while it is a draft. */
export function shownLane(cards: JamCard[] | null, run: { since: number } | null, resuming: string[]): JamCard[] {
  return laneCards(cards, run).filter((c) => !(c.state === 'draft' && resuming.includes(c.id)))
}
const lane = () => shownLane(useJamQueue.getState().cards, useJamQueue.getState().run, useJamCapture.getState().resuming)
const toReview = () => lane().filter((c) => c.state === 'review')
const cardById = (id: string | null | undefined) => (id ? useJamQueue.getState().cards?.find((c) => c.id === id) : undefined)

// ---- deciding a draft: one path for the buttons and the keys ---------------------------------------

/** Per card: the last save in flight, the words you meant until they saved, and which save is the
 *  latest (an earlier save finishing late never clears a newer edit). */
const saving = new Map<string, Promise<boolean>>()
const unsaved = new Map<string, string>()
const latest = new Map<string, number>()
let gen = 0
/** The words written for a card that have not saved yet - the read-back keeps showing them. */
export const pendingEdit = (id: string): string | undefined => unsaved.get(id)
/** Save the read-back's edit (the text stays where it is if the save fails - see `decideDraft`). */
export function saveEdit(c: JamCard, text: string) {
  const g = ++gen
  latest.set(c.id, g)
  unsaved.set(c.id, text)
  const before = saving.get(c.id) ?? Promise.resolve(true)
  // saves of one card run in order, each at the card's rev as the one before left it
  saving.set(c.id, before.then(() => {
    const fresh = useJamQueue.getState().cards?.find((x) => x.id === c.id) ?? c
    return useJamQueue.getState().act(fresh, 'edit', text)
  }).then((ok) => { if (ok && latest.get(c.id) === g) unsaved.delete(c.id); return ok }))
}
/** Notes added in a read-back not saved yet, per card: each with its own id - one on its way, or one that failed
 *  and waits to be sent again. Sent again (from the field, or before a decision) it keeps its id: the server
 *  keeps a note once, whatever answer was lost; a different note never takes a failed one's place. */
type PendingNote = { id: string; text: string; failed: boolean; order: number }
const unsavedNotes = new Map<string, PendingNote[]>()
// spec 28 A1.11: a page whose canvas came back reloads only once every edit and note of a read-back has saved -
// one that failed while the canvas was away waits for the read-back's own retry (a decision saves it first)
holdsReload(() => unsaved.size > 0 || unsavedNotes.size > 0)
const sendNote = (c: JamCard, n: PendingNote): Promise<boolean> => {
  n.failed = false
  const before = saving.get(c.id) ?? Promise.resolve(true)
  const p = before.then(() => {
    const fresh = useJamQueue.getState().cards?.find((x) => x.id === c.id) ?? c
    return useJamQueue.getState().act(fresh, 'note', JSON.stringify({ id: n.id, text: n.text, order: n.order }))
  }).then((ok) => {
    const list = unsavedNotes.get(c.id) ?? []
    if (ok) { const left = list.filter((x) => x !== n); if (left.length) unsavedNotes.set(c.id, left); else unsavedNotes.delete(c.id) } else n.failed = true
    return ok
  }, () => { n.failed = true; return false })
  saving.set(c.id, p.then(() => true))
  return p
}
/** Add a note to a draft from its read-back: in line with its edits (a decision or a Resume waits for it). The
 *  same `id` again is that note's retry (its words as the field holds them now). */
export function addNote(c: JamCard, text: string, id: string): Promise<boolean> {
  // written when it was first sent: a retry keeps its place among the notes
  const was = (unsavedNotes.get(c.id) ?? []).find((x) => x.id === id)
  const n: PendingNote = { id, text, failed: false, order: was?.order ?? Date.now() }
  unsavedNotes.set(c.id, [...(unsavedNotes.get(c.id) ?? []).filter((x) => x.id !== id), n])
  return sendNote(c, n)
}
/** Every note added to a draft saved (a failed one sent again, once): before it is sent, kept or resumed. */
async function notesSaved(id: string): Promise<boolean> {
  await saving.get(id)
  const c = useJamQueue.getState().cards?.find((x) => x.id === id)
  for (const n of [...(unsavedNotes.get(id) ?? [])]) if (n.failed && c) await sendNote(c, n)
  await saving.get(id)
  return !(unsavedNotes.get(id) ?? []).length
}

/** Confirm or keep a draft AFTER its edit has saved - an edit that failed is saved again first, and
 *  nothing is sent while it still fails; at the card's new rev; the panel closes once the decision
 *  took, and a refusal says why. */
export async function decideDraft(id: string, action: 'confirm' | 'keep' | 'drop') {
  await saving.get(id)
  if (action !== 'drop' && unsaved.has(id)) {
    const c = useJamQueue.getState().cards?.find((x) => x.id === id)
    if (c) saveEdit(c, unsaved.get(id)!)
    await saving.get(id)
    if (unsaved.has(id)) { useStore.getState().toast('your edit could not be saved - look at it again before you send it'); return }
  }
  // a note added in its read-back goes with it: one that did not save is sent again, and nothing is sent without it
  if (action !== 'drop' && unsavedNotes.has(id) && !(await notesSaved(id))) { useStore.getState().toast('your note could not be added - try again before you send it'); return }
  if (action === 'drop') { unsaved.delete(id); unsavedNotes.delete(id) }
  const fresh = useJamQueue.getState().cards?.find((c) => c.id === id)
  if (!fresh) return
  if (await useJamQueue.getState().act(fresh, action)) useJamUi.getState().close()
  else useStore.getState().toast(`the capture could not be ${action === 'confirm' ? 'queued' : action === 'keep' ? 'kept' : 'dropped'} - look again`)
}

/** Leave a field in the open panel (its words save on blur) - before anything takes the panel away. */
const leavePanelField = () => { const a = document.activeElement; if (a instanceof HTMLElement && a.closest('.jm-focus')) a.blur() }

/** Resume a draft that ended too soon: its edit saves first (the resumed capture carries it on), the
 *  read-back closes, and recording goes on where it stopped. */
export async function resumeDraft(id: string) {
  const cap = useJamCapture.getState()
  if (cap.current) { useStore.getState().toast('a capture is recording - press E to end it first'); return }
  if (cap.settling || cardById(id)?.state !== 'draft') return
  // first, at once: leave the editor (its words start saving) and lock the words - from here on nothing
  // typed can race the start; the lock holds through every wait and is let go at the end
  if (useJamUi.getState().panel?.id === id) leavePanelField()
  useJamCapture.setState({ settling: id })
  try {
    // every edit of the draft saved - before the record loads and again after - and it is still a draft
    const settled = async (): Promise<boolean> => {
      for (let i = 0; i < 3 && saving.get(id); i++) { const p = saving.get(id); await p; if (saving.get(id) === p) break }
      if (unsaved.has(id)) { useStore.getState().toast('your edit could not be saved - look at it again before you resume'); return false }
      // its notes added after too: the resumed capture carries them on
      if (unsavedNotes.has(id) && !(await notesSaved(id))) { useStore.getState().toast('your note could not be added - try again before you resume'); return false }
      return cardById(id)?.state === 'draft'
    }
    if (!(await settled())) return
    if (await useJamCapture.getState().resume(id, settled)) {
      // as the UI is NOW (another panel may have opened meanwhile): only what points at it
      const ui = useJamUi.getState()
      if (ui.panel?.id === id) ui.close()
      // its tile has stepped aside: nothing points at it, and the lane gives its keys back
      if (ui.selected === id) { ui.select(null); ui.setLaneKeys(false) }
    }
  } finally { useJamCapture.setState({ settling: null }) }
}

/** What clicking a tile (or ⏎ on it) does: a review opens the review detail, a card that asks opens
 *  its thread, any other capture its detail - the read-back for a draft. */
export function openTile(id: string) {
  const c = cardById(id)
  const ui = useJamUi.getState()
  if (!c) return
  if (c.state === 'asks' && c.thread) {
    ui.select(id)
    openThread(c)
    return
  }
  ui.open({ kind: c.state === 'review' ? 'review' : c.kind === 'wrapup' ? 'wrapup' : 'capture', id })
  reveal(c)
}

/** Open a card's thread - on another board, its link opens that board, then the thread (as a
 *  notification's does). */
export function openThread(c: JamCard) {
  if (!c.thread) return
  if (c.board !== useStore.getState().board) { location.hash = `#/b/${encodeURIComponent(c.board)}?c=${encodeURIComponent(c.thread)}`; return }
  void import('./comments-store.ts').then(({ useComments }) => useComments.getState().setActive(c.thread!))
}

/** Bring a card's frames into view beside the panel - on its own board (a frame link lands there). */
export function reveal(c: JamCard) {
  const s = useStore.getState()
  if (!c.frames.length) return
  if (c.board !== s.board) { location.hash = `#/b/${encodeURIComponent(c.board)}?f=${c.frames.map(encodeURIComponent).join(',')}`; return }
  const keys = s.nodes.filter((n) => c.frames.includes(n.frame)).map((n) => n.key)
  // after the panel has drawn, so the fit measures it and lands the frames in the space right of it
  if (keys.length) void import('./canvas/ctl.ts').then(({ canvasCtl }) => requestAnimationFrame(() => requestAnimationFrame(() => canvasCtl.fitNodes(keys))))
}

/** The next capture to review after `from` (or the oldest), walking the lane left to right. */
function nextReview(from?: string, step = 1) {
  const list = toReview()
  if (!list.length) return null
  const i = from ? list.findIndex((c) => c.id === from) : -1
  return list[i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + step))] ?? null
}

const act = (c: JamCard | undefined, action: Parameters<ReturnType<typeof useJamQueue.getState>['act']>[1], body?: string) =>
  c ? useJamQueue.getState().act(c, action, body) : Promise.resolve(false)

interface Row { on(): boolean; keys: Record<string, () => void> }

/** The run on screen, when a review is open: a capture started now binds it. */
function reviewNow(): { card: string; batch: string; rev: number } | undefined {
  const ui = useJamUi.getState()
  const c = cardById(ui.panel?.id)
  // a capture's review only: a session record is improved through its own More work, never by a capture
  return ui.panel?.kind === 'review' && c?.kind === 'capture' && c.batch ? { card: c.id, batch: c.batch, rev: c.rev } : undefined
}

/** Esc while a laser (pointer or inspect) is on turns it off, and that is all it does. */
const laserOff = (): boolean => { const st = useStore.getState(); if (!st.laser) return false; st.setLaser(false); return true }

/** Start a capture, as S does: one made while a capture's review is open follows that review (its run).
 *  `session`: the session it belongs to when the queue may not show it yet (a session's Start). */
export const startCapture = (session?: string) => useJamCapture.getState().start(reviewNow(), session)

/** A laser on (pointer or inspect): its keys come first - Esc turns it off before it closes, drops or leaves anything -
 *  and are owned, so they work from inside a frame too (a laser click puts the focus there). The one row a published
 *  canvas has (where its source is revealed - the only place a laser exists there). */
const laserRow: Row = {
  on: () => useStore.getState().laser,
  keys: {
    l: () => useStore.getState().toggleLaser(false),
    'Alt+l': () => useStore.getState().toggleLaser(true),
    Escape: () => useStore.getState().setLaser(false),
  },
}
const rowsNow = (): Row[] => (PUBLISHED ? (SOURCE_REVEALED ? [laserRow] : []) : rows())

const rows = (): Row[] => {
  const cap = useJamCapture.getState()
  const ui = useJamUi.getState()
  const panelCard = cardById(ui.panel?.id)
  return [
    laserRow,
    { // a session sheet open: the start sheet's ⏎ starts; Esc closes either (the wrap-up's field keeps its own keys)
      on: () => ui.sheet === 'start' || ui.sheet === 'wrap',
      keys: {
        Enter: () => { if (ui.sheet === 'start') void startSession(); else wrapWrite.current?.() },
        Escape: () => ui.setSheet(null),
        // over the wrap-up, no new capture starts (it would miss the record): close the sheet first
        ...(ui.sheet === 'wrap' ? { s: () => useStore.getState().toast('the session is wrapping up - close the sheet (Esc) to capture again') } : {}),
      },
    },
    { // a read-back open
      on: () => ui.panel?.kind === 'capture' && panelCard?.state === 'draft',
      keys: {
        Enter: () => void decideDraft(panelCard!.id, 'confirm'),
        k: () => void decideDraft(panelCard!.id, 'keep'),
        r: () => void resumeDraft(panelCard!.id),
        // a laser on: Esc turns it off first - never a drop by the way
        Escape: () => { if (laserOff()) return; void decideDraft(panelCard!.id, 'drop') },
      },
    },
    { // the notes card open (in its field, the field handles its own keys)
      on: () => cap.noteOpen,
      keys: {
        Escape: () => cap.setNoteOpen(false),
        n: () => window.dispatchEvent(new CustomEvent('mv-jam-note-focus')),
      },
    },
    { // a capture open
      on: () => !!cap.current,
      keys: {
        e: () => cap.end(),
        s: () => cap.start(),                // one at a time: it says to end this one first
        // L: laser picks - a pick inside a capture is its pick (frames forward it while interacting)
        // L: the pointer laser; ⌥L: inspect - a laser click inside a capture is its pick either way
        l: () => { void import('./comments-store.ts').then(({ useComments }) => useComments.getState().setMode(false)); useStore.getState().toggleLaser(false) },
        'Alt+l': () => { void import('./comments-store.ts').then(({ useComments }) => useComments.getState().setMode(false)); useStore.getState().toggleLaser(true) },
        n: () => { cap.setNoteOpen(true); window.dispatchEvent(new CustomEvent('mv-jam-note-focus')) },
        i: () => cap.picture(),
        // a laser on: Esc turns it off first - the recording goes on
        Escape: () => { if (laserOff()) return; cap.drop() },
      },
    },
    { // a review open
      on: () => ui.panel?.kind === 'review' && !!panelCard,
      keys: {
        Enter: () => { if (ui.moreOpen) return; void act(panelCard, 'good'); const n = nextReview(panelCard!.id); if (n && n.id !== panelCard!.id) { ui.open({ kind: 'review', id: n.id }); reveal(n) } else ui.close() },
        'Shift+Enter': () => ui.setMoreOpen(true),
        ArrowRight: () => { void act(panelCard, 'later'); const n = nextReview(panelCard!.id); if (n) { ui.open({ kind: 'review', id: n.id }); reveal(n); ui.follow() } },
        ArrowLeft: () => { const n = nextReview(panelCard!.id, -1); if (n) { ui.open({ kind: 'review', id: n.id }); reveal(n) } },
        b: () => ui.flip(),
        'Alt+ArrowLeft': () => ui.setTab(Math.max(0, ui.tab - 1)),
        'Alt+ArrowRight': () => ui.setTab(Math.min(Math.max(1, changedShots(panelCard?.shots).length) - 1, ui.tab + 1)),
        Escape: () => { if (ui.moreOpen) { clearMoreDraft(panelCard!.id); ui.setMoreOpen(false) } else ui.close() },   // Esc leaves the composer: its words go
      },
    },
    { // the lane has the keyboard
      on: () => ui.laneKeys,
      keys: (() => {
        const list = lane()
        // the stops as the lane shows them: done tiles folded into one group (two or more), or led by the collapse tile
        const { stops, done } = doneFold(list, ui.doneOpen)
        // acting keys act only on the tile you can see selected - never on a fallback
        const i = ui.selected ? stops.indexOf(ui.selected) : -1
        const sel = i >= 0 ? list.find((c) => c.id === stops[i]) : undefined
        const move = (d: number) => { const n = i < 0 ? stops[stops.length - 1] : stops[Math.min(stops.length - 1, Math.max(0, i + d))]; if (n) ui.select(n) }
        return {
          ArrowLeft: () => move(-1), ArrowRight: () => move(1),
          Enter: () => {
            if (stops[i] === DONE_GROUP) ui.setDoneOpen(true, done.map((c) => c.id))
            else if (stops[i] === DONE_CLOSE) ui.setDoneOpen(false, done.map((c) => c.id))
            else if (sel) openTile(sel.id)
          },
          'Meta+Enter': () => { if (sel?.state === 'queued') void act(sel, 'first') },
          k: () => { if (sel?.state === 'draft') void decideDraft(sel.id, 'keep'); else if (sel?.state === 'queued') void act(sel, 'keep') },
          Backspace: () => { if (sel) void act(sel, 'drop') },
          Escape: () => ui.setLaneKeys(false),
        }
      })(),
    },
    { // always (no field focused) - only where Jam runs: with `jam: false` or no agent the server takes no
      // capture, and the toolbar shows no Jam button either
      on: () => !PUBLISHED && !!CONFIG.jam,
      keys: {
        s: () => startCapture(),
        j: () => pressJ(),
        q: () => { const list = lane(); if (!list.length) return; ui.setLaneKeys(!ui.laneKeys); if (!ui.selected) ui.select(list[list.length - 1].id) },
        v: () => { const n = nextReview(); if (n) { ui.open({ kind: 'review', id: n.id }); reveal(n); ui.follow() } else useStore.getState().toast('nothing to review') },
      },
    },
  ]
}

/** Apply Jam's key if a state takes it. True when it did - the caller stops there. */
export function jamKey(k: KeyIn): boolean {
  const d = descriptor(k)
  for (const row of rowsNow()) {
    if (!row.on()) continue
    const f = row.keys[d] ?? (d.length === 1 ? row.keys[d] : undefined)
    if (f) { f(); syncOwned(); return true }
  }
  return false
}

/** Mirror the keys owned right now into the frames. Called whenever a state may have changed. */
export function syncOwned() {
  const owned = new Set<string>()
  for (const row of rowsNow()) if (row.on()) for (const k of Object.keys(row.keys)) owned.add(k)
  setOwnedKeys([...owned])
}

if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) void import('./canvas/ctl.ts').then(({ canvasCtl }) => { (window as any).__mvJamCanvas = canvasCtl })

if (typeof window !== 'undefined') {
  if (!PUBLISHED) {
    // the states live in three stores: any change may change what is owned
    useJamCapture.subscribe(syncOwned)
    useJamUi.subscribe(syncOwned)
    useJamQueue.subscribe(syncOwned)
  }
  // and the laser (its keys are owned while it is on - on a published canvas too)
  useStore.subscribe((s, p) => { if (s.laser !== p.laser || s.laserInspect !== p.laserInspect) syncOwned() })
}
