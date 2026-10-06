import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useStore, HAS_ALL_SCENES, PUBLISHED, STATUS_AS_OF, fetchBoardTree, rememberMeta, rememberTitles, type BoardMeta, type TreeBase } from './store.ts'
import { StatusIcon, TypeIcon } from './board-icons.tsx'
import { StatusPicker } from './StatusPicker.tsx'
import type { StatusWord } from '../../shared/board-types.ts'
import { PHASE_LABEL, STATUS_LABEL } from '../../shared/status.ts'
import { canvasCtl } from './canvas/Canvas.tsx'
import { Tip } from './Tip.tsx'
import { copyToClipboard, type MenuItem, type MenuOpener } from './ContextMenu.tsx'
import { ArrowLineUpIcon, CardsIcon, CardsThreeIcon, FolderIcon, FolderMinusIcon, FolderOpenIcon, FolderPlusIcon, PencilSimpleIcon, SignpostIcon } from './icons.tsx'
import {
  applyDrop, boardsIn, createFolder, deleteFolder, depthOf, folderEntries, folderIn, folderOf, foldersIn, holdsFolders, humanize, INDENT, isOwnSlot, labelOf, listIn, moveBoard, moveFolderToRoot, newFolderSlot, parentOf, readTitle,
  resolveDrop, retitleFolder, rootIndex, slugFor,
  type Drag, type Drop, type Folder, type Row, type TreeItem,
} from '../../shared/board-tree.ts'

/**
 * Boards live at the top of the sidebar - always visible, one click to switch - in up to TWO
 * levels of folders (a folder holds boards and folders; a sub-folder holds boards). The tree (shared/board-tree.ts) comes from the board files' `order`/`folder`
 * fields plus the `_folders.json` registry; every mutation here (drag, new/rename/delete
 * folder, move) is one optimistic tree write through `arrangeBoards`, replayed once on a
 * 409 (someone else wrote first). The list refreshes on mount, window focus, a slow poll and
 * every `sh:boards` broadcast, so agent-written boards and folders appear without a reload.
 * Active board = accent icon + wash, same language as scenes.
 */

const CLOSED_KEY = 'mv-folders-closed'   // collapsed folders are a viewer preference, never data
const readClosed = (): Record<string, true> => { try { return JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '{}') } catch { return {} } }

/** The inline input: renaming a board or a folder, or naming a NEW folder that does not exist
 *  yet - drawn at `index` in `parent`'s items (null = the root), optionally with `board`
 *  already inside it. */
