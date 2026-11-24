/**
 * Search (spec 35): the ⌘K lens - small floating glass over the canvas, the list on the left and the selected
 * result's frame rendered live on the right (Preview.tsx). Kinds by level; every word must match (shared/search.ts);
 * Enter lands the canvas through the show path (never goTo: it can place a frame on the current board).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { buildIndex, search, KIND_ORDER, type Hit, type SearchDoc, type SearchIndex, type SearchKind, type SearchResult } from '../../../shared/search.ts'
import { api, scoped } from '../api.ts'
import { UNPLACED } from '../hash.ts'
import { useStore } from '../store.ts'
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

/** A frame the preview can render for this result, or null (a folder, a board with no frame). */
function previewOf(doc: SearchDoc): PreviewTarget | null {
  const id = doc.frame ?? doc.preview
  const frame = id ? useStore.getState().manifest?.frames.find((f) => f.id === id) : undefined
  if (!frame) return null
  return { frame, board: doc.dest.board, title: doc.title, where: doc.where ?? '' }
}

/** Land the canvas on the result (the show path: newest wins, a person's own navigation cancels it). */
function go(doc: SearchDoc): void {
  remember(doc.id)
  const d = doc.dest
  if (d.folder) { window.dispatchEvent(new CustomEvent('mv:reveal-folder', { detail: d.folder })); return }
  // a frame on no board lands in Not on a board; a thread pinned to one of two instances selects that one (its node)
  const board = d.board ?? (d.unplaced ? UNPLACED : useStore.getState().board)
  if (!board) return
  void showTarget({ board, ...(d.node ? { n: [d.node] } : d.frame ? { f: [d.frame] } : d.scene ? { s: [d.scene] } : {}), ...(d.thread ? { c: d.thread } : {}) }, 'app')
}

interface Row { hit: Hit; group?: string }

