/**
 * Search (spec 35): the document builder - a canvas's folders, boards, scenes, frames, sticky notes and comment threads
 * as search documents (shared/search.ts). One builder behind both the dev server's index and `marver search`, reading
 * only files: no dev server, no render.
 *
 * v1 reads what the files say. A frame's words are its own file's text - string literals, template text and JSX text,
 * read by a linear scanner - and the Markdown it binds directly; what a frame SHOWS from shared screen components is
 * v1.1 (rendered text).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanFrames, noteFileFor, type Manifest } from './manifest.ts'
import { checkBoardsDir, listBoardFiles, readRegistry } from './boards.ts'
import { framesOn } from '../shared/board-tree.ts'
import { knownType } from '../shared/board-types.ts'
import { listBoards, readLog } from './comments.ts'
import { asks, replay } from '../shared/events.ts'
import type { SearchDoc } from '../shared/search.ts'

/** A folder name or title that says archive - used only when nothing explicit says otherwise. */
const ARCHIVE_NAME = /(^|[\s\-_])(archive|archived|old|retired)($|[\s\-_])|^arch-/i
/** The longest text kept per field per document; the most of a source file the scanner reads. */
const CAP = 4000, SCAN_MAX = 256 * 1024

const cap = (s: string | undefined, n = CAP) => (s && s.length > n ? s.slice(0, n) : s)
const mtime = (root: string, rel: string | undefined): number | undefined => { if (!rel) return undefined; try { return statSync(join(root, rel)).mtimeMs } catch { return undefined } }

// ---- archive: one classifier, from what the files declare -------------------------------------------------------

export interface ArchiveInput {
  /** each board's own declarations, raw: its `type` and `status` words, and its folder */
  boards: { name: string; type?: unknown; status?: unknown; folder?: string }[]
  /** each folder, raw: name, title, declared type, parent */
  folders: { name: string; title?: string; type?: unknown; parent?: string }[]
}
/**
 * Which boards and folders are archived. Explicit first: a board decided `archived`, or whose nearest declared type -
 * its own, else its folder's, else that folder's parent's - is `archive` (a board's own type wins, even `plain` or a
 * word Marver does not know: the board spoke for itself). Only when nothing on the chain declares a type does a folder
 * named like an archive count (`archive`, `archived`, `old`, `retired`, an `arch-` prefix).
 */
export function classifyArchive(input: ArchiveInput): { boards: Set<string>; folders: Set<string> } {
  const byName = new Map(input.folders.map((f) => [f.name, f]))
  const chain = (name?: string) => { const out: typeof input.folders = []; for (let f = name ? byName.get(name) : undefined; f && out.length < 8; f = f.parent ? byName.get(f.parent) : undefined) out.push(f); return out }
  const declared = (t: unknown) => typeof t === 'string' && t.trim() !== ''
  const folderArchived = (name: string): boolean => {
    const c = chain(name)
    const typed = c.find((f) => declared(f.type))
    if (typed) return knownType(typed.type) === 'archive' || typed.type === 'archive'
    return c.some((f) => ARCHIVE_NAME.test(f.name) || ARCHIVE_NAME.test(f.title ?? ''))
  }
  const folders = new Set(input.folders.filter((f) => folderArchived(f.name)).map((f) => f.name))
  const boards = new Set<string>()
  for (const b of input.boards) {
    if (b.status === 'archived' || b.name === 'archive') { boards.add(b.name); continue }
    if (declared(b.type)) { if (b.type === 'archive') boards.add(b.name); continue }
    if (b.folder && folders.has(b.folder)) boards.add(b.name)
  }
  return { boards, folders }
}

// ---- a frame's own words: a linear scanner ---------------------------------------------------------------------

/**
 * A frame's own words, read by one pass over its source (bounded: SCAN_MAX characters): string literals and template
 * text (any length, multi-line), JSX text between tags (around `{expressions}`), never comments, import paths or class
 * lists; plus the Markdown a `?raw` import binds when the frame uses that binding. Capped.
 */