/** A status's tooltip: what it is, how far along, why, and the evidence that decided it. */
function statusTip(m: BoardMeta): string {
  const st = m.status!
  const head = STATUS_LABEL[st.status] + (st.fill ? ` - ${PHASE_LABEL[st.fill]}` : '')
  const asOf = STATUS_AS_OF ? `as of ${new Date(STATUS_AS_OF).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : null
  return [head, st.reason, ...(st.evidence ?? []), asOf].filter(Boolean).join('\n')
}

type Naming = { kind: 'board' | 'folder'; name: string } | { kind: 'new'; index: number; board?: string; parent: string | null }
/** A mutation as intent: applied to whichever tree is current, so a 409 can replay it. */
type Intent = (tree: TreeItem[]) => TreeItem[] | null

export function BoardList({ onMenu }: { onMenu: MenuOpener }) {
  const board = useStore((s) => s.board)
  const titles = useStore((s) => s.boardTitles)                       // board slug → title, off the last tree read
  const meta = useStore((s) => s.boardMeta)                           // board slug → type and status (spec 20)
  const label = (n: string) => labelOf(n, titles[n])                  // a board's label; a folder's is labelOf(name, item.title)
  const [tree, setTree] = useState<TreeItem[]>([])
  const [naming, setNaming] = useState<Naming | null>(null)
  const [closed, setClosed] = useState<Record<string, true>>(readClosed)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  // What the sidebar shows = the CONFIRMED tree (the last read of the files) with every
  // unconfirmed intent projected on top, in order. A read never loses an optimistic move
  // (the queue re-applies over whatever came back) and a failure never rolls back to another
  // unconfirmed state - only ever to the files. Reads are latest-wins by sequence.
  const confirmedRef = useRef<TreeItem[]>([])
  const baseRef = useRef<TreeBase>({ boards: {}, folders: null })     // the hashes the confirmed tree was read from
  const queueRef = useRef<Intent[]>([])                                // applied on screen, not yet written
  const flushing = useRef(false)
  const loadSeq = useRef(0)
  const commitBusy = useRef(false)                                    // guards Enter+blur firing two commits
  const lastErr = useRef('')                                          // a server-side error (malformed registry, symlinked dir) toasts once per message
  // drag runs on pointer events, NOT native drag-and-drop: native DnD hands the cursor to
  // the OS (arrow/move), so a grabbing hand can't persist. Owning the gesture lets us hold
  // the grabbing cursor for the whole drag via a body class.
  const gestureRef = useRef<{ pointerId: number; startX: number; startY: number; item: Drag; dragging: boolean; el: HTMLElement; x: number; y: number } | null>(null)
  const treeRef = useRef(tree)
  treeRef.current = tree
  const namingRef = useRef(naming)                                   // commit reads the LIVE naming state, never a stale closure (Escape, then a late blur)
  namingRef.current = naming

  /** The confirmed tree with the queue projected on top - what the human sees. */
  const show = () => {
    let t = confirmedRef.current
    for (const intent of queueRef.current) t = intent(t) ?? t
    treeRef.current = t
    setTree(t)
  }
  const load = async (): Promise<boolean> => {
    const seq = ++loadSeq.current
    try {
      const snap = await fetchBoardTree()
      if (seq !== loadSeq.current) return false                    // an older read landing late never overwrites a newer one
      confirmedRef.current = snap.tree
      baseRef.current = snap.base
      rememberTitles(snap.titles)                                    // the labels follow the same latest-wins rule
      rememberMeta(snap.meta)                                        // ...and so do types and statuses (spec 20)
      lastErr.current = ''
      show()
      return true
    } catch (e) {
      // a server-side error (a malformed registry, a symlinked boards dir) is worth saying
      // out loud, once; transport failures keep the last known tree quietly
      const msg = e instanceof Error ? e.message : ''
      if (/design\/boards/.test(msg) && msg !== lastErr.current) { lastErr.current = msg; useStore.getState().toast(msg) }
      return false
    }
  }
  // an external read (poll, focus, sh:boards) never lands MID-FLUSH: a snapshot taken between
  // a write's commit and its answer would project the same batch twice; it waits for the drain
  const pendingRef = useRef(false)
  const refresh = () => { if (flushing.current) { pendingRef.current = true; return } void load() }
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 8000)
    window.addEventListener('focus', refresh)
    // an agent (or another tab) adding, writing or deleting a board file or the registry
    // broadcasts sh:boards (coalesced server-side): a `folder` edit shows in ~300 ms, not 8 s
    import.meta.hot?.on('sh:boards', refresh)
    return () => { clearInterval(t); window.removeEventListener('focus', refresh); import.meta.hot?.off('sh:boards', refresh) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setOpen = (folder: string, open: boolean) => {
    setClosed((c) => {
      const next = { ...c }
      if (open) delete next[folder]; else next[folder] = true
      try { localStorage.setItem(CLOSED_KEY, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }
  const pick = async (name: string) => {
    if (name === useStore.getState().board) return
    await useStore.getState().switchBoard(name)
    setTimeout(() => canvasCtl.fitAll(), 60)
  }

  /** The one write path: queue the intent, show it at once, persist. The flush takes EVERY
   *  queued intent as one batch over the confirmed tree and writes the result; a 409 (a
   *  concurrent agent or tab wrote first) re-reads the files and replays the whole batch on
   *  what is there now, once. A terminal failure drops the batch, says so, and re-reads -
   *  the screen returns to the files, never to another unconfirmed state. Returns false when
   *  the intent cannot apply to what is shown (nothing queued). */
  const mutate = (intent: Intent): boolean => {
    if (!intent(treeRef.current)) return false
    queueRef.current.push(intent)
    show()
    void flush()
    return true
  }
  const flush = async () => {
    if (flushing.current) return
    flushing.current = true
    try {
      while (queueRef.current.length) {
        const batch = [...queueRef.current]
        // an intent the fresh tree no longer admits (its board or folder vanished) is dropped
        // and said out loud, never silently counted as done
        const reduce = (t: TreeItem[]) => {
          let dropped = 0
          const tree = batch.reduce<TreeItem[]>((acc, i) => { const n = i(acc); if (!n) dropped++; return n ?? acc }, t)
          if (dropped) useStore.getState().toast(dropped === batch.length ? 'that move no longer applies' : 'some moves no longer apply')
          return tree
        }
        const done = () => { queueRef.current.splice(0, batch.length); show() }   // written, or given up on - off the screen's projection either way
        try {
          let r = await useStore.getState().arrangeBoards(reduce(confirmedRef.current), baseRef.current)
          if (!r.ok && r.stale) {
            if (!(await load())) { done(); useStore.getState().toast('boards changed - try again'); break }
            r = await useStore.getState().arrangeBoards(reduce(confirmedRef.current), baseRef.current)
          }
          done()
          if (!r.ok) { useStore.getState().toast(r.error ?? 'could not save order'); await load(); break }
          await load()                                          // the write moved the hashes on; the next batch needs the true base
        } catch { done(); useStore.getState().toast('could not save order'); await load(); break }
      }
    } finally {
      flushing.current = false
      if (queueRef.current.length) void flush()
      else if (pendingRef.current) { pendingRef.current = false; void load() }
    }
  }

  // ---- inline naming (retitle a board, retitle a folder, name a new folder) ----
  // What the human types is the TITLE - any casing, punctuation, emoji - what the row shows.
  // The slug (the board's file name, the folder's key on its boards and in the registry) is
  // the object's identity: agents, publish.json, URLs and comment threads hold it, so a rename
  // never moves it. A new folder mints its slug from the title once. Typing exactly what the
  // slug reads as anyway ("Research" for `research`) clears the title - the file stays clean.
  // An empty entry, or the label unchanged, means never mind.
  const commit = async (raw: string) => {
    const n = namingRef.current
    if (!n || commitBusy.current) return                      // Enter already fired this (or Escape cancelled); ignore the follow-up blur
    commitBusy.current = true
    try {
      const title = readTitle(raw)
      if (!title) { setNaming(null); return }
      // two rows reading alike would be a trap: a name another board (folder) already shows stays editing
      const taken = (kind: 'board' | 'folder') => useStore.getState().toast(`a ${kind} called "${title}" already exists`)
      const stored = (slug: string) => (title === humanize(slug) ? '' : title)
      if (n.kind === 'board') {
        if (title === label(n.name)) { setNaming(null); return }
        if (boardsIn(tree).some((b) => b !== n.name && label(b) === title) || (HAS_ALL_SCENES && label('all-scenes') === title)) { taken('board'); return }
        let r = await useStore.getState().renameBoard(n.name, stored(n.name), baseRef.current.boards[n.name])
        if (!r.ok && r.stale && await load()) r = await useStore.getState().renameBoard(n.name, stored(n.name), baseRef.current.boards[n.name])   // the file moved on (a drag just before, an agent): re-read, once more
        if (!r.ok) { useStore.getState().toast(r.error ?? 'rename failed'); return }   // stay editing
        setNaming(null)
        refresh()
        return
      }
      const folderLabels = folderEntries(tree).map((e) => e.folder).filter((f) => n.kind !== 'folder' || f.name !== n.name).map((f) => labelOf(f.name, f.title))
      if (n.kind === 'folder') {
        const current = folderIn(tree, n.name)
        if (!current || title === labelOf(n.name, current.title)) { setNaming(null); return }
        if (folderLabels.includes(title)) { taken('folder'); return }
        setNaming(null)
        mutate((t) => retitleFolder(t, n.name, stored(n.name)))
        return
      }
      if (n.kind !== 'new') return
      if (folderLabels.includes(title)) { taken('folder'); return }
      const { index, board: withBoard, parent } = n
      const slug = slugFor(title, foldersIn(tree))                                // "Old stuff" → old-stuff (-2 past a namesake); "🚀" alone → folder
      setNaming(null)
      setOpen(slug, true)                                                       // a new folder opens, whatever an old namesake left behind
      if (!mutate((t) => createFolder(t, slug, index, withBoard, stored(slug) || undefined, parent))) useStore.getState().toast(withBoard ? 'that board is gone - nothing changed' : 'that folder is gone - nothing changed')
    } finally { commitBusy.current = false }
  }

  // ---- drag and drop: one pointer gesture for board rows and folder rows ----
  /** The rows as rendered, measured - what the pure resolver reads the pointer against. */
  const rootRef = useRef<HTMLDivElement>(null)
  const measure = (): Row[] => Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-board-row],[data-folder-row]') ?? []).map((el) => {
    const r = el.getBoundingClientRect()
    const folder = el.hasAttribute('data-folder-row')
    return {
      kind: folder ? 'folder' : 'board', name: el.dataset.folderRow ?? el.dataset.board ?? '', parent: (folder ? el.dataset.parent : el.dataset.folder) ?? null,
      depth: Number(el.dataset.depth ?? 0), open: el.dataset.open === '1', top: r.top, bottom: r.bottom, left: r.left,
    }
  })
  /** The drop target for the pointer at (x, y), or null: outside the panel (a release there
   *  cancels), or a slot that would change nothing. Inside the panel there is always one - the
   *  ends clamp - so the seam on screen is exactly where a release lands. */
  const dropAt = (x: number, y: number, d: Drag): Drop | null => {
    const panel = rootRef.current?.closest('.sh-panel')?.getBoundingClientRect()
    if (!panel || x < panel.left || x >= panel.right || y < panel.top || y >= panel.bottom) return null
    const target = resolveDrop(treeRef.current, d, measure(), x, y)
    return target && !isOwnSlot(treeRef.current, d, target) ? target : null
  }
  const dropRef = useRef<Drop | null>(null)                          // the target on screen; the release applies THIS, never a recomputation
  const showDrop = (t: Drop | null) => { dropRef.current = t; setDrop(t) }
  const resetPointer = () => {
    const g = gestureRef.current
    gestureRef.current = null
    if (g) { try { g.el.releasePointerCapture(g.pointerId) } catch { /* already released */ } }
    document.body.classList.remove('sh-board-dragging')
    setDrag(null)
    showDrop(null)
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, item: Drag) => {
    if (e.button !== 0) return                                    // left button only; right-click opens the menu
    const el = e.currentTarget
    try { el.setPointerCapture(e.pointerId) } catch { /* capture can fail on rapid input */ }
    gestureRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, item, dragging: false, el, x: e.clientX, y: e.clientY }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const g = gestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    g.x = e.clientX; g.y = e.clientY
    if (!g.dragging) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 5) return   // click vs drag threshold
      g.dragging = true
      setDrag(g.item)
      document.body.classList.add('sh-board-dragging')            // holds the grabbing cursor for the whole drag
    }
    showDrop(dropAt(e.clientX, e.clientY, g.item))
  }
  // the tree changed under a drag in progress (a poll, an agent's write): the seam is re-read
  // against the rows as they are NOW, from where the pointer is - never a slot that no longer means it
  useEffect(() => {
    const g = gestureRef.current
    if (g?.dragging) showDrop(dropAt(g.x, g.y, g.item))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree])
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const g = gestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    // the item is the one the gesture STARTED on - never the row that happens to receive the
    // up (capture can be lost, a refresh can re-key the dragged row); the target is the seam
    // the human saw
    const item = g.item
    const dragged = g.dragging
    // a release outside the panel cancels, even after a seam showed (the pointer can leave
    // between the last move and the up); inside, the seam is the contract
    const panel = rootRef.current?.closest('.sh-panel')?.getBoundingClientRect()
    const inside = !!panel && e.clientX >= panel.left && e.clientX < panel.right && e.clientY >= panel.top && e.clientY < panel.bottom
    const target = dragged && inside ? dropRef.current : null
    resetPointer()
    if (dragged) {
      if (!target) return
      if ('into' in target) setOpen(target.into, true)          // show where it landed
      mutate((t) => applyDrop(t, item, target))
    }
    else if (item.kind === 'board') void pick(item.name)          // a tap switches boards (the trailing mouse click is ignored)
    else setOpen(item.name, !!closed[item.name])                   // a tap on a folder toggles it
  }
  // cancel a drag on Escape (capture phase, so the app's global Escape never sees it) or focus loss
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && gestureRef.current?.dragging) { e.preventDefault(); e.stopPropagation(); resetPointer() } }
    const onBlur = () => { if (gestureRef.current) resetPointer() }
    window.addEventListener('keydown', onEsc, true)
    window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('keydown', onEsc, true); window.removeEventListener('blur', onBlur); resetPointer() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- menus (flat lists, no submenus) ----
  const newFolderAt = (index: number, withBoard?: string, parent: string | null = null) => {
    if (parent) setOpen(parent, true)                                // the new folder is drawn inside its parent: show it
    setNaming({ kind: 'new', index, board: withBoard, parent })
  }
  /** A person's status decision (the picker): written into the board file, its hash checked - a
   *  write that lost a race re-reads and tries once more, like a rename. */
  const setStatus = async (n: string, status: StatusWord | null, reason?: string) => {
    let r = await useStore.getState().setBoardStatus(n, status, reason, baseRef.current.boards[n])
    if (!r.ok && r.stale && await load()) r = await useStore.getState().setBoardStatus(n, status, reason, baseRef.current.boards[n])
    if (!r.ok) { useStore.getState().toast(r.error ?? 'status not saved'); return }
    refresh()                                                        // a clear: what the evidence says now
  }
  const boardMenu = (n: string, parent: string | null): MenuItem[] => {
    const items: MenuItem[] = [{ label: 'Copy path', icon: <SignpostIcon size={15} />, onClick: () => copyToClipboard(`board: ${n}`, 'path copied') }]
    if (PUBLISHED || n === 'all-scenes') return items
    // a feature or project board: its status first, as Linear puts it - the picker opens in place
    const m = useStore.getState().boardMeta[n]
    if (m?.status && m.settable?.length) items.unshift({
      label: 'Change status…', icon: <StatusIcon status={m.status.status} fill={m.status.fill} />,
      panel: (close) => <StatusPicker meta={m} onPick={(s, reason) => { close(); void setStatus(n, s, reason) }} />,
    })
    items.push({ label: 'Rename', icon: <PencilSimpleIcon size={15} />, onClick: () => setNaming({ kind: 'board', name: n }) })
    // the new folder takes the board's own slot at its own level (a sub-folder inside a top-level
    // folder; right after its sub-folder when it sits in one - that level holds no folders)
    items.push({ label: 'Move to new folder', icon: <FolderPlusIcon size={15} />, onClick: () => { const at = newFolderSlot(treeRef.current, n); newFolderAt(at.index, n, at.parent) } })
    // moving into an EXISTING folder is a drag, not a menu - the list stays short
    if (parent) items.push({ label: 'Move to top level', icon: <ArrowLineUpIcon size={15} />, onClick: () => mutate((t) => {
      const p = folderOf(t, n)
      const top = p ? parentOf(t, p) ?? p : null                     // lands right after the top-level folder it was in
      return moveBoard(t, n, null, top ? rootIndex(t, 'folder', top) + 1 : undefined)
    }) })
    return items
  }
  const folderMenu = (f: string, boards: string[], parent: string | null): MenuItem[] => {
    const items: MenuItem[] = [{ label: 'Copy path', icon: <SignpostIcon size={15} />, onClick: () => copyToClipboard(`folder: ${f}${parent ? ` (in ${parent})` : ''}  (boards: ${boards.join(', ') || 'none'})`, 'path copied') }]
    if (PUBLISHED) return items
    items.push({ label: 'Rename', icon: <PencilSimpleIcon size={15} />, onClick: () => setNaming({ kind: 'folder', name: f }) })
    // two levels: a top-level folder can hold folders; a sub-folder can leave its parent
    if (!parent) items.push({ label: 'New folder inside', icon: <FolderPlusIcon size={15} />, onClick: () => newFolderAt(listIn(treeRef.current, f)?.length ?? 0, undefined, f) })
    else items.push({ label: 'Move to top level', icon: <ArrowLineUpIcon size={15} />, onClick: () => mutate((t) => {
      const p = parentOf(t, f)
      return moveFolderToRoot(t, f, p ? rootIndex(t, 'folder', p) + 1 : undefined)
    }) })
    // folders organise, never own: deleting one moves what it holds up one level, into its place, in order
    items.push({ label: 'Delete folder', icon: <FolderMinusIcon size={15} />, onClick: () => { setOpen(f, true); mutate((t) => deleteFolder(t, f)) } })
    return items
  }
  /** Right-click on the sidebar itself (the Boards header, gaps between rows, the blank space
   *  under the lists): New folder, appended at the end. Rows keep their own menus. */
  const blankMenu = (e: { preventDefault(): void; clientX: number; clientY: number; target: EventTarget | null }) => {
    if (PUBLISHED) return
    if ((e.target as HTMLElement).closest('[data-board-row],[data-folder-row],.editing,.sh-hd-add')) return
    onMenuRef.current(e, [{ label: 'New folder', icon: <FolderPlusIcon size={15} />, onClick: () => newFolderAt(treeRef.current.length) }])
  }
  const onMenuRef = useRef(onMenu)
  onMenuRef.current = onMenu
  useEffect(() => {
    const panel = rootRef.current?.closest('.sh-panel')
    const scroll = rootRef.current?.closest('.sh-panel-scroll')
    if (!panel || !scroll) return
    const h = (e: Event) => { if (e.target === scroll || e.target === panel) blankMenu(e as MouseEvent) }   // only the panel's own blank space
    panel.addEventListener('contextmenu', h)
    return () => panel.removeEventListener('contextmenu', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // a draft new folder whose parent vanished or got nested mid-naming is cancelled, said once
  const orphanDraft = naming?.kind === 'new' && !holdsFolders(tree, naming.parent)
  useEffect(() => {
    if (!orphanDraft) return
    setNaming(null)
    useStore.getState().toast('that folder changed - the new folder was not made')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphanDraft])

  // ---- rows ----
  const input = (defaultValue: string, placeholder?: string) => (
    <input autoFocus defaultValue={defaultValue} placeholder={placeholder} spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); void commit(e.currentTarget.value) }
        else if (e.key === 'Escape') { e.preventDefault(); setNaming(null) }
      }}
      onBlur={(e) => { if (namingRef.current) void commit(e.currentTarget.value) }} />
  )
  // a new folder being named is drawn at its future slot, its board (if any) already inside;
  // that board leaves its usual row for the duration. A draft whose parent vanished or can no
  // longer hold folders (an agent deleted or nested it mid-naming) draws nothing and hides
  // nothing - the effect below cancels it, so the board it held shows where it now is
  const draftLive = naming?.kind === 'new' && holdsFolders(tree, naming.parent)
  const draft = naming?.kind === 'new' && draftLive ? (naming.board && !boardsIn(tree).includes(naming.board) ? { ...naming, board: undefined } : naming) : null   // a board deleted mid-naming leaves the draft
  const visible = (items: TreeItem[]) => (draft?.board ? items.filter((k) => !(k.kind === 'board' && k.name === draft.board)) : items)
  const key = (it: TreeItem) => `${it.kind === 'board' ? 'b' : 'f'}:${it.name}`
  /** The last row an item draws: a board's own, a closed or empty folder's header, else its last child's last row. */
  const lastRow = (it: TreeItem): string => {
    if (it.kind === 'board') return key(it)
    const kids = visible(it.items)
    return !closed[it.name] && kids.length ? lastRow(kids[kids.length - 1]!) : key(it)
  }
  // ONE seam per gap, overlaid (::after, no layout shift) on the row the gap touches: before the
  // first row of the item AT the index, or after the last row of a list's last item at its end.
  // Its left edge follows the indent of the list it lands in, so "inside" and "outside" never
  // draw alike. The root end draws before the pinned all-scenes row. An open EMPTY folder has no
  // row to draw on: its header draws the indented seam under itself (drop-in).
  const seam = ((): { row: string; where: 'before' | 'after'; depth: number } | null => {
    if (!drag || !drop || 'into' in drop) return null
    const items = listIn(tree, drop.list)
    if (!items) return null
    const depth = depthOf(tree, drop.list)
    if (drop.index < items.length) return { row: key(items[drop.index]!), where: 'before', depth }
    if (drop.list === null && HAS_ALL_SCENES) return { row: 'b:all-scenes', where: 'before', depth: 0 }
    return items.length ? { row: lastRow(items[items.length - 1]!), where: 'after', depth } : null
  })()
  // a nested seam starts where that list's rows start: the row's own 8px padding plus its indent
  const seamLeft = (depth: number): CSSProperties => ({ ['--seam-left' as string]: `${depth ? 8 + depth * INDENT : 6}px` })
  const seamOf = (row: string): { cls: string; style?: CSSProperties } =>
    seam && seam.row === row ? { cls: ` drop-${seam.where}`, style: seamLeft(seam.depth) } : { cls: '' }
  const indent = (depth: number) => (depth >= 2 ? ' in-folder in-sub' : depth === 1 ? ' in-folder' : '')

  const boardRow = (n: string, parent: string | null, depth: number) => {
    const dragging = drag?.kind === 'board' && drag.name === n
    const s = dragging ? { cls: '' } : seamOf(`b:${n}`)
    // the row being renamed is still a row: measured by a drag (its slot exists) and it draws its seam
    if (naming?.kind === 'board' && naming.name === n) return (
      <div key={`b:${n}`} data-board-row data-board={n} data-folder={parent ?? undefined} data-depth={depth} className={`it board editing${indent(depth)}${s.cls}`} style={s.style}><CardsIcon size={14} />{input(label(n))}</div>
    )
    const canDrag = !PUBLISHED && n !== 'all-scenes'
    const item: Drag = { kind: 'board', name: n }
    return (
      <button key={`b:${n}`} data-board-row data-board={n} data-folder={parent ?? undefined} data-depth={depth} data-reorderable={canDrag || undefined}
        className={`it board${indent(depth)}${n === board ? ' cur' : ''}${dragging ? ' dragging' : ''}${s.cls}`} style={s.style}
        // draggable rows switch on the pointer tap (onPointerUp), so their trailing mouse
        // click (detail >= 1) must be ignored to avoid a double switch; keyboard clicks
        // (detail === 0) and non-draggable rows (all-scenes, published) switch here as normal
        onClick={(e) => { if (!canDrag || e.detail === 0) void pick(n) }}
        onContextMenu={(e) => onMenu(e, boardMenu(n, parent))}
        onPointerDown={canDrag ? (e) => onPointerDown(e, item) : undefined}
        onPointerMove={canDrag ? onPointerMove : undefined}
        onPointerUp={canDrag ? onPointerUp : undefined}
        onPointerCancel={canDrag ? () => resetPointer() : undefined}
        onLostPointerCapture={canDrag ? (e) => { if (gestureRef.current?.pointerId === e.pointerId) resetPointer() } : undefined}>
        {n === 'all-scenes' ? <CardsThreeIcon size={14} /> : meta[n]?.type ? <TypeIcon type={meta[n].type!} /> : <CardsIcon size={14} />}
        <span>{label(n)}</span>
        {meta[n]?.status && <i className="st" data-status={meta[n].status!.status} title={statusTip(meta[n])}><StatusIcon status={meta[n].status!.status} fill={meta[n].status!.fill} /></i>}
      </button>
    )
  }
  const draftRows = (depth: number): ReactNode[] => !draft ? [] : [
    <div key="f:new" className={`it folder editing${indent(depth)}`}><FolderOpenIcon size={14} />{input('', 'Folder name')}</div>,
    ...(draft.board ? [<div key="new/board" className={`it board draft${indent(depth + 1)}${draft.board === board ? ' cur' : ''}`}><CardsIcon size={14} /><span>{label(draft.board)}</span></div>] : []),
  ]
  /** A list's rows - the root's, a folder's, a sub-folder's - with a draft new folder at its slot. */
  const listRows = (items: TreeItem[], parent: string | null, depth: number): ReactNode[] => {
    const out: ReactNode[] = []
    const here = draft && draft.parent === parent ? draft : null
    items.forEach((it, i) => {
      if (here && here.index === i) out.push(...draftRows(depth))
      if (it.kind === 'board') { if (draft?.board !== it.name) out.push(boardRow(it.name, parent, depth)) }
      else out.push(...folderRows(it, parent, depth))
    })
    if (here && here.index >= items.length) out.push(...draftRows(depth))
    return out
  }
  const folderRows = (it: Folder, parent: string | null, depth: number): ReactNode[] => {
    const f = it.name
    const open = !closed[f]
    const kids = visible(it.items)
    const boards = boardsIn(kids)
    const s = seamOf(`f:${f}`)
    const rows: ReactNode[] = []
    if (naming?.kind === 'folder' && naming.name === f) {
      rows.push(<div key={`f:${f}`} data-folder-row={f} data-parent={parent ?? undefined} data-depth={depth} data-open={open ? '1' : '0'} className={`it folder editing${indent(depth)}${s.cls}`} style={s.style}>{open ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />}{input(labelOf(f, it.title))}</div>)
    } else {
      const item: Drag = { kind: 'folder', name: f }
      const dragging = drag?.kind === 'folder' && drag.name === f
      const into = !!drag && !!drop && 'into' in drop && drop.into === f
      const inSeam = !!drag && !!drop && !('into' in drop) && drop.list === f && open && kids.length === 0
      const sc = dragging ? { cls: '' } : inSeam ? { cls: ' drop-in', style: seamLeft(depth + 1) } : s
      rows.push(
        <button key={`f:${f}`} data-folder-row={f} data-parent={parent ?? undefined} data-depth={depth} data-open={open ? '1' : '0'} data-reorderable={!PUBLISHED || undefined}
          className={`it folder${indent(depth)}${boards.includes(board) ? ' held' : ''}${dragging ? ' dragging' : ''}${into ? ' drop-into' : ''}${sc.cls}`} style={sc.style}
          onClick={(e) => { if (PUBLISHED || e.detail === 0) setOpen(f, !open) }}
          onContextMenu={(e) => onMenu(e, folderMenu(f, boards, parent))}
          onPointerDown={!PUBLISHED ? (e) => onPointerDown(e, item) : undefined}
          onPointerMove={!PUBLISHED ? onPointerMove : undefined}
          onPointerUp={!PUBLISHED ? onPointerUp : undefined}
          onPointerCancel={!PUBLISHED ? () => resetPointer() : undefined}
          onLostPointerCapture={!PUBLISHED ? (e) => { if (gestureRef.current?.pointerId === e.pointerId) resetPointer() } : undefined}>
          {open ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />}
          <span>{labelOf(f, it.title)}</span>
          <small>{boards.length}</small>
        </button>,
      )
    }
    if (open) rows.push(...listRows(it.items, f, depth + 1))
    return rows
  }

  const rows: ReactNode[] = listRows(tree, null, 0)
  if (HAS_ALL_SCENES) rows.push(boardRow('all-scenes', null, 0))   // a published bundle without it shows none
  return (
    <div className="sh-boards" ref={rootRef} onContextMenu={(e: ReactMouseEvent) => blankMenu(e)}>
      <div className="hd">
        <span>Boards</span>
        {/* the quiet way in: a folder-plus on the header (the right-click menu is the other) */}
        {!PUBLISHED && (
          <Tip side="bottom" label="New folder">
            <FolderPlusIcon size={17} className="sh-hd-add" role="button" tabIndex={0} aria-label="New folder"
              onClick={() => newFolderAt(treeRef.current.length)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); newFolderAt(treeRef.current.length) } }} />
          </Tip>
        )}
      </div>
      {rows}
    </div>
  )
}
