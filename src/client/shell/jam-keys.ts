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
  return cards.filter((c) => (c.kind === 'capture' || c.kind === 'wrapup') && (run ? c.made >= run.since : c.state !== 'done' && c.state !== 'kept' && c.state !== 'dropped'))
    .sort((a, b) => a.made - b.made)
}
const toReview = () => laneCards(useJamQueue.getState().cards, useJamQueue.getState().run).filter((c) => c.state === 'review')
const cardById = (id: string | null | undefined) => (id ? useJamQueue.getState().cards?.find((c) => c.id === id) : undefined)

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

const rows = (): Row[] => {
  const cap = useJamCapture.getState()
  const ui = useJamUi.getState()
  const panelCard = cardById(ui.panel?.id)
  return [
    { // a read-back open
      on: () => ui.panel?.kind === 'capture' && panelCard?.state === 'draft',
      keys: {
        Enter: () => { void act(panelCard, 'confirm'); ui.close() },
        k: () => { void act(panelCard, 'keep'); ui.close() },
        Escape: () => { void act(panelCard, 'drop'); ui.close() },
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
        s: () => cap.end(true),
        n: () => { cap.setNoteOpen(true); window.dispatchEvent(new CustomEvent('mv-jam-note-focus')) },
        i: () => cap.picture(),
        Escape: () => cap.drop(),
      },
    },
    { // a review open
      on: () => ui.panel?.kind === 'review' && !!panelCard,
      keys: {
        Enter: () => { if (ui.moreOpen) return; void act(panelCard, 'good'); const n = nextReview(panelCard!.id); n && n.id !== panelCard!.id ? ui.open({ kind: 'review', id: n.id }) : ui.close() },
        'Shift+Enter': () => ui.setMoreOpen(true),
        ArrowRight: () => { void act(panelCard, 'later'); const n = nextReview(panelCard!.id); if (n) { ui.open({ kind: 'review', id: n.id }); ui.follow() } },
        ArrowLeft: () => { const n = nextReview(panelCard!.id, -1); if (n) ui.open({ kind: 'review', id: n.id }) },
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
          k: () => { if (sel?.state === 'queued' || sel?.state === 'draft') void act(sel, 'keep') },
          Backspace: () => { if (sel) void act(sel, 'drop') },
          Escape: () => ui.setLaneKeys(false),
        }
      })(),
    },
    { // always (no field focused)
      on: () => !PUBLISHED,
      keys: {
        s: () => { const r = ui.panel?.kind === 'review' && panelCard?.batch ? { card: panelCard.id, batch: panelCard.batch, rev: panelCard.rev } : undefined; cap.start(r) },
        q: () => { const list = laneCards(useJamQueue.getState().cards, useJamQueue.getState().run); if (!list.length) return; ui.setLaneKeys(!ui.laneKeys); if (!ui.selected) ui.select(list[list.length - 1].id) },
        v: () => { const n = nextReview(); if (n) { ui.open({ kind: 'review', id: n.id }); ui.follow() } else useStore.getState().toast('nothing to review') },
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

if (typeof window !== 'undefined' && !PUBLISHED) {
  // the states live in three stores: any change may change what is owned
  useJamCapture.subscribe(syncOwned)
  useJamUi.subscribe(syncOwned)
  useJamQueue.subscribe(syncOwned)
}
