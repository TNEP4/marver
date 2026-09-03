import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useStore, HAS_ALL_SCENES, PUBLISHED, fetchBoardTree, rememberTitles, type TreeBase } from './store.ts'
import { canvasCtl } from './canvas/Canvas.tsx'
import { Tip } from './Tip.tsx'
import { copyToClipboard, type MenuItem, type MenuOpener } from './ContextMenu.tsx'
import { ArrowLineUpIcon, CardsIcon, CardsThreeIcon, FolderIcon, FolderMinusIcon, FolderOpenIcon, FolderPlusIcon, PencilSimpleIcon, SignpostIcon } from './icons.tsx'
import {
  applyDrop, boardsIn, createFolder, deleteFolder, folderIn, folderOf, foldersIn, humanize, isOwnSlot, labelOf, moveBoard, newFolderSlot, readTitle, resolveDrop, retitleFolder, rootIndex, slugFor,
  type Drag, type Drop, type Folder, type Row, type TreeItem,
} from '../../shared/board-tree.ts'

/**
 * Boards live at the top of the sidebar - always visible, one click to switch - in ONE level
 * of folders. The tree (shared/board-tree.ts) comes from the board files' `order`/`folder`
 * fields plus the `_folders.json` registry; every mutation here (drag, new/rename/delete
 * folder, move) is one optimistic tree write through `arrangeBoards`, replayed once on a
 * 409 (someone else wrote first). The list refreshes on mount, window focus, a slow poll and
 * every `sh:boards` broadcast, so agent-written boards and folders appear without a reload.
 * Active board = accent icon + wash, same language as scenes.
 */

const CLOSED_KEY = 'mv-folders-closed'   // collapsed folders are a viewer preference, never data
const readClosed = (): Record<string, true> => { try { return JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '{}') } catch { return {} } }

/** The inline input: renaming a board or a folder, or naming a NEW folder that does not exist
 *  yet - drawn at root `index`, optionally with `board` already inside it. */
type Naming = { kind: 'board' | 'folder'; name: string } | { kind: 'new'; index: number; board?: string }
/** A mutation as intent: applied to whichever tree is current, so a 409 can replay it. */
type Intent = (tree: TreeItem[]) => TreeItem[] | null

