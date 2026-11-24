/**
 * Search (spec 35): the ⌘K lens - small floating glass over the canvas, the list on the left and the selected
 * result's frame rendered live on the right (Preview.tsx). Kinds by level; every word must match (shared/search.ts);
 * Enter lands the canvas through the show path (never goTo: it can place a frame on the current board).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { buildIndex, fold, search, words, KIND_ORDER, type Hit, type SearchDoc, type SearchIndex, type SearchKind, type SearchResult } from '../../../shared/search.ts'
import { api, scoped } from '../api.ts'
import { UNPLACED } from '../hash.ts'
import { useStore } from '../store.ts'
import { cmd } from '../commands.ts'
import { showTarget } from '../show.ts'
import { ArchiveIcon, CardsIcon, CaretIcon, CheckIcon, CommentIcon, FolderIcon, FrameRectIcon, GridIcon, IntentGlyph, MagnifierIcon, NoteStickyIcon } from '../icons.tsx'
import { TypeIcon } from '../board-icons.tsx'
import { Preview, type PreviewTarget } from './Preview.tsx'

// ---- open / close, from anywhere (⌘K in App.tsx, the magnifier, the Mac app) -------------------------------
export const useSearch = create<{ open: boolean }>(() => ({ open: false }))
let returnFocus: Element | null = null
export function toggleSearch(force?: boolean): void {
  const open = force ?? !useSearch.getState().open
  if (open && !useSearch.getState().open) returnFocus = document.activeElement
  useSearch.setState({ open })
  if (!open && returnFocus instanceof HTMLElement) { try { returnFocus.focus() } catch { /* gone */ } }
}

// ---- the documents: fetched once, at idle after boot, and again on open when the canvas changed --------------
let index: SearchIndex | null = null
let indexVersion = -1
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()
export function loadSearchDocs(): Promise<void> {
  loading ??= api('search').then((r) => (r.ok ? r.json() : null)).then((j: { docs: SearchDoc[]; version: number } | null) => {
    if (j && j.version !== indexVersion) { index = buildIndex(j.docs, j.version); indexVersion = j.version; for (const l of listeners) l() }
  }).catch(() => {}).finally(() => { loading = null })
  return loading
}
if (typeof window !== 'undefined') {
  const idle = (cb: () => void) => ('requestIdleCallback' in window ? (window as unknown as { requestIdleCallback: (f: () => void, o: { timeout: number }) => void }).requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 1500))
  setTimeout(() => idle(() => { void loadSearchDocs() }), 3000)
}

// ---- remembered: the kind filter, and recent destinations (this browser, per canvas) ---------------------------
const KINDS_KEY = scoped('mv-search-kinds'), RECENT_KEY = scoped('mv-search-recent')
const readJson = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } }
const writeJson = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } }
type Filter = { kinds: SearchKind[]; archive: boolean }
const ALL: SearchKind[] = [...KIND_ORDER]
function remember(id: string) {
  const r = readJson<{ id: string; at: number }[]>(RECENT_KEY, []).filter((x) => x.id !== id)
  writeJson(RECENT_KEY, [{ id, at: Date.now() }, ...r].slice(0, 30))
}

const LABEL: Record<SearchKind, string> = { folder: 'Folders', board: 'Boards', scene: 'Scenes', frame: 'Frames', note: 'Notes', comment: 'Comments' }

/** The kind's icon - the sidebar's own glyph. */
export function KindIcon({ doc, size = 18 }: { doc: SearchDoc; size?: number }) {
  if (doc.kind === 'folder') return <FolderIcon size={size} />
  if (doc.kind === 'board') return <CardsIcon size={size} />
  if (doc.kind === 'scene') return <CaretIcon size={size - 4} />
  if (doc.kind === 'note') return <NoteStickyIcon size={size} />
  if (doc.kind === 'comment') return <CommentIcon size={size} />
  return <FrameRectIcon size={size - 1} />
}
const MENU_ICON: Record<SearchKind, ReactNode> = {
  folder: <FolderIcon size={14} />, board: <CardsIcon size={14} />, scene: <CaretIcon size={11} />,
  frame: <FrameRectIcon size={13} />, note: <NoteStickyIcon size={14} />, comment: <CommentIcon size={14} />,
}

