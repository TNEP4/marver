/**
 * Search (spec 35): the document builder - a canvas's folders, boards, scenes, frames, sticky notes and comment threads
 * as search documents (shared/search.ts). One builder behind both the dev server's index and `marver search`, reading
 * only files: no dev server, no render.
 *
 * v1 reads what the files say. A frame's words are its own file's text (string literals and JSX text) and the Markdown
 * it binds directly; what a frame SHOWS from shared screen components is v1.1 (rendered text).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanFrames, type Manifest } from './manifest.ts'
import { checkBoardsDir, listBoardFiles } from './boards.ts'
import { framesOn } from '../shared/board-tree.ts'
import { listBoards, readLog } from './comments.ts'
import { asks, replay } from '../shared/events.ts'
import type { SearchDoc } from '../shared/search.ts'

/** Words a folder's name or title has when it is an archive - used only when nothing explicit says otherwise. */
const ARCHIVE_NAME = /(^|[\s\-_])(archive|archived|old|retired)($|[\s\-_])|^arch-/i
/** The longest text kept per field per document. */
const CAP = 4000

const cap = (s: string | undefined, n = CAP) => (s && s.length > n ? s.slice(0, n) : s)

/** A brief's body (everything after its front matter). */
function briefBody(root: string, scene: string): string | undefined {
  const abs = join(root, 'design', 'scenes', scene, '_brief.md')
  try {
    const text = readFileSync(abs, 'utf8').replace(/^﻿/, '')
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
    return cap((m ? text.slice(m[0].length) : text).trim() || undefined)
  } catch { return undefined }
}

/**
 * A frame's own words: JSX text and string literals of its file (not imports, not class names, not code-ish
 * strings), plus the Markdown it binds directly - a `?raw` import of a `.md` file. Capped.
 */
