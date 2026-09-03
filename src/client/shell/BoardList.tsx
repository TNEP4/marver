import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useStore, PUBLISHED, boardLabel, fetchBoardTree, type TreeBase } from './store.ts'
import { canvasCtl } from './canvas/Canvas.tsx'
import { Tip } from './Tip.tsx'
import { copyToClipboard, type MenuItem, type MenuOpener } from './ContextMenu.tsx'
import { ArrowLineUpIcon, CardsIcon, CardsThreeIcon, FolderIcon, FolderMinusIcon, FolderOpenIcon, FolderPlusIcon, PencilSimpleIcon, SignpostIcon } from './icons.tsx'
import {
  applyDrop, boardsIn, createFolder, deleteFolder, folderOf, foldersIn, isBoardName, isOwnSlot, moveBoard, newFolderSlot, renameFolder, resolveDrop, rootIndex, slugify,
  type Drag, type Drop, type TreeItem,
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
const INDENT = 28                        // px a board row indents inside a folder; left of it is the root gutter

/** The inline input: renaming a board or a folder, or naming a NEW folder that does not exist
 *  yet - drawn at root `index`, optionally with `board` already inside it. */
type Naming = { kind: 'board' | 'folder'; name: string } | { kind: 'new'; index: number; board?: string }
/** A mutation as intent: applied to whichever tree is current, so a 409 can replay it. */
type Intent = (tree: TreeItem[]) => TreeItem[] | null

export function BoardList({ onMenu }: { onMenu: MenuOpener }) {
  const board = useStore((s) => s.board)
  const [tree, setTree] = useState<TreeItem[]>([])
  const [naming, setNaming] = useState<Naming | null>(null)
  const [closed, setClosed] = useState<Record<string, true>>(readClosed)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  // genRef invalidates every async setTree: a mutation bumps it, so a poll/fetch that
  // STARTED earlier can never clobber a fresh optimistic tree or a just-renamed list.
  const genRef = useRef(0)
  const busyRef = useRef(0)                                            // writes in flight; while >0 polls hold off
  const pendingRef = useRef(false)                                     // a refresh asked for while busy - runs when the chain drains
  const commitBusy = useRef(false)                                    // guards Enter+blur firing two commits
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())         // serializes tree POSTs
  const baseRef = useRef<TreeBase>({ boards: {}, folders: null })     // the hashes the current tree was read from
  const lastErr = useRef('')                                          // a malformed registry toasts once per message
  // drag runs on pointer events, NOT native drag-and-drop: native DnD hands the cursor to
  // the OS (arrow/move), so a grabbing hand can't persist. Owning the gesture lets us hold
  // the grabbing cursor for the whole drag via a body class.
  const gestureRef = useRef<{ pointerId: number; startX: number; startY: number; item: Drag; dragging: boolean; el: HTMLElement } | null>(null)
  const treeRef = useRef(tree)
  treeRef.current = tree

  const load = async (): Promise<TreeItem[] | null> => {
    const gen = genRef.current
    try {
      const snap = await fetchBoardTree()
      if (gen !== genRef.current) return null
      baseRef.current = snap.base
      setTree(snap.tree)
      treeRef.current = snap.tree
      lastErr.current = ''
      return snap.tree
    } catch (e) {
      // a malformed registry is the one error worth saying out loud (once); transport
      // failures keep the last known tree quietly
      const msg = e instanceof Error ? e.message : ''
      if (/_folders\.json/.test(msg) && msg !== lastErr.current) { lastErr.current = msg; useStore.getState().toast(msg) }
      return null
    }
  }
  const refresh = () => {
    if (busyRef.current > 0) { pendingRef.current = true; return }   // a write is mid-flight; re-read once it settles
    void load()
  }
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

  /** The one write path: apply the intent to the current tree, show it now, persist it. A 409
   *  (a concurrent agent or tab wrote first) re-reads the tree and replays the intent once;
   *  any other failure rolls back and says so. */
  const mutate = (intent: Intent) => {
    const prev = treeRef.current
    const next = intent(prev)
    if (!next) return
    genRef.current++
    const gen = genRef.current
    busyRef.current++                                             // hold polls off until this settles
    setTree(next)
    treeRef.current = next
    chainRef.current = chainRef.current.then(async () => {
      const fail = (msg: string) => { setTree(prev); treeRef.current = prev; useStore.getState().toast(msg) }
      try {
        let r = await useStore.getState().arrangeBoards(next, baseRef.current)
        if (gen !== genRef.current) return                        // a newer write superseded this one
        if (!r.ok && r.stale) {
          // someone else moved first: re-read, replay the same intent on what is there now
          const fresh = await load()
          if (gen !== genRef.current) return
          const again = fresh && intent(fresh)
          if (!again) { useStore.getState().toast('boards changed - try again'); return }
          setTree(again); treeRef.current = again
          r = await useStore.getState().arrangeBoards(again, baseRef.current)
          if (gen !== genRef.current) return
          if (!r.ok) { await load(); useStore.getState().toast(r.error ?? 'boards changed - try again'); return }
        } else if (!r.ok) { fail(r.error ?? 'could not save order'); return }
        // the write moved the hashes on - re-read so the next write's base is true
        await load()
      } catch { if (gen === genRef.current) fail('could not save order') }
      finally {
        busyRef.current--
        if (busyRef.current === 0 && pendingRef.current) { pendingRef.current = false; refresh() }
      }
    })
  }

  // ---- inline naming (rename a board, rename a folder, name a new folder) ----
  const commit = async (raw: string) => {
    const n = naming
    if (!n || commitBusy.current) return                      // Enter already fired this; ignore the follow-up blur
    commitBusy.current = true
    try {
      if (n.kind === 'board') {
        const next = raw.trim()
        if (!next || next === n.name) { setNaming(null); return }
        if (!isBoardName(next) || next === 'all-scenes' || boardsIn(tree).includes(next)) {
          useStore.getState().toast('use a free name - lowercase letters, numbers and dashes'); return   // stay editing
        }
        const r = await useStore.getState().renameBoard(n.name, next)
        if (r.ok) { setNaming(null); genRef.current++; refresh() }
        else useStore.getState().toast(r.error ?? 'rename failed')                                      // stay editing
        return
      }
      // folders: what the human types becomes a slug ("Old stuff" -> old-stuff, shown "Old Stuff");
      // an empty entry means never mind
      if (!raw.trim() || (n.kind === 'folder' && slugify(raw) === n.name)) { setNaming(null); return }
      const slug = slugify(raw)
      if (!slug) { useStore.getState().toast('use letters, numbers and dashes'); return }
      if (foldersIn(tree).includes(slug)) { useStore.getState().toast(`a folder named "${slug}" already exists`); return }
      setNaming(null)
      if (n.kind === 'folder') {
        if (closed[n.name]) { setOpen(n.name, true); setOpen(slug, false) }    // the collapsed flag follows the name
        mutate((t) => renameFolder(t, n.name, slug))
      } else if (n.kind === 'new') {
        mutate((t) => createFolder(t, slug, n.index, n.board))
      }
    } finally { commitBusy.current = false }
  }

  // ---- drag and drop: one pointer gesture for board rows and folder rows ----
  /** The drop target under the pointer for the item being dragged, or null. The DOM hit becomes
   *  plain facts (which row, which half, the top edge, the root gutter) for the pure resolver. */
  const dropAt = (x: number, y: number, d: Drag): Drop | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-board-row],[data-folder-row]') as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    const hit = {
      kind: (el.hasAttribute('data-folder-row') ? 'folder' : 'board') as Drag['kind'],
      name: el.dataset.folderRow ?? el.dataset.board ?? '',
      parent: el.hasAttribute('data-folder-row') ? null : (el.dataset.folder ?? null),
      below: y > r.top + r.height / 2,
      topEdge: y < r.top + r.height * 0.3,
      gutter: x < r.left + INDENT,
    }
    const target = resolveDrop(treeRef.current, d, hit)
    return target && !isOwnSlot(treeRef.current, d, target) ? target : null
  }
  const resetPointer = () => {
    const g = gestureRef.current
    gestureRef.current = null
    if (g) { try { g.el.releasePointerCapture(g.pointerId) } catch { /* already released */ } }
    document.body.classList.remove('sh-board-dragging')
    setDrag(null)
    setDrop(null)
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, item: Drag) => {
    if (e.button !== 0) return                                    // left button only; right-click opens the menu
    const el = e.currentTarget
    try { el.setPointerCapture(e.pointerId) } catch { /* capture can fail on rapid input */ }
    gestureRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, item, dragging: false, el }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const g = gestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    if (!g.dragging) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 5) return   // click vs drag threshold
      g.dragging = true
      setDrag(g.item)
      document.body.classList.add('sh-board-dragging')            // holds the grabbing cursor for the whole drag
    }
    setDrop(dropAt(e.clientX, e.clientY, g.item))
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>, item: Drag) => {
    const g = gestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    const dragged = g.dragging
    const target = dragged ? dropAt(e.clientX, e.clientY, g.item) : null
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
    for (const f of foldersIn(tree)) if (f !== parent) items.push({ label: `Move to ${boardLabel(f)}`, icon: <FolderIcon size={15} />, onClick: () => { setOpen(f, true); mutate((t) => moveBoard(t, n, f)) } })
    if (parent) items.push({ label: 'Move to top level', icon: <ArrowLineUpIcon size={15} />, onClick: () => mutate((t) => { const p = folderOf(t, n); return moveBoard(t, n, null, p ? rootIndex(t, 'folder', p) + 1 : undefined) }) })
    return items
  }
  const folderMenu = (f: string, boards: string[]): MenuItem[] => {
    const items: MenuItem[] = [{ label: 'Copy path', icon: <SignpostIcon size={15} />, onClick: () => copyToClipboard(`folder: ${f}  (boards: ${boards.join(', ') || 'none'})`, 'path copied') }]
    if (PUBLISHED) return items
    items.push({ label: 'Rename', icon: <PencilSimpleIcon size={15} />, onClick: () => setNaming({ kind: 'folder', name: f }) })
    // folders organise, never own: deleting one puts its boards back at the top level, in order
    items.push({ label: 'Delete folder', icon: <FolderMinusIcon size={15} />, onClick: () => mutate((t) => deleteFolder(t, f)) })
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
  const rootRef = useRef<HTMLDivElement>(null)
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
      onBlur={(e) => { if (naming) void commit(e.currentTarget.value) }} />
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
    if (naming?.kind === 'board' && naming.name === n) return (
      <div key={n} className={`it board editing${parent ? ' in-folder' : ''}`}><CardsIcon size={14} />{input(n)}</div>
    )
    const canDrag = !PUBLISHED && n !== 'all-scenes'
    const item: Drag = { kind: 'board', name: n }
    const dragging = drag?.kind === 'board' && drag.name === n
    const dropCls = dragging ? '' : n === 'all-scenes' ? (drop && !('into' in drop) && drop.list === null && drop.index === tree.length ? ' drop-before' : '') : seam(parent, index, last)
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
        onPointerUp={canDrag ? (e) => onPointerUp(e, item) : undefined}
        onPointerCancel={canDrag ? () => resetPointer() : undefined}
        onLostPointerCapture={canDrag ? (e) => { if (gestureRef.current?.pointerId === e.pointerId) resetPointer() } : undefined}>
        {n === 'all-scenes' ? <CardsThreeIcon size={14} /> : <CardsIcon size={14} />}
        <span>{boardLabel(n)}</span>
      </button>
    )
  }
  const folderRow = (f: string, boards: string[], index: number): ReactNode[] => {
    const open = !closed[f]
    const rows: ReactNode[] = []
    if (naming?.kind === 'folder' && naming.name === f) {
      rows.push(<div key={`f:${f}`} className="it folder editing">{open ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />}{input(f)}</div>)
    } else {
      const item: Drag = { kind: 'folder', name: f }
      const dragging = drag?.kind === 'folder' && drag.name === f
      const into = !!drag && !!drop && 'into' in drop && drop.into === f
      rows.push(
        <button key={`f:${f}`} data-folder-row={f} data-reorderable={!PUBLISHED || undefined}
          className={`it folder${boards.includes(board) ? ' held' : ''}${dragging ? ' dragging' : ''}${into ? ' drop-into' : ''}${dragging ? '' : seam(null, index, false)}`}
          onClick={(e) => { if (PUBLISHED || e.detail === 0) setOpen(f, !open) }}
          onContextMenu={(e) => onMenu(e, folderMenu(f, boards))}
          onPointerDown={!PUBLISHED ? (e) => onPointerDown(e, item) : undefined}
          onPointerMove={!PUBLISHED ? onPointerMove : undefined}
          onPointerUp={!PUBLISHED ? (e) => onPointerUp(e, item) : undefined}
          onPointerCancel={!PUBLISHED ? () => resetPointer() : undefined}
          onLostPointerCapture={!PUBLISHED ? (e) => { if (gestureRef.current?.pointerId === e.pointerId) resetPointer() } : undefined}>
          {open ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />}
          <span>{boardLabel(f)}</span>
          <small>{boards.length}</small>
        </button>,
      )
    }
    if (open) boards.forEach((b, i) => rows.push(boardRow(b, f, i, i === boards.length - 1)))
    return rows
  }

  // a new folder being named is drawn at its future slot, its board (if any) already inside;
  // that board leaves its usual row for the duration
  const draft = naming?.kind === 'new' ? naming : null
  const rows: ReactNode[] = []
  const draftRows = draft ? [
    <div key="f:new" className="it folder editing"><FolderOpenIcon size={14} />{input('', 'Folder name')}</div>,
    ...(draft.board ? [<div key="new/board" className="it board in-folder draft"><CardsIcon size={14} /><span>{boardLabel(draft.board)}</span></div>] : []),
  ] : []
  tree.forEach((it, i) => {
    if (draft && draft.index === i) rows.push(...draftRows)
    if (it.kind === 'board') { if (draft?.board !== it.name) rows.push(boardRow(it.name, null, i, false)) }
    else rows.push(...folderRow(it.name, draft?.board ? it.boards.filter((b) => b !== draft.board) : it.boards, i))
  })
  if (draft && draft.index >= tree.length) rows.push(...draftRows)
  rows.push(boardRow('all-scenes', null, -1, false))
  return (
    <div className="sh-boards" ref={rootRef} onContextMenu={(e: ReactMouseEvent) => blankMenu(e)}>
      <div className="hd">
        <span>Boards</span>
        {/* the quiet way in: a folder-plus on the header (the right-click menu is the other) */}
        {!PUBLISHED && (
          <Tip side="bottom" label="New folder">
            <button className="sh-hd-add" aria-label="New folder" onClick={() => newFolderAt(treeRef.current.length)}><FolderPlusIcon size={14} /></button>
          </Tip>
        )}
      </div>
      {rows}
    </div>
  )
}