export function Search() {
  const open = useSearch((s) => s.open)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>(() => readJson<Filter>(KINDS_KEY, { kinds: ALL, archive: false }))
  const [menu, setMenu] = useState(false)
  const [sel, setSel] = useState(0)
  const [, bump] = useState(0)
  const frozen = useRef(false)   // after an arrow, results never reorder above the selection
  const input = useRef<HTMLInputElement>(null)
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [resting, setResting] = useState(true)   // false while an arrow is held (key repeat): the preview waits

  useEffect(() => { const l = () => bump((n) => n + 1); listeners.add(l); return () => { listeners.delete(l) } }, [])
  // the field takes the keys in the same task as ⌘K - never a frame later, or the first letters typed fast land on the
  // canvas (a backgrounded or busy window runs animation frames late); the last query, selected: typing replaces it
  useLayoutEffect(() => {
    if (!open) return
    input.current?.focus(); input.current?.select()
  }, [open])
  useEffect(() => {
    if (!open) return
    void loadSearchDocs()
    setSel(0); frozen.current = false; setMenu(false)
  }, [open])
  useEffect(() => { writeJson(KINDS_KEY, filter); if (useSearch.getState().open) input.current?.focus() }, [filter])

  const board = useStore((s) => s.board)
  const result: SearchResult | null = useMemo(() => {
    if (!index || !q.trim()) return null
    const recent = new Map(readJson<{ id: string; at: number }[]>(RECENT_KEY, []).map((r) => [r.id, Math.exp(-(Date.now() - r.at) / (30 * 864e5))]))
    return search(index, q, { kinds: filter.kinds.length === ALL.length ? undefined : filter.kinds, archive: filter.archive, board, recency: recent })
  }, [q, filter, board, indexVersion])   // eslint-disable-line react-hooks/exhaustive-deps

  // the rows, in order: the groups by level (the top hit leads its own group), then partial matches
  const rows: Row[] = useMemo(() => {
    if (!index) return []
    if (!q.trim()) {
      const byId = new Map(index.docs.map((p) => [p.doc.id, p.doc]))
      return readJson<{ id: string; at: number }[]>(RECENT_KEY, []).map((r) => byId.get(r.id)).filter((d): d is SearchDoc => !!d).slice(0, 6)
        .map((doc, i) => ({ hit: { doc, i: -1, tier: 0, score: 0 }, group: i === 0 ? 'Recent' : undefined }))
    }
    if (!result) return []
    const out: Row[] = []
    for (const g of result.groups) g.hits.forEach((hit, i) => out.push({ hit, group: i === 0 ? LABEL[g.kind] : undefined }))
    result.partial.forEach((hit, i) => out.push({ hit, group: i === 0 ? 'Partial matches' : undefined }))
    return out
  }, [result, q, indexVersion])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!frozen.current) setSel(0) }, [q, filter])
  // the selection stays in view as the arrows move it
  useEffect(() => { document.getElementById(`sr-row-${sel}`)?.scrollIntoView({ block: 'nearest' }) }, [sel])
  const selRow = rows[Math.min(sel, rows.length - 1)]
  const target = selRow ? previewOf(selRow.hit.doc) : null
  const nextRow = rows[Math.min(sel + 1, rows.length - 1)]
  const next = nextRow && nextRow !== selRow ? previewOf(nextRow.hit.doc) : null

  if (!open) return null
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); if (menu) setMenu(false); else toggleSearch(false); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); frozen.current = true
      if (e.repeat) { setResting(false); clearTimeout(repeatTimer.current); repeatTimer.current = setTimeout(() => setResting(true), 120) }
      setSel((s) => (rows.length ? (s + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length : 0))
      return
    }
    if (e.key === 'Enter' && selRow) {
      e.preventDefault()
      go(selRow.hit.doc)
      if (!(e.metaKey || e.ctrlKey)) toggleSearch(false)
    }
  }
  const onKeyUp = (e: React.KeyboardEvent) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { clearTimeout(repeatTimer.current); setResting(true) } }

  const allOn = filter.kinds.length === ALL.length
  const pill = allOn ? 'All' : filter.kinds.length === 1 ? LABEL[filter.kinds[0]] : `${filter.kinds.length} kinds`
  const toggleKind = (k: SearchKind | 'all') => setFilter((f) => {
    if (k === 'all') return { ...f, kinds: ALL }
    // with All on, ticking a kind narrows to that kind alone
    if (f.kinds.length === ALL.length) return { ...f, kinds: [k] }
    const has = f.kinds.includes(k)
    const kinds = has ? f.kinds.filter((x) => x !== k) : [...f.kinds, k]
    return { ...f, kinds: kinds.length ? KIND_ORDER.filter((x) => kinds.includes(x)) : ALL }   // never zero kinds
  })

  return (
    <div className="sr-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) toggleSearch(false) }}>
      {/* a press anywhere in the lens leaves the caret in the field: pick kinds, click a row, keep typing (Spotlight) */}
      <div className="sr-lens" role="dialog" aria-label="Search" onMouseDown={(e) => { if (e.target !== input.current) e.preventDefault() }}>
        <div className="sr-input">
          <MagnifierIcon size={20} className="mag" />
          <input ref={input} value={q} placeholder="Search" spellCheck={false} autoComplete="off" data-mv-transient=""
            role="combobox" aria-expanded="true" aria-controls="sr-list" aria-activedescendant={selRow ? `sr-row-${sel}` : undefined}
            onChange={(e) => { frozen.current = false; setQ(e.target.value) }} onKeyDown={onKey} onKeyUp={onKeyUp} />
          {!index && <span className="sr-ready">Loading…</span>}
          <span className="sr-kinds-wrap">
            <button className={`sr-kinds${allOn ? '' : ' on'}`} onClick={() => setMenu((m) => !m)}>{pill}<CaretIcon size={11} /></button>
            {menu && (
              <div className="sh-menu sr-menu" onMouseDown={(e) => e.preventDefault()}>
                <button className={allOn ? 'on' : undefined} onClick={() => toggleKind('all')}><i className="gl"><GridIcon size={14} /></i><span>All</span><i className={`ck${allOn ? ' on' : ''}`}>{allOn && <CheckIcon size={11} />}</i></button>
                <i className="div" />
                {KIND_ORDER.map((k) => { const on = !allOn && filter.kinds.includes(k); return (
                  <button key={k} className={on ? 'on' : undefined} onClick={() => toggleKind(k)}><i className="gl">{MENU_ICON[k]}</i><span>{LABEL[k]}</span><i className={`ck${on ? ' on' : ''}`}>{on && <CheckIcon size={11} />}</i></button>
                ) })}
                <i className="div" />
                <button className={filter.archive ? 'on' : undefined} onClick={() => setFilter((f) => ({ ...f, archive: !f.archive }))}><i className="gl"><ArchiveIcon size={14} /></i><span>Include archive</span><i className={`ck${filter.archive ? ' on' : ''}`}>{filter.archive && <CheckIcon size={11} />}</i></button>
              </div>
            )}
          </span>
        </div>
        <div className="sr-body">
          <div className="sr-list" id="sr-list" role="listbox">
            {rows.map((r, i) => (
              <div key={r.hit.doc.id}>
                {r.group && <div className="sr-group">{r.group}</div>}
                <div id={`sr-row-${i}`} role="option" aria-selected={i === sel} className={`sr-row${i === sel ? ' sel' : ''}${r.hit.doc.archived ? ' dim' : ''}`}
                  onMouseMove={() => { if (sel !== i) setSel(i) }} onClick={(e) => { go(r.hit.doc); if (!(e.metaKey || e.ctrlKey)) toggleSearch(false) }}>
                  <span className="ic">{r.hit.doc.kind === 'board' ? <TypeIcon type={(r.hit.doc.summary?.split(' · ').find((w) => /^(feature|project|deck|archive|start|surface|feedback|context)$/.test(w)) ?? 'plain') as never} /> : r.hit.doc.kind === 'frame' && r.hit.doc.summary && /\b(spec|flow|copy|moodboard)\b/.test(r.hit.doc.summary) ? <IntentGlyph intent={r.hit.doc.summary.split(' · ').pop()!} size={17} /> : <KindIcon doc={r.hit.doc} />}</span>
                  <div className="tx">
                    <div className="t">{r.hit.doc.title || r.hit.doc.key}</div>
                    <div className="s">{r.hit.matchedIn && r.hit.matchedIn !== 'summary' ? <><em>in {r.hit.matchedIn}</em> · </> : null}{r.hit.doc.where}</div>
                  </div>
                  {r.hit.doc.kind === 'comment' && r.hit.doc.asks && <span className="end"><span className="sr-pill ask">asks</span></span>}
                  {r.hit.doc.archived && <span className="end"><span className="sr-pill"><ArchiveIcon size={11} /></span></span>}
                </div>
              </div>
            ))}
            {index && q.trim() && !rows.length && (
              <div className="sr-empty"><div className="big">Nothing for “{q.trim()}”</div>
                <div>{result?.archived.count ? `${result.archived.count} in the archive` : `Searched ${result?.searched ?? 0} things`}</div>
                <div className="sr-fix">
                  {!allOn && <button onClick={() => toggleKind('all')}>Search all kinds</button>}
                  {!!result?.archived.count && <button onClick={() => setFilter((f) => ({ ...f, archive: true }))}>Include archive ({result.archived.count})</button>}
                </div>
              </div>
            )}
            {!!result?.archived.count && !filter.archive && rows.length > 0 && (
              <div className="sr-fold" onClick={() => setFilter((f) => ({ ...f, archive: true }))}><ArchiveIcon size={14} />+{result.archived.count} in archive</div>
            )}
            {result?.didYouMean && <div className="sr-more">Showing results for “{result.didYouMean}”</div>}
          </div>
          <div className="sr-live"><Preview target={resting ? target : null} next={resting ? next : null} /></div>
        </div>
      </div>
    </div>
  )
}