/** The board a result is seen on: the current one when the result is on it (a frame shared by two boards stays where
 *  you are), else its own. The preview renders on that same board. */
function boardFor(doc: SearchDoc): string | undefined {
  const here = useStore.getState().board
  return here && doc.boards?.includes(here) && doc.kind !== 'board' ? here : doc.dest.board
}

/** A frame the preview can render for this result, or null (a folder, a board with no frame). */
function previewOf(doc: SearchDoc): PreviewTarget | null {
  if (doc.kind === 'folder') return null
  const id = doc.frame ?? doc.preview
  const frame = id ? useStore.getState().manifest?.frames.find((f) => f.id === id) : undefined
  if (!frame) return null
  return { frame, board: boardFor(doc), title: doc.title, where: doc.where ?? '' }
}

/** Land the canvas on the result (the show path: newest wins, a person's own navigation cancels it). */
function go(doc: SearchDoc): void {
  remember(doc.id)
  const d = doc.dest
  if (d.folder) {
    // the sidebar opens, and the folder's whole chain, so the row is there to see
    if (!useStore.getState().panelOpen) useStore.getState().togglePanel()
    window.dispatchEvent(new CustomEvent('mv:reveal-folder', { detail: [...(doc.folders ?? [d.folder])].reverse() }))
    return
  }
  // a frame on no board lands in Not on a board; a thread pinned to one of two instances selects that one (its node)
  const board = boardFor(doc) ?? (d.unplaced ? UNPLACED : useStore.getState().board)
  if (!board) return
  void showTarget({ board, ...(d.node && board === d.board ? { n: [d.node] } : d.frame ? { f: [d.frame] } : d.scene ? { s: [d.scene] } : {}), ...(d.thread ? { c: d.thread } : {}) }, 'app')
}

/** The title with what was typed marked: fuzzy positions, else every word of the query at the start of a title word. */
function Marked({ hit, q }: { hit: Hit; q: string }) {
  const t = hit.doc.title || hit.doc.key
  const on = new Array<boolean>(t.length).fill(false)
  if (hit.at) for (const i of hit.at) on[i] = true
  else {
    const ws = words(q)
    const ft = fold(t)
    for (let i = 0; i < ft.length; i++) {
      if (i > 0 && /[a-z0-9]/.test(ft[i - 1])) continue
      const w = ws.find((x) => ft.startsWith(x, i))
      if (w) for (let k = 0; k < w.length; k++) on[i + k] = true
    }
  }
  const out: ReactNode[] = []
  for (let i = 0; i < t.length;) { let j = i; while (j < t.length && on[j] === on[i]) j++; out.push(on[i] ? <mark key={i}>{t.slice(i, j)}</mark> : t.slice(i, j)); i = j }
  return <>{out}</>
}

type Row = { type: 'hit'; hit: Hit; group?: string } | { type: 'more'; kind: SearchKind; n: number } | { type: 'archive'; n: number }
const rowId = (r: Row) => (r.type === 'hit' ? r.hit.doc.id : r.type === 'more' ? `more:${r.kind}` : 'archive')
const PER = 6
const narrow = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches

export function Search() {
  const open = useSearch((s) => s.open)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>(() => readJson<Filter>(KINDS_KEY, { kinds: ALL, archive: false }))
  const [menu, setMenu] = useState(false)
  const [sel, setSel] = useState(0)
  const [expanded, setExpanded] = useState<SearchKind[]>([])
  const [, bump] = useState(0)
  const frozen = useRef(false)   // after an arrow, results never reorder above the selection
  const input = useRef<HTMLInputElement>(null)
  const lens = useRef<HTMLDivElement>(null)
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [resting, setResting] = useState(true)   // false while an arrow is held (key repeat): the preview waits
  const [small, setSmall] = useState(narrow)

  useEffect(() => { const l = () => bump((n) => n + 1); listeners.add(l); return () => { listeners.delete(l) } }, [])
  useEffect(() => { const m = window.matchMedia('(max-width: 1100px)'); const on = () => setSmall(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on) }, [])
  // the field takes the keys in the same task as ⌘K - never a frame later, or the first letters typed fast land on the
  // canvas (a backgrounded or busy window runs animation frames late); the last query, selected: typing replaces it
  useLayoutEffect(() => {
    if (!open) return
    input.current?.focus(); input.current?.select()
  }, [open])
  useEffect(() => {
    if (!open) return
    void loadSearchDocs()
    setSel(0); frozen.current = false; setMenu(false); setExpanded([])
  }, [open])
  // remembered only once chosen (nothing written for a canvas whose search was never used)
  const firstFilter = useRef(true)
  useEffect(() => { if (firstFilter.current) { firstFilter.current = false; return } writeJson(KINDS_KEY, filter); if (useSearch.getState().open) input.current?.focus() }, [filter])

  const board = useStore((s) => s.board)
  const result: SearchResult | null = useMemo(() => {
    if (!index || !q.trim()) return null
    const recent = new Map(readJson<{ id: string; at: number }[]>(RECENT_KEY, []).map((r) => [r.id, Math.exp(-(Date.now() - r.at) / (30 * 864e5))]))
    return search(index, q, { kinds: filter.kinds.length === ALL.length ? undefined : filter.kinds, archive: filter.archive, board, recency: recent, perGroup: 50 })
  }, [q, filter, board, indexVersion])   // eslint-disable-line react-hooks/exhaustive-deps

  // the rows, in order: the best result first (the engine's, whatever its kind), then the groups by level - six each
  // with "+N more" to open the rest - then partial matches, then the archive fold
  const rows: Row[] = useMemo(() => {
    if (!index) return []
    if (!q.trim()) {
      const byId = new Map(index.docs.map((p) => [p.doc.id, p.doc]))
      return readJson<{ id: string; at: number }[]>(RECENT_KEY, []).map((r) => byId.get(r.id)).filter((d): d is SearchDoc => !!d).slice(0, PER)
        .map((doc, i): Row => ({ type: 'hit', hit: { doc, i: -1, tier: 0, score: 0 }, group: i === 0 ? 'Recent' : undefined }))
    }
    if (!result) return []
    const out: Row[] = []
    // the best result apart only when its group is not first (a frame named exactly what was typed, under folders)
    const top = result.top && result.groups[0]?.hits[0] !== result.top ? result.top : undefined
    if (top) out.push({ type: 'hit', hit: top, group: 'Best match' })
    for (const g of result.groups) {
      const hits = g.hits.filter((h) => h !== top)
      const shown = expanded.includes(g.kind) ? hits : hits.slice(0, PER)
      shown.forEach((hit, i) => out.push({ type: 'hit', hit, group: i === 0 ? LABEL[g.kind] : undefined }))
      const more = hits.length - shown.length + g.more
      if (more > 0 && !expanded.includes(g.kind)) out.push({ type: 'more', kind: g.kind, n: more })
    }
    result.partial.forEach((hit, i) => out.push({ type: 'hit', hit, group: i === 0 ? 'Partial matches' : undefined }))
    if (result.archived.count && !filter.archive) out.push({ type: 'archive', n: result.archived.count })
    return out
  }, [result, q, expanded, indexVersion])   // eslint-disable-line react-hooks/exhaustive-deps

  // a new query or filter starts at the top; anything else (an index update) keeps the selected thing selected
  const selId = useRef<string | null>(null)
  useEffect(() => { frozen.current = false; setSel(0); setExpanded([]) }, [q, filter])
  useEffect(() => {
    if (!frozen.current || !selId.current) return
    const i = rows.findIndex((r) => rowId(r) === selId.current)
    setSel(i >= 0 ? i : 0)
  }, [rows])
  const at = Math.min(sel, Math.max(0, rows.length - 1))
  const selRow = rows[at]
  selId.current = selRow ? rowId(selRow) : null
  // the selection stays in view as the arrows move it
  useEffect(() => { document.getElementById(`sr-row-${at}`)?.scrollIntoView({ block: 'nearest' }) }, [at])
  const target = selRow?.type === 'hit' ? previewOf(selRow.hit.doc) : null
  const nextRow = rows.slice(at + 1).find((r) => r.type === 'hit')
  const next = nextRow?.type === 'hit' ? previewOf(nextRow.hit.doc) : null

  if (!open) return null
  const activate = (r: Row, keep: boolean, via: 'key' | 'click') => {
    if (r.type === 'more') { setExpanded((x) => [...x, r.kind]); return }   // the selection stays put: on the first revealed row
    if (r.type === 'archive') { cmd('search-kinds', { via, in: 'shell', arg: 'archive' }); setFilter((f) => ({ ...f, archive: true })); return }
    cmd('search-go', { via, in: 'shell', arg: r.hit.doc.kind })
    go(r.hit.doc)
    if (!keep) toggleSearch(false)
  }
  // the lens's keys, wherever focus is inside it (the field, the kind pill, the menu)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return   // an IME's Enter confirms its word
    if (e.key === 'Escape') { e.preventDefault(); if (menu) { setMenu(false); input.current?.focus() } else { cmd('search', { via: 'key', in: 'shell', keys: 'Escape' }); toggleSearch(false) }; return }
    if (e.key === 'Tab') {
      // focus stays in the dialog: the field, the pill, the menu's rows
      e.preventDefault()
      const els = [...(lens.current?.querySelectorAll<HTMLElement>('input, button') ?? [])]
      const i = els.indexOf(document.activeElement as HTMLElement)
      els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length]?.focus()
      return
    }
    if (e.target !== input.current) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); frozen.current = true
      if (e.repeat) { setResting(false); clearTimeout(repeatTimer.current); repeatTimer.current = setTimeout(() => setResting(true), 120) }
      setSel((s) => (rows.length ? (Math.min(s, rows.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length : 0))
      return
    }
    if (e.key === 'Enter' && selRow) { e.preventDefault(); activate(selRow, e.metaKey || e.ctrlKey, 'key') }
  }
  const onKeyUp = (e: React.KeyboardEvent) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { clearTimeout(repeatTimer.current); setResting(true) } }

  const allOn = filter.kinds.length === ALL.length
  const pill = allOn ? 'All' : filter.kinds.length === 1 ? LABEL[filter.kinds[0]] : `${filter.kinds.length} kinds`
  const toggleKind = (k: SearchKind | 'all') => { cmd('search-kinds', { via: 'click', in: 'shell', arg: k }); setFilter((f) => {
    if (k === 'all') return { ...f, kinds: ALL }
    // with All on, ticking a kind narrows to that kind alone
    if (f.kinds.length === ALL.length) return { ...f, kinds: [k] }
    const has = f.kinds.includes(k)
    const kinds = has ? f.kinds.filter((x) => x !== k) : [...f.kinds, k]
    return { ...f, kinds: kinds.length ? KIND_ORDER.filter((x) => kinds.includes(x)) : ALL }   // never zero kinds
  }) }
  const hits = rows.filter((r) => r.type === 'hit').length

  return (
    <div className="sr-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) { cmd('search', { via: 'click', in: 'shell' }); toggleSearch(false) } }}>
      {/* a press anywhere in the lens leaves the caret in the field: pick kinds, click a row, keep typing (Spotlight) */}
      <div ref={lens} className="sr-lens" role="dialog" aria-modal="true" aria-label="Search the canvas" onKeyDown={onKey} onKeyUp={onKeyUp}
        onMouseDown={(e) => { if (e.target !== input.current) e.preventDefault() }}>
        <div className="sr-input">
          <MagnifierIcon size={20} className="mag" />
          <input ref={input} value={q} placeholder="Search" spellCheck={false} autoComplete="off" data-mv-transient=""
            role="combobox" aria-label="Search folders, boards, scenes, frames, notes and comments" aria-expanded={rows.length > 0} aria-controls="sr-list" aria-autocomplete="list"
            aria-activedescendant={selRow ? `sr-row-${at}` : undefined}
            onChange={(e) => setQ(e.target.value)} />
          {!index && <span className="sr-ready">Loading…</span>}
          <span className="sr-kinds-wrap">
            <button className={`sr-kinds${allOn ? '' : ' on'}`} aria-haspopup="menu" aria-expanded={menu} aria-label={`Kinds: ${pill}`} onClick={() => setMenu((m) => !m)}>{pill}<CaretIcon size={11} /></button>
            {menu && (
              <div className="sh-menu sr-menu" role="menu" onMouseDown={(e) => e.preventDefault()}>
                <button role="menuitemcheckbox" aria-checked={allOn} className={allOn ? 'on' : undefined} onClick={() => toggleKind('all')}><i className="gl"><GridIcon size={14} /></i><span>All</span><i className={`ck${allOn ? ' on' : ''}`}>{allOn && <CheckIcon size={11} />}</i></button>
                <i className="div" />
                {KIND_ORDER.map((k) => { const on = !allOn && filter.kinds.includes(k); return (
                  <button key={k} role="menuitemcheckbox" aria-checked={on} className={on ? 'on' : undefined} onClick={() => toggleKind(k)}><i className="gl">{MENU_ICON[k]}</i><span>{LABEL[k]}</span><i className={`ck${on ? ' on' : ''}`}>{on && <CheckIcon size={11} />}</i></button>
                ) })}
                <i className="div" />
                <button role="menuitemcheckbox" aria-checked={filter.archive} className={filter.archive ? 'on' : undefined} onClick={() => { cmd('search-kinds', { via: 'click', in: 'shell', arg: 'archive' }); setFilter((f) => ({ ...f, archive: !f.archive })) }}><i className="gl"><ArchiveIcon size={14} /></i><span>Include archive</span><i className={`ck${filter.archive ? ' on' : ''}`}>{filter.archive && <CheckIcon size={11} />}</i></button>
              </div>
            )}
          </span>
        </div>
        <div className="sr-body">
          <div className="sr-list" id="sr-list" role="listbox" aria-label="Results">
            {rows.map((r, i) => {
              const props = { id: `sr-row-${i}`, role: 'option', 'aria-selected': i === at, onMouseMove: () => { if (at !== i) setSel(i) }, onClick: (e: React.MouseEvent) => activate(r, e.metaKey || e.ctrlKey, 'click') }
              if (r.type === 'more') return <div key={rowId(r)} {...props} className={`sr-fold more${i === at ? ' sel' : ''}`}>+{r.n} more {LABEL[r.kind].toLowerCase()}</div>
              if (r.type === 'archive') return <div key={rowId(r)} {...props} className={`sr-fold${i === at ? ' sel' : ''}`}><ArchiveIcon size={14} />+{r.n} in archive</div>
              const d = r.hit.doc
              return (
                <div key={rowId(r)}>
                  {r.group && <div className="sr-group">{r.group}</div>}
                  <div {...props} className={`sr-row${i === at ? ' sel' : ''}${d.archived ? ' dim' : ''}`}>
                    <span className="ic">{d.kind === 'board' ? <TypeIcon type={(d.kinds?.split(' ').find((w) => /^(feature|project|deck|archive|start|surface|feedback|context)$/.test(w)) ?? 'plain') as never} /> : d.kind === 'frame' && d.kinds && /\b(spec|flow|copy|moodboard)\b/.test(d.kinds) ? <IntentGlyph intent={d.kinds.split(' ')[0]} size={17} /> : <KindIcon doc={d} />}</span>
                    <div className="tx">
                      <div className="t"><Marked hit={r.hit} q={result?.didYouMean ?? q} /></div>
                      <div className="s">{r.hit.matchedIn && r.hit.matchedIn !== 'summary' ? <><em>in {r.hit.matchedIn}</em> · </> : null}{d.where}</div>
                    </div>
                    {d.kind === 'comment' && d.asks && <span className="end"><span className="sr-pill ask">asks</span></span>}
                    {d.archived && <span className="end"><span className="sr-pill"><ArchiveIcon size={11} /></span></span>}
                  </div>
                </div>
              )
            })}
            {index && q.trim() && !hits && (
              <div className="sr-empty"><div className="big">Nothing for “{q.trim()}”</div>
                <div>{result?.archived.count ? `${result.archived.count} in the archive` : `Searched ${result?.searched ?? 0} things`}</div>
                {!allOn && <div className="sr-fix"><button onClick={() => toggleKind('all')}>Search all kinds</button></div>}
              </div>
            )}
            {result?.didYouMean && <div className="sr-more">Showing results for “{result.didYouMean}”</div>}
          </div>
          {!small && <div className="sr-live"><Preview target={target} next={next} paused={!resting} /></div>}
        </div>
      </div>
    </div>
  )
}