export function frameWords(root: string, file: string): string | undefined {
  let src: string
  try { src = readFileSync(join(root, file), 'utf8') } catch { return undefined }
  if (src.length > SCAN_MAX) src = src.slice(0, SCAN_MAX)
  const out: string[] = []
  const dir = file.split('/').slice(0, -1).join('/')
  // Markdown bound directly and used: import spec from './spec.md?raw' ... {spec}
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"\n]+\.md)\?raw['"]/g)) {
    if (!new RegExp(`[{(,\\s]${m[1]}[\\s})\\],.]`).test(src.slice((m.index ?? 0) + m[0].length))) continue
    try { out.push(readFileSync(join(root, dir, m[2]), 'utf8').slice(0, CAP)) } catch { /* outside or missing: skipped */ }
  }
  const n = src.length
  let i = 0, depth = 0   // depth: inside JSX tag markup `<...>` (attributes) vs text
  let inTag = false
  let text = ''
  const flushText = () => { const t = text.replace(/\s+/g, ' ').trim(); if (/[A-Za-z]/.test(t) && t.length > 1) out.push(t); text = '' }
  const isProse = (s: string): boolean => {
    if (!/[A-Za-z]/.test(s)) return false
    if (/^(\.{0,2}\/|https?:|#|data:)/.test(s)) return false                       // a path, a URL, an id selector
    if (!/\s/.test(s)) return /^[A-Z][a-z]+$/.test(s) || /^[A-Z][a-z]+[A-Z]?[a-z]*$/.test(s) && s.length > 3   // one word: a label like "Continue"
    // a class list: every token looks like a utility or a css name
    const toks = s.trim().split(/\s+/)
    if (toks.every((t) => /^[!\w-]*[-:[\]/.][\w\-:[\]/.%#()]*$/.test(t) || /^[a-z]+(-[a-z0-9]+)+$/.test(t))) return false
    return true
  }
  while (i < n) {
    const c = src[i], d = src[i + 1]
    // comments: skipped whole
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); flushText(); i = e < 0 ? n : e; continue }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); flushText(); i = e < 0 ? n : e + 2; continue }
    if (c === "'" || c === '"' || c === '`') {
      flushText()
      // a string or template literal: read to its unescaped end (a template's ${...} kept as a space)
      let j = i + 1, s = ''
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { s += src[j + 1] ?? ''; j += 2; continue }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          let k = j + 2, b = 1
          while (k < n && b > 0) { if (src[k] === '{') b++; else if (src[k] === '}') b--; k++ }
          s += ' '; j = k; continue
        }
        if (c !== '`' && src[j] === '\n') break
        s += src[j]; j++
      }
      const before = src.slice(Math.max(0, i - 12), i)
      if (!/(from|import)\s*$/.test(before) && !/className\s*=\s*\{?\s*$/.test(before) && isProse(s)) out.push(s.replace(/\s+/g, ' ').trim())
      i = j + 1; continue
    }
    // JSX: `<Tag ...>` markup vs the text between tags
    if (c === '<' && /[A-Za-z/>]/.test(d ?? '')) { flushText(); inTag = true; depth = 0; i++; continue }
    if (inTag) {
      if (c === '{') depth++
      else if (c === '}') depth = Math.max(0, depth - 1)
      else if (c === '>' && depth === 0) { inTag = false; text = ''; i++; collectText(); continue }
      i++; continue
    }
    i++
  }
  flushText()
  return cap(out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ') || undefined)

  /** After a tag closes: JSX text up to the next tag. An `{expression}` inside the text is skipped by its braces (its
   *  string literals kept: `{'Continue'}`) and the text continues after it: `Hello {name} welcome back`. */
  function collectText() {
    while (i < n) {
      const ch = src[i]
      if (ch === '<') return
      if (ch === '{') {
        let k = i + 1, b = 1
        const start = k
        while (k < n && b > 0) {
          const c2 = src[k]
          if (c2 === "'" || c2 === '"' || c2 === '`') { const e = skipString(k); k = e; continue }
          if (c2 === '{') b++; else if (c2 === '}') b--
          k++
        }
        const inner = src.slice(start, k - 1)
        if (/^\s*\/\*[\s\S]*\*\/\s*$/.test(inner)) { i = k; continue }   // {/* a JSX comment */}
        if (/<[A-Za-z]/.test(inner)) { flushText(); return }   // markup inside: the main loop reads it
        for (const m of inner.matchAll(/'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g)) {
          const v = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ')
          if (isProse(v)) { flushText(); out.push(v.replace(/\s+/g, ' ').trim()) }
        }
        text += ' '; i = k; continue
      }
      // code, not text: a statement's end, an arrow, an assignment after a generic's `>` (Map<string, number> = ...)
      if (ch === ';' || ch === '=' || ch === ')') { text = ''; return }
      text += ch; i++
    }
  }
  /** The index just past the string literal starting at `k`. */
  function skipString(k: number): number {
    const q = src[k]
    let j = k + 1
    while (j < n && src[j] !== q) { if (src[j] === '\\') j++; else if (q !== '`' && src[j] === '\n') break; j++ }
    return j + 1
  }
}

export interface BuiltDocs { docs: SearchDoc[]; manifest: Manifest }

/** Folders read as archive by their name alone - nothing in their chain declares a type (spec 35: `marver context
 *  check` names them, with the fix). The outermost only: an archive-named folder inside another is covered by it. */
export function archiveByNameOnly(root: string): string[] {
  const reg = readRegistry(join(root, 'design', 'boards'))
  if (reg.state !== 'ok') return []
  const by = new Map(reg.folders.map((f) => [f.name, f]))
  const chain = (n?: string) => { const out: typeof reg.folders = []; for (let f = n ? by.get(n) : undefined; f && out.length < 8; f = f.parent ? by.get(f.parent) : undefined) out.push(f); return out }
  const named = (f: { name: string; title?: string }) => ARCHIVE_NAME.test(f.name) || ARCHIVE_NAME.test(f.title ?? '')
  const flagged = (n: string) => { const c = chain(n); return !c.some((f) => f.type) && c.some(named) }
  return reg.folders.filter((f) => named(f) && flagged(f.name) && !(f.parent && flagged(f.parent))).map((f) => f.name)
}

/** Every search document of the canvas at `root`. */
export function buildSearchDocs(root: string, manifest: Manifest = scanFrames(root)): BuiltDocs {
  const docs: SearchDoc[] = []
  const boardsDir = join(root, 'design', 'boards')
  const files = checkBoardsDir(root, boardsDir) ? [] : listBoardFiles(boardsDir).boards
  const reg = readRegistry(boardsDir)
  const rawFolders = reg.state === 'ok' ? reg.folders : []
  const folders = manifest.folders ?? []
  const boardsMeta = manifest.boards ?? []
  const rawBoard = new Map(files.map((b) => [b.name, (b.json ?? {}) as { type?: unknown; status?: unknown; folder?: unknown }]))
  const meta = new Map(boardsMeta.map((b) => [b.name, b]))

  const arch = classifyArchive({
    boards: boardsMeta.map((b) => ({ name: b.name, type: rawBoard.get(b.name)?.type, status: rawBoard.get(b.name)?.status === 'archived' || b.status?.status === 'archived' ? 'archived' : rawBoard.get(b.name)?.status, folder: b.folder })),
    folders: rawFolders.map((f) => ({ name: f.name, title: f.title, type: f.type, parent: f.parent })),
  })
  const folderBy = new Map(folders.map((f) => [f.name, f]))
  const chainOf = (name?: string): string[] => { const out: string[] = []; for (let f = name ? folderBy.get(name) : undefined; f && out.length < 8; f = f.parent ? folderBy.get(f.parent) : undefined) out.push(f.name); return out }
  const folderPath = (name?: string) => chainOf(name).reverse().map((n) => folderBy.get(n)?.title ?? n).join(' › ')

  // ---- folders
  for (const f of folders) {
    docs.push({
      id: `folder:${f.name}`, kind: 'folder', key: f.name, title: f.title ?? f.name, summary: f.description,
      kinds: [f.type, 'folder'].filter(Boolean).join(' '),
      where: f.parent ? folderPath(f.parent) : undefined, folders: chainOf(f.name), archived: arch.folders.has(f.name),
      file: 'design/boards/_folders.json', dest: { folder: f.name },
    })
  }

  // ---- boards, and which frames each shows
  const live = manifest.frames.map((f) => f.id)
  const framesOnBoard = new Map<string, string[]>()
  for (const b of files) framesOnBoard.set(b.name, framesOn(b.json, live))
  const homes = new Map<string, string[]>()   // frame -> boards showing it, sidebar order
  for (const b of boardsMeta) for (const f of framesOnBoard.get(b.name) ?? []) { const h = homes.get(f); if (h) h.push(b.name); else homes.set(f, [b.name]) }
  const boardTitle = new Map(boardsMeta.map((b) => [b.name, b.title ?? b.name]))
  for (const b of boardsMeta) {
    const nFrames = framesOnBoard.get(b.name)?.length ?? 0
    const first = framesOnBoard.get(b.name)?.[0]
    docs.push({
      id: `board:${b.name}`, kind: 'board', key: b.name, title: b.title ?? b.name, summary: b.description,
      kinds: [b.type && b.type !== 'plain' ? b.type : '', b.status?.status ?? '', 'board'].filter(Boolean).join(' '),
      where: [folderPath(b.folder), `${nFrames} frame${nFrames === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
      boards: [b.name], folders: chainOf(b.folder), board: b.name, archived: arch.boards.has(b.name),
      file: `design/boards/${b.name}.json`, at: mtime(root, `design/boards/${b.name}.json`),
      ...(first ? { preview: first } : {}), dest: { board: b.name },
    })
  }
  /** On boards: archived when every board showing it is archived (one live board keeps it live). */
  const archivedOn = (bs: string[] | undefined) => !!bs?.length && bs.every((b) => arch.boards.has(b))
  const firstLive = (bs: string[] | undefined) => bs?.find((b) => !arch.boards.has(b)) ?? bs?.[0]
  const foldersOfBoards = (bs: string[] | undefined) => [...new Set((bs ?? []).flatMap((b) => chainOf(meta.get(b)?.folder)))]

  // ---- scenes, and their notes
  const sceneFrames = new Map<string, string[]>()
  for (const f of manifest.frames) { const s = sceneFrames.get(f.scene); if (s) s.push(f.id); else sceneFrames.set(f.scene, [f.id]) }
  for (const s of manifest.scenes) {
    const ids = sceneFrames.get(s.name) ?? []
    const bs = [...new Set(ids.flatMap((id) => homes.get(id) ?? []))]
    const board = firstLive(bs)
    const title = s.title ?? s.name
    docs.push({
      id: `scene:${s.name}`, kind: 'scene', key: s.name, title,
      summary: [s.description, briefBody(root, s.name)].filter(Boolean).join(' · ') || undefined, kinds: 'scene',
      notes: s.note, where: [board ? boardTitle.get(board) : 'Not on a board', `${ids.length} frame${ids.length === 1 ? '' : 's'}`].join(' · '),
      boards: bs, folders: foldersOfBoards(bs), board, scene: s.name, archived: archivedOn(bs),
      file: s.brief ?? `design/scenes/${s.name}`, at: mtime(root, s.brief),
      ...(ids[0] ? { preview: ids[0] } : {}), dest: { scene: s.name, ...(board ? { board } : { unplaced: true }) },
    })
    if (s.note) docs.push({ id: `note:scene:${s.name}`, kind: 'note', key: `${s.name}/_note`, title: firstLine(s.note), notes: s.note, kinds: 'note', summary: title, where: `Note by ${title}`, boards: bs, folders: foldersOfBoards(bs), board, scene: s.name, archived: archivedOn(bs), file: `design/scenes/${s.name}/_note.md`, ...(ids[0] ? { preview: ids[0] } : {}), dest: { scene: s.name, notes: true, ...(board ? { board } : { unplaced: true }) } })
  }

  // ---- frames, and their notes
  const sceneTitle = new Map(manifest.scenes.map((s) => [s.name, s.title ?? s.name]))
  for (const f of manifest.frames) {
    const bs = homes.get(f.id)
    const board = firstLive(bs)
    const title = f.title ?? f.id.split('/').pop() ?? f.id
    const where = [board ? boardTitle.get(board) : 'Not on a board', sceneTitle.get(f.scene)].filter(Boolean).join(' › ')
    const common = { boards: bs ?? [], folders: foldersOfBoards(bs), board, scene: f.scene, frame: f.id, archived: archivedOn(bs) }
    const dest = { frame: f.id, ...(board ? { board } : { unplaced: true }) }
    docs.push({
      id: `frame:${f.id}`, kind: 'frame', key: f.id, title, device: f.viewport,
      kinds: [f.intent, f.slide ? 'slide' : '', 'frame'].filter(Boolean).join(' '),
      summary: f.description, notes: f.note, source: frameWords(root, f.file), where, ...common,
      file: f.file, at: mtime(root, f.file),
      ...(f.variantGroup ? { variantGroup: f.variantGroup, variant: f.variant } : {}), dest,
    })
    if (f.note) docs.push({ id: `note:${f.id}`, kind: 'note', key: `${f.id}.note`, title: firstLine(f.note), notes: f.note, kinds: 'note', summary: title, where: `Note by ${title}`, ...common, file: noteFileFor(f.file), at: mtime(root, noteFileFor(f.file)), dest: { ...dest, notes: true } })
  }

  // ---- comment threads, replayed per board (edits, deletions, resolution applied)
  const commentsDir = join(root, 'design', 'comments')
  const frameTitle = new Map(manifest.frames.map((f) => [f.id, f.title ?? f.id]))
  if (existsSync(commentsDir)) {
    for (const board of listBoards(commentsDir)) {
      let threads
      try { threads = replay(readLog(commentsDir, board)) } catch { continue }
      for (const t of threads) {
        const msgs = [t.deleted ? '' : t.body ?? '', ...t.replies.map((r) => r.body ?? '')].filter(Boolean)
        if (!msgs.length) continue
        const last = t.replies.length ? t.replies[t.replies.length - 1] : { body: t.body, asks: t.asks, agent: t.agent, ts: t.ts }
        // the marks' rule (shared/marks.ts questions): open with Marver's word last = waiting on the person; `asks` when
        // that word asks something
        const waiting = !t.resolved && !!last.agent
        const onFrame = t.frame && frameTitle.has(t.frame) ? frameTitle.get(t.frame) : undefined
        const authorName = (t.author as { name?: string } | undefined)?.name
        docs.push({
          id: `comment:${board}:${t.id}`, kind: 'comment', key: `${board}:${t.id}`, title: firstLine(t.deleted ? (t.replies[0]?.body ?? '') : (t.body ?? '')),
          comments: cap(msgs.join(' · ')), kinds: 'comment thread',
          // what it is on: "the comment on the feed filter frame" is found by the frame's and the board's names
          summary: [onFrame, boardTitle.get(board) ?? board].filter(Boolean).join(' · '),
          where: [t.agent ? 'Marver' : authorName, t.resolved ? 'resolved' : 'open', onFrame ?? `${boardTitle.get(board) ?? board}${t.frame ? ' (frame gone)' : ''}`].filter(Boolean).join(' · '),
          boards: [board], folders: chainOf(meta.get(board)?.folder), board, frame: onFrame ? t.frame : undefined,
          archived: arch.boards.has(board), open: !t.resolved, waiting, asks: waiting && asks(last, !t.replies.length),
          file: `design/comments/${board}.jsonl`, at: last.ts ?? t.ts,
          ...(onFrame && t.frame ? { preview: t.frame } : {}),
          dest: { board, thread: t.id, ...(onFrame && t.frame ? { frame: t.frame } : {}), ...(t.nodeKey ? { node: t.nodeKey } : {}) },
        })
      }
    }
  }
  return { docs, manifest }
}

/** A brief's body (everything after its front matter). */
function briefBody(root: string, scene: string): string | undefined {
  try {
    const text = readFileSync(join(root, 'design', 'scenes', scene, '_brief.md'), 'utf8').replace(/^﻿/, '')
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
    return cap((m ? text.slice(m[0].length) : text).trim() || undefined)
  } catch { return undefined }
}

/** Markdown to the words a person reads: no emphasis marks, code ticks, link targets, list or quote markers. */
export const plain = (l: string): string => {
  // code spans keep their contents exactly (`__dirname` stays `__dirname`): set aside, the rest cleaned, put back
  const code: string[] = []
  // a span opens and closes with the same run of backticks (``a `b` c``); one space inside each end is padding
  const out = l.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _run: string, c: string) => `\u0000${code.push(/^ .* $/.test(c) ? c.slice(1, -1) : c) - 1}\u0000`)
    .replace(/^\s*(?:#+|>|[-*+]|\d+[.)])\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // strong: ** anywhere, __ only at word edges (foo__bar is a name, not emphasis)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '$1$2')
    .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, '$1$3')
    .replace(/~~(.+?)~~/g, '$1')
    // a strong left open where a note's first line ends (its close is on a later line)
    .replace(/^\*\*(?=\S)/, '')
    .trim()
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)] ?? '')
}
const firstLine = (s: string): string => {
  const line = s.split('\n').map(plain).find(Boolean) ?? ''
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}