export function BoardList({ onMenu }: { onMenu: MenuOpener }) {
  const board = useStore((s) => s.board)
  const titles = useStore((s) => s.boardTitles)                       // board slug → title, off the last tree read
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
      const folderLabels = tree.filter((it): it is Folder => it.kind === 'folder' && (n.kind !== 'folder' || it.name !== n.name)).map((it) => labelOf(it.name, it.title))
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
      const { index, board: withBoard } = n
      const slug = slugFor(title, foldersIn(tree))                                // "Old stuff" → old-stuff (-2 past a namesake); "🚀" alone → folder
      setNaming(null)
      setOpen(slug, true)                                                       // a new folder opens, whatever an old namesake left behind
      if (!mutate((t) => createFolder(t, slug, index, withBoard, stored(slug) || undefined))) useStore.getState().toast('that board is gone - nothing changed')
    } finally { commitBusy.current = false }
  }

  // ---- drag and drop: one pointer gesture for board rows and folder rows ----
  /** The rows as rendered, measured - what the pure resolver reads the pointer against. */
  const rootRef = useRef<HTMLDivElement>(null)
  const measure = (): Row[] => Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-board-row],[data-folder-row]') ?? []).map((el) => {
    const r = el.getBoundingClientRect()
    const folder = el.hasAttribute('data-folder-row')
    return { kind: folder ? 'folder' : 'board', name: el.dataset.folderRow ?? el.dataset.board ?? '', parent: folder ? null : (el.dataset.folder ?? null), open: el.dataset.open === '1', top: r.top, bottom: r.bottom, left: r.left }
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
  const newFolderAt = (index: number, withBoard?: string) => setNaming({ kind: 'new', index, board: withBoard })
  const boardMenu = (n: string, parent: string | null): MenuItem[] => {
    const items: MenuItem[] = [{ label: 'Copy path', icon: <SignpostIcon size={15} />, onClick: () => copyToClipboard(`board: ${n}`, 'path copied') }]
    if (PUBLISHED || n === 'all-scenes') return items
    items.push({ label: 'Rename', icon: <PencilSimpleIcon size={15} />, onClick: () => setNaming({ kind: 'board', name: n }) })
    // the new folder takes the board's own slot (or the slot after its current folder)
    items.push({ label: 'Move to new folder', icon: <FolderPlusIcon size={15} />, onClick: () => newFolderAt(newFolderSlot(treeRef.current, n), n) })
    // moving into an EXISTING folder is a drag, not a menu - the list stays short
    if (parent) items.push({ label: 'Move to top level', icon: <ArrowLineUpIcon size={15} />, onClick: () => mutate((t) => { const p = folderOf(t, n); return moveBoard(t, n, null, p ? rootIndex(t, 'folder', p) + 1 : undefined) }) })
    return items
  }
  const folderMenu = (f: string, boards: string[]): MenuItem[] => {
    const items: MenuItem[] = [{ label: 'Copy path', icon: <SignpostIcon size={15} />, onClick: () => copyToClipboard(`folder: ${f}  (boards: ${boards.join(', ') || 'none'})`, 'path copied') }]
    if (PUBLISHED) return items
    items.push({ label: 'Rename', icon: <PencilSimpleIcon size={15} />, onClick: () => setNaming({ kind: 'folder', name: f }) })
    // folders organise, never own: deleting one puts its boards back at the top level, in order
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
  // ONE seam per gap, from the insertion index: drop-before the row AT that index, or drop-after
  // the last row of a folder's list. Overlay (::after), so no layout shift. Never on the row
  // being dragged. The root end slot draws before the pinned all-scenes row, never after a
  // folder header (that seam would read as "inside").
  const seam = (list: string | null, index: number, last: boolean): string => {
    if (!drag || !drop || 'into' in drop || drop.list !== list) return ''
    return drop.index === index ? ' drop-before' : last && drop.index === index + 1 ? ' drop-after' : ''
  }
  const boardRow = (n: string, parent: string | null, index: number, last: boolean) => {
    const dragging = drag?.kind === 'board' && drag.name === n
    const dropCls = dragging ? '' : n === 'all-scenes' ? (drop && !('into' in drop) && drop.list === null && drop.index === tree.length ? ' drop-before' : '') : seam(parent, index, last)
    // the row being renamed is still a row: measured by a drag (its slot exists) and it draws its seam
    if (naming?.kind === 'board' && naming.name === n) return (
      <div key={n} data-board-row data-board={n} data-folder={parent ?? undefined} className={`it board editing${parent ? ' in-folder' : ''}${dropCls}`}><CardsIcon size={14} />{input(label(n))}</div>
    )
    const canDrag = !PUBLISHED && n !== 'all-scenes'
    const item: Drag = { kind: 'board', name: n }
    return (
      <button key={`${parent ?? ''}/${n}`} data-board-row data-board={n} data-folder={parent ?? undefined} data-reorderable={canDrag || undefined}
        className={`it board${parent ? ' in-folder' : ''}${n === board ? ' cur' : ''}${dragging ? ' dragging' : ''}${dropCls}`}
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
        {n === 'all-scenes' ? <CardsThreeIcon size={14} /> : <CardsIcon size={14} />}
        <span>{label(n)}</span>
      </button>
    )
  }
  const folderRow = (it: Folder, boards: string[], index: number): ReactNode[] => {
    const f = it.name
    const open = !closed[f]
    const rows: ReactNode[] = []
    if (naming?.kind === 'folder' && naming.name === f) {
      rows.push(<div key={`f:${f}`} data-folder-row={f} data-open={open ? '1' : '0'} className={`it folder editing${seam(null, index, false)}`}>{open ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />}{input(labelOf(f, it.title))}</div>)
    } else {
      const item: Drag = { kind: 'folder', name: f }
      const dragging = drag?.kind === 'folder' && drag.name === f
      const into = !!drag && !!drop && 'into' in drop && drop.into === f
      // a slot inside an open EMPTY folder has no board row to draw on: the indented seam sits under the header
      const inSeam = !!drag && !!drop && !('into' in drop) && drop.list === f && open && boards.length === 0
      rows.push(
        <button key={`f:${f}`} data-folder-row={f} data-open={open ? '1' : '0'} data-reorderable={!PUBLISHED || undefined}
          className={`it folder${boards.includes(board) ? ' held' : ''}${dragging ? ' dragging' : ''}${into ? ' drop-into' : ''}${inSeam ? ' drop-in' : ''}${dragging ? '' : seam(null, index, false)}`}
          onClick={(e) => { if (PUBLISHED || e.detail === 0) setOpen(f, !open) }}
          onContextMenu={(e) => onMenu(e, folderMenu(f, boards))}
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
    if (open) boards.forEach((b, i) => rows.push(boardRow(b, f, i, i === boards.length - 1)))
    return rows
  }

  // a new folder being named is drawn at its future slot, its board (if any) already inside;
  // that board leaves its usual row for the duration
  const draft = naming?.kind === 'new' ? (naming.board && !boardsIn(tree).includes(naming.board) ? { ...naming, board: undefined } : naming) : null   // a board deleted mid-naming leaves the draft
  const rows: ReactNode[] = []
  const draftRows = draft ? [
    <div key="f:new" className="it folder editing"><FolderOpenIcon size={14} />{input('', 'Folder name')}</div>,
    ...(draft.board ? [<div key="new/board" className={`it board in-folder draft${draft.board === board ? ' cur' : ''}`}><CardsIcon size={14} /><span>{label(draft.board)}</span></div>] : []),
  ] : []
  tree.forEach((it, i) => {
    if (draft && draft.index === i) rows.push(...draftRows)
    if (it.kind === 'board') { if (draft?.board !== it.name) rows.push(boardRow(it.name, null, i, false)) }
    else rows.push(...folderRow(it, draft?.board ? it.boards.filter((b) => b !== draft.board) : it.boards, i))
  })
  if (draft && draft.index >= tree.length) rows.push(...draftRows)
  if (HAS_ALL_SCENES) rows.push(boardRow('all-scenes', null, -1, false))   // a published bundle without it shows none
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
