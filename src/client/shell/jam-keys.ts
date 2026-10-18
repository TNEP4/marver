/**
 * Jam's keys (spec 27, Part 3, "The keys, everywhere") - the table, in one place. For each key the
 * first state below that is on AND handles that key takes it; a key no state lists falls through to
 * the shell's own keys, unchanged (`J` during a capture, `S` during a review still work):
 *
 *   a read-back open      ⏎ confirm · K keep · Esc drop
 *   the notes card open   Esc closes the card · N puts the focus back in its field
 *   a capture open        E end · S end and start the next · N notes card · I picture · Esc drop
 *   a review open         ⏎ looks good · ⇧⏎ more work · → later / next · ← back · B before/after ·
 *                         ⌥← ⌥→ frame tabs · Esc leave
 *   the lane has the keys ← → move · ⏎ open · ⌘⏎ do next · K keep · ⌫ drop · Esc leave
 *   always                S start a capture · Q the lane · V next capture to review
 *
 * The same table says which keys the shell owns right now; they are mirrored into every frame (a
 * frame consumes an owned key - before a focused button sees ⏎ - and forwards it). `Tab` is never
 * owned. A tag's card never reaches `Q`, `V`, `K` or `⌘⏎`: it lives in its thread.
 */
import { useJamCapture, setOwnedKeys } from './jam-capture.ts'
import { useJamQueue, type JamCard } from './jam-queue.ts'
import { useJamUi } from './jam-state.ts'
import { PUBLISHED, useStore } from './store.ts'

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
const toReview = () => laneCards(useJamQueue.getState().cards, useJamQueue.getState().run).filter((c) => c.state === 'review')
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
  if (action === 'drop') unsaved.delete(id)
  const fresh = useJamQueue.getState().cards?.find((c) => c.id === id)
  if (!fresh) return
  if (await useJamQueue.getState().act(fresh, action)) useJamUi.getState().close()
  else useStore.getState().toast(`the capture could not be ${action === 'confirm' ? 'queued' : action === 'keep' ? 'kept' : 'dropped'} - look again`)
}

/** What clicking a tile (or ⏎ on it) does: a review opens the review detail, a card that asks opens
 *  its thread, any other capture its detail - the read-back for a draft. */
export function openTile(id: string) {
  const c = cardById(id)
  const ui = useJamUi.getState()
  if (!c) return
  if (c.state === 'asks' && c.thread) {
    ui.select(id)
    void import('./comments-store.ts').then(({ useComments }) => useComments.getState().setActive(c.thread!))
    return
  }
  ui.open({ kind: c.state === 'review' ? 'review' : c.kind === 'wrapup' ? 'wrapup' : 'capture', id })
  reveal(c)
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

/** The run on screen, when a review is open: a capture started now binds it (and S -> S does again). */
function reviewNow(): { card: string; batch: string; rev: number } | undefined {
  const ui = useJamUi.getState()
  const c = cardById(ui.panel?.id)
  return ui.panel?.kind === 'review' && c?.batch ? { card: c.id, batch: c.batch, rev: c.rev } : undefined
}

const rows = (): Row[] => {
  const cap = useJamCapture.getState()
  const ui = useJamUi.getState()
  const panelCard = cardById(ui.panel?.id)
  return [
    { // a read-back open
      on: () => ui.panel?.kind === 'capture' && panelCard?.state === 'draft',
      keys: {
        Enter: () => void decideDraft(panelCard!.id, 'confirm'),
        k: () => void decideDraft(panelCard!.id, 'keep'),
        Escape: () => void decideDraft(panelCard!.id, 'drop'),
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
        s: () => cap.end(true, reviewNow()),
        // L: laser picks - a pick inside a capture is its pick (frames forward it while interacting)
        l: () => { const st = useStore.getState(); if (!st.laser) void import('./comments-store.ts').then(({ useComments }) => useComments.getState().setMode(false)); st.setLaser(!st.laser) },
        n: () => { cap.setNoteOpen(true); window.dispatchEvent(new CustomEvent('mv-jam-note-focus')) },
        i: () => cap.picture(),
        Escape: () => cap.drop(),
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
        'Alt+ArrowRight': () => ui.setTab(Math.min((panelCard?.shots?.length ?? 1) - 1, ui.tab + 1)),
        Escape: () => (ui.moreOpen ? ui.setMoreOpen(false) : ui.close()),
      },
    },
    { // the lane has the keyboard
      on: () => ui.laneKeys,
      keys: (() => {
        const list = laneCards(useJamQueue.getState().cards, useJamQueue.getState().run)
        const at = Math.max(0, list.findIndex((c) => c.id === ui.selected))
        const sel = list[at]
        const move = (d: number) => { const n = list[Math.min(list.length - 1, Math.max(0, at + d))]; if (n) ui.select(n.id) }
        return {
          ArrowLeft: () => move(-1), ArrowRight: () => move(1),
          Enter: () => { if (sel) openTile(sel.id) },
          'Meta+Enter': () => { if (sel?.state === 'queued') void act(sel, 'first') },
          k: () => { if (sel?.state === 'draft') void decideDraft(sel.id, 'keep'); else if (sel?.state === 'queued') void act(sel, 'keep') },
          Backspace: () => { if (sel) void act(sel, 'drop') },
          Escape: () => ui.setLaneKeys(false),
        }
      })(),
    },
    { // always (no field focused)
      on: () => !PUBLISHED,
      keys: {
        s: () => cap.start(reviewNow()),
        q: () => { const list = laneCards(useJamQueue.getState().cards, useJamQueue.getState().run); if (!list.length) return; ui.setLaneKeys(!ui.laneKeys); if (!ui.selected) ui.select(list[list.length - 1].id) },
        v: () => { const n = nextReview(); if (n) { ui.open({ kind: 'review', id: n.id }); reveal(n); ui.follow() } else useStore.getState().toast('nothing to review') },
      },
    },
  ]
}

/** Apply Jam's key if a state takes it. True when it did - the caller stops there. */
export function jamKey(k: KeyIn): boolean {
  if (PUBLISHED) return false
  const d = descriptor(k)
  for (const row of rows()) {
    if (!row.on()) continue
    const f = row.keys[d] ?? (d.length === 1 ? row.keys[d] : undefined)
    if (f) { f(); syncOwned(); return true }
  }
  return false
}

/** Mirror the keys owned right now into the frames. Called whenever a state may have changed. */
export function syncOwned() {
  if (PUBLISHED) return
  const owned = new Set<string>()
  for (const row of rows()) if (row.on()) for (const k of Object.keys(row.keys)) owned.add(k)
  setOwnedKeys([...owned])
}

if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) void import('./canvas/ctl.ts').then(({ canvasCtl }) => { (window as any).__mvJamCanvas = canvasCtl })

if (typeof window !== 'undefined' && !PUBLISHED) {
  // the states live in three stores: any change may change what is owned
  useJamCapture.subscribe(syncOwned)
  useJamUi.subscribe(syncOwned)
  useJamQueue.subscribe(syncOwned)
}