export function frameWords(root: string, file: string): string | undefined {
  let src: string
  try { src = readFileSync(join(root, file), 'utf8') } catch { return undefined }
  const out: string[] = []
  // Markdown bound directly: import x from './spec.md?raw' (relative to the frame)
  for (const m of src.matchAll(/import\s+\w+\s+from\s+['"]([^'"]+\.md)\?raw['"]/g)) {
    const dir = file.split('/').slice(0, -1).join('/')
    try { out.push(readFileSync(join(root, dir, m[1]), 'utf8')) } catch { /* outside or missing: skipped */ }
  }
  const body = src.replace(/^\s*import[^\n]*$/gm, '').replace(/^\s*export\s+\{[^}]*\}[^\n]*$/gm, '')
  // JSX text: between > and <, with a letter in it
  for (const m of body.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push(m[1])
  // string literals with a space and a letter (prose, labels) - never a class list or a path
  for (const m of body.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.){3,200})\1/g)) {
    const s = m[2]
    if (!/[A-Za-z]/.test(s) || !/\s/.test(s)) continue
    if (/^[\w\-: [\]/.%#]+$/.test(s) && !/[A-Z]/.test(s)) continue   // looks like a class list
    if (/^(\.{0,2}\/|https?:)/.test(s)) continue
    out.push(s)
  }
  const text = out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ')
  return cap(text || undefined)
}

export interface BuiltDocs { docs: SearchDoc[]; manifest: Manifest }

/** Every search document of the canvas at `root`. */
export function buildSearchDocs(root: string, manifest: Manifest = scanFrames(root)): BuiltDocs {
  const docs: SearchDoc[] = []
  const folders = manifest.folders ?? []
  const boardsMeta = manifest.boards ?? []
  const folderBy = new Map(folders.map((f) => [f.name, f]))

  // ---- archive: explicit first (a board's status or type, resolved through its folders); a name only when nothing says
  const folderChain = (name?: string): typeof folders => {
    const out: typeof folders = []
    for (let f = name ? folderBy.get(name) : undefined; f; f = f.parent ? folderBy.get(f.parent) : undefined) out.push(f)
    return out
  }
  const folderArchived = (name?: string): boolean => {
    const chain = folderChain(name)
    if (chain.some((f) => f.type === 'archive')) return true
    if (chain.some((f) => f.type && f.type !== 'archive')) return false   // an explicit, other type: not archive by name
    return chain.some((f) => ARCHIVE_NAME.test(f.name) || ARCHIVE_NAME.test(f.title ?? ''))
  }
  const boardArchived = (b: (typeof boardsMeta)[number]): boolean => {
    if (b.status?.status === 'archived' || b.type === 'archive' || b.name === 'archive') return true
    if (b.type && b.type !== 'plain') return false   // an explicit type that is not archive wins over a folder's name
    return folderArchived(b.folder)
  }
  const archivedBoards = new Set(boardsMeta.filter(boardArchived).map((b) => b.name))
  const folderPath = (name?: string) => folderChain(name).reverse().map((f) => f.title ?? f.name).join(' › ')

  // ---- folders
  for (const f of folders) {
    docs.push({
      id: `folder:${f.name}`, kind: 'folder', key: f.name, title: f.title ?? f.name, summary: f.description,
      where: f.parent ? folderPath(f.parent) : undefined, folder: f.name, archived: folderArchived(f.name),
      dest: { folder: f.name },
    })
  }

  // ---- boards, and which frames each shows
  const live = manifest.frames.map((f) => f.id)
  const boardsDir = join(root, 'design', 'boards')
  const files = checkBoardsDir(root, boardsDir) ? [] : listBoardFiles(boardsDir).boards
  const framesOnBoard = new Map<string, string[]>()
  for (const b of files) framesOnBoard.set(b.name, framesOn(b.json, live))
  const homes = new Map<string, string[]>()   // frame -> boards showing it, sidebar order
  for (const b of boardsMeta) for (const f of framesOnBoard.get(b.name) ?? []) { const h = homes.get(f); if (h) h.push(b.name); else homes.set(f, [b.name]) }
  const boardTitle = new Map(boardsMeta.map((b) => [b.name, b.title ?? b.name]))
  for (const b of boardsMeta) {
    const n = framesOnBoard.get(b.name)?.length ?? 0
    docs.push({
      id: `board:${b.name}`, kind: 'board', key: b.name, title: b.title ?? b.name,
      summary: [b.description, b.type && b.type !== 'plain' ? b.type : '', b.status?.status ?? ''].filter(Boolean).join(' · ') || undefined,
      where: [folderPath(b.folder), `${n} frame${n === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
      board: b.name, folder: b.folder, archived: archivedBoards.has(b.name), dest: { board: b.name },
    })
  }
  /** A thing on boards is archived when every board showing it is archived (one live board keeps it live). */
  const archivedOn = (bs: string[] | undefined) => !!bs?.length && bs.every((b) => archivedBoards.has(b))
  const firstLive = (bs: string[] | undefined) => bs?.find((b) => !archivedBoards.has(b)) ?? bs?.[0]

  // ---- scenes
  const sceneFrames = new Map<string, string[]>()
  for (const f of manifest.frames) { const s = sceneFrames.get(f.scene); if (s) s.push(f.id); else sceneFrames.set(f.scene, [f.id]) }
  for (const s of manifest.scenes) {
    const ids = sceneFrames.get(s.name) ?? []
    const bs = [...new Set(ids.flatMap((id) => homes.get(id) ?? []))]
    const board = firstLive(bs)
    docs.push({
      id: `scene:${s.name}`, kind: 'scene', key: s.name, title: s.title ?? s.name,
      summary: [s.description, briefBody(root, s.name)].filter(Boolean).join(' · ') || undefined,
      notes: s.note, where: [board ? boardTitle.get(board) : undefined, `${ids.length} frame${ids.length === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
      board, scene: s.name, archived: archivedOn(bs), dest: { scene: s.name, ...(board ? { board } : {}) },
    })
    if (s.note) docs.push({ id: `note:scene:${s.name}`, kind: 'note', key: `${s.name}/_note`, title: firstLine(s.note), notes: s.note, where: `Note by ${s.title ?? s.name}`, board, scene: s.name, archived: archivedOn(bs), dest: { scene: s.name, notes: true, ...(board ? { board } : {}) } })
  }

  // ---- frames, and their notes
  const sceneTitle = new Map(manifest.scenes.map((s) => [s.name, s.title ?? s.name]))
  for (const f of manifest.frames) {
    const bs = homes.get(f.id)
    const board = firstLive(bs)
    const title = f.title ?? f.id.split('/').pop() ?? f.id
    const where = [board ? boardTitle.get(board) : 'Not on a board', sceneTitle.get(f.scene)].filter(Boolean).join(' › ')
    docs.push({
      id: `frame:${f.id}`, kind: 'frame', key: f.id, title, device: f.viewport,
      summary: [f.description, f.intent].filter(Boolean).join(' · ') || undefined,
      notes: f.note, source: frameWords(root, f.file), where,
      board, scene: f.scene, frame: f.id, archived: archivedOn(bs),
      ...(f.variantGroup ? { variantGroup: f.variantGroup, variant: f.variant } : {}),
      dest: { frame: f.id, ...(board ? { board } : {}) },
    })
    if (f.note) docs.push({ id: `note:${f.id}`, kind: 'note', key: `${f.id}.note`, title: firstLine(f.note), notes: f.note, where: `Note by ${title}`, board, scene: f.scene, frame: f.id, archived: archivedOn(bs), dest: { frame: f.id, notes: true, ...(board ? { board } : {}) } })
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
        const last = t.replies.length ? t.replies[t.replies.length - 1] : { body: t.body, asks: t.asks, agent: t.agent }
        const lastAsks = !!last.agent && asks(last, !t.replies.length)
        const authorName = (t.author as { name?: string } | undefined)?.name
        docs.push({
          id: `comment:${board}:${t.id}`, kind: 'comment', key: t.id, title: firstLine(t.deleted ? (t.replies[0]?.body ?? '') : (t.body ?? '')),
          comments: cap(msgs.join(' · ')),
          where: [t.agent ? 'Marver' : authorName, t.resolved ? 'resolved' : 'open', t.frame ? frameTitle.get(t.frame) : boardTitle.get(board)].filter(Boolean).join(' · '),
          board, frame: t.frame, archived: archivedBoards.has(board), open: !t.resolved, asks: !t.resolved && lastAsks,
          dest: { board, thread: t.id, ...(t.frame ? { frame: t.frame } : {}), ...(t.nodeKey ? { node: t.nodeKey } : {}) },
        })
      }
    }
  }
  return { docs, manifest }
}

const firstLine = (s: string): string => {
  const line = s.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}

/** Modification times, for exact-tie breaking (best effort). */
export const mtimeOf = (root: string, file: string): number => { try { return statSync(join(root, file)).mtimeMs } catch { return 0 } }
