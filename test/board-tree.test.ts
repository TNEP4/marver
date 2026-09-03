import { describe, expect, it } from 'vitest'
import {
  applyDrop, buildTree, createFolder, deleteFolder, flatten, fromWire, INDENT, isOwnSlot, moveBoard, newFolderSlot, parseFolders, readTitle, resolveDrop, retitleFolder, slugFor, slugify, toWire, validateWire,
  type Row, type TreeItem,
} from '../src/shared/board-tree.ts'

// The sidebar's folder tree is pure and MANDATORY-tested here: ranking, the wire contract, every
// mutation, and the drop resolver at each boundary. The browser suite proves the pointer gesture
// and the files on top of this; it is Chrome-optional, this is not.

const T = (wire: Parameters<typeof fromWire>[0]) => fromWire(wire)
const F = (name: string, boards: string[]): TreeItem => ({ kind: 'folder', name, boards })
const B = (name: string): TreeItem => ({ kind: 'board', name })

describe('buildTree - ranking from the files', () => {
  it('root = root boards + folders by order, board before folder on a tie, then name; unranked last', () => {
    const tree = buildTree(
      [{ name: 'b', order: 1 }, { name: 'a', order: 1 }, { name: 'z' }, { name: 'in', order: 0, folder: 'f' }, { name: 'also', folder: 'f' }],
      [{ name: 'f', order: 1 }, { name: 'empty', order: 0 }],
    )
    expect(tree).toEqual([F('empty', []), B('a'), B('b'), F('f', ['in', 'also']), B('z')])
  })
  it('a folder a board names but the registry lacks is real (unranked, after ranked items by name)', () => {
    const tree = buildTree([{ name: 'x', folder: 'implied' }, { name: 'r', order: 0 }], [])
    expect(tree).toEqual([B('r'), F('implied', ['x'])])
  })
  it('all-scenes never enters the tree, even with a folder; off-grammar folder values mean top level', () => {
    const tree = buildTree([{ name: 'all-scenes', folder: 'f' }, { name: 'a', folder: 'Not Valid' }, { name: 'b', folder: '' }], [])
    expect(tree).toEqual([B('a'), B('b')])
  })
  it('flatten is depth-first: the landing board is the first board the sidebar shows', () => {
    expect(flatten([F('first', ['x', 'y']), B('r'), F('e', [])])).toEqual(['x', 'y', 'r'])
  })
})

describe('parseFolders - the registry is strict', () => {
  it('reads rows, ignores a missing order; a title and a description ride along, cleaned', () => {
    expect(parseFolders({ version: 1, folders: [{ name: 'a', order: 2 }, { name: 'b' }] })).toEqual([{ name: 'a', order: 2 }, { name: 'b' }])
    expect(parseFolders({ version: 1, folders: [{ name: 'ui', title: '  UI  🚀 ', description: 'x' }, { name: 'b', title: '' }] })).toEqual([{ name: 'ui', title: 'UI 🚀', description: 'x' }, { name: 'b' }])
    expect(buildTree([{ name: 'x', folder: 'ui' }], [{ name: 'ui', title: 'UI' }])).toEqual([{ kind: 'folder', name: 'ui', boards: ['x'], title: 'UI' }])
  })
  it('names what is wrong instead of reading an empty registry', () => {
    expect(typeof parseFolders(null)).toBe('string')
    expect(typeof parseFolders([])).toBe('string')
    expect(typeof parseFolders({ version: 2, folders: [] })).toBe('string')
    expect(typeof parseFolders({ folders: 'x' })).toBe('string')
    expect(typeof parseFolders({ folders: [{ name: 'Bad Name' }] })).toBe('string')
    expect(typeof parseFolders({ folders: [{ name: 'a' }, { name: 'a' }] })).toBe('string')
  })
})

describe('the wire contract', () => {
  it('round-trips; a folder title rides the wire (it lives in the registry the write rewrites)', () => {
    const tree = [B('a'), F('f', ['x', 'y']), B('b')]
    expect(fromWire(toWire(tree))).toEqual(tree)
    expect(toWire(tree)).toEqual(['a', { folder: 'f', boards: ['x', 'y'] }, 'b'])
    const titled: TreeItem[] = [{ kind: 'folder', name: 'ui', boards: [], title: 'UI', description: 'd' }]
    expect(toWire(titled)).toEqual([{ folder: 'ui', boards: [], title: 'UI', description: 'd' }])
    expect(fromWire(toWire(titled))).toEqual(titled)
    expect(validateWire([{ folder: 'ui', boards: [], title: 'UI 🚀' }])).toBeNull()
    expect(validateWire([{ folder: 'ui', boards: [], title: 'x'.repeat(121) }])).toMatch(/title/)
    expect(validateWire([{ folder: 'ui', boards: [], title: 5 }])).toMatch(/title/)
  })
  it('validateWire refuses every malformed shape and accepts the sound one', () => {
    expect(validateWire(['a', { folder: 'f', boards: ['x'] }])).toBeNull()
    expect(validateWire([])).toBeNull()
    expect(validateWire('a')).toMatch(/invalid/)
    expect(validateWire(['all-scenes'])).toMatch(/invalid board/)
    expect(validateWire([{ folder: 'f', boards: ['all-scenes'] }])).toMatch(/invalid board/)
    expect(validateWire(['a', 'a'])).toMatch(/twice/)
    expect(validateWire(['a', { folder: 'f', boards: ['a'] }])).toMatch(/twice/)
    expect(validateWire([{ folder: 'f', boards: [] }, { folder: 'f', boards: [] }])).toMatch(/twice/)
    expect(validateWire([{ folder: 'f', boards: [{ folder: 'g', boards: [] }] }])).toMatch(/invalid board/)
    expect(validateWire([{ folder: 'Bad', boards: [] }])).toMatch(/invalid folder/)
    expect(validateWire([{ folder: 'f' }])).toMatch(/invalid folder/)
    expect(validateWire([null])).toMatch(/invalid/)
    expect(validateWire(Array.from({ length: 51 }, (_, i) => ({ folder: `f${i}`, boards: [] })))).toMatch(/too large/)
  })
})

describe('readTitle - what humans see', () => {
  it('keeps casing, punctuation and emoji; drops control characters; collapses whitespace; caps in code points', () => {
    expect(readTitle('  MVP  ')).toBe('MVP')
    expect(readTitle('Checkout (v2) 🚀')).toBe('Checkout (v2) 🚀')
    expect(readTitle('a\u0000b\tc\nd')).toBe('a b c d')
    expect(readTitle('')).toBeUndefined(); expect(readTitle('   ')).toBeUndefined(); expect(readTitle(5)).toBeUndefined()
    const emoji = readTitle('🚀'.repeat(200))!
    expect(Array.from(emoji).length).toBe(120)
    expect(emoji.endsWith('🚀')).toBe(true)   // never a half surrogate
  })
})

describe('slugFor - a new folder mints its slug from its title, once', () => {
  it('a taken slug gets -2, -3; nothing to slug gets the fallback; always on-grammar', () => {
    expect(slugFor('Old stuff', [])).toBe('old-stuff')
    expect(slugFor('MVP 🚀', [])).toBe('mvp')
    expect(slugFor('Old stuff', ['old-stuff'])).toBe('old-stuff-2')
    expect(slugFor('Old stuff', ['old-stuff', 'old-stuff-2'])).toBe('old-stuff-3')
    expect(slugFor('🚀', [])).toBe('folder')
    expect(slugFor('🚀', ['folder'])).toBe('folder-2')
    const long = slugFor('a'.repeat(64), ['a'.repeat(64)])
    expect(long.length).toBeLessThanOrEqual(64); expect(long.endsWith('-2')).toBe(true)
  })
})

describe('slugify - what the human types', () => {
  it.each([
    ['Old stuff', 'old-stuff'],
    ['  Research  2026 ', 'research-2026'],
    ['A__b--c', 'a-b-c'],
    ['---', ''],
    ['✨ Ideas!', 'ideas'],
    ['-lead', 'lead'],
  ])('%j → %j', (raw, slug) => expect(slugify(raw)).toBe(slug))
  it('never ends in a dash after the 64-char cut, and is on-grammar or empty', () => {
    const s = slugify('a'.repeat(63) + '-bcdef')
    expect(s.length).toBeLessThanOrEqual(64)
    expect(s.endsWith('-')).toBe(false)
    expect(s).toBe('a'.repeat(63))
  })
})

describe('mutations', () => {
  const tree = () => T(['a', { folder: 'f', boards: ['x', 'y'] }, 'b'])
  it('moveBoard into a folder appends; to the root inserts at the slot; a missing board is null', () => {
    expect(toWire(moveBoard(tree(), 'a', 'f')!)).toEqual([{ folder: 'f', boards: ['x', 'y', 'a'] }, 'b'])
    expect(toWire(moveBoard(tree(), 'x', null, 1)!)).toEqual(['a', 'x', { folder: 'f', boards: ['y'] }, 'b'])
    expect(toWire(moveBoard(tree(), 'x', null)!)).toEqual(['a', { folder: 'f', boards: ['y'] }, 'b', 'x'])
    expect(moveBoard(tree(), 'ghost', 'f')).toBeNull()
    expect(moveBoard(tree(), 'a', 'nope')).toBeNull()
  })
  it('createFolder takes the board out of wherever it sat; refuses a taken name', () => {
    expect(toWire(createFolder(tree(), 'g', 0, 'y')!)).toEqual([{ folder: 'g', boards: ['y'] }, 'a', { folder: 'f', boards: ['x'] }, 'b'])
    expect(toWire(createFolder(tree(), 'g', 99)!)).toEqual(['a', { folder: 'f', boards: ['x', 'y'] }, 'b', { folder: 'g', boards: [] }])
    expect(createFolder(tree(), 'f', 0)).toBeNull()
  })
  it('newFolderSlot: a root board gives its own slot, a foldered board the slot after its folder', () => {
    expect(newFolderSlot(tree(), 'b')).toBe(2)
    expect(newFolderSlot(tree(), 'y')).toBe(2)
  })
  it('retitleFolder sets or clears the title; the slug and the boards never move; a new folder can carry one', () => {
    expect(retitleFolder(tree(), 'f', 'F!')![1]).toEqual({ kind: 'folder', name: 'f', boards: ['x', 'y'], title: 'F!' })
    expect(retitleFolder(retitleFolder(tree(), 'f', 'F!')!, 'f', '')![1]).toEqual({ kind: 'folder', name: 'f', boards: ['x', 'y'] })
    expect(retitleFolder(tree(), 'nope', 'x')).toBeNull()
    expect(createFolder(tree(), 'ui', 0, undefined, 'UI')![0]).toEqual({ kind: 'folder', name: 'ui', boards: [], title: 'UI' })
  })
  it('deleteFolder puts the boards back at the root in its slot, in order', () => {
    expect(toWire(deleteFolder(tree(), 'f')!)).toEqual(['a', 'x', 'y', 'b'])
    expect(deleteFolder(tree(), 'nope')).toBeNull()
  })
})

describe('resolveDrop - the gap model over the rendered rows', () => {
  // a  |  f: [x, y]  |  b  |  all-scenes   (f expanded) - rows 28px tall, 1px apart, from y=100, left edge 10
  const tree = () => T(['a', { folder: 'f', boards: ['x', 'y'] }, 'b'])
  const H = 28, GAP = 1, TOP = 100, LEFT = 10
  /** The rows the sidebar would render for a tree: headers, the boards of OPEN folders, all-scenes last. */
  const layout = (t: TreeItem[], closed: string[] = []): Row[] => {
    const rows: Row[] = []
    const push = (kind: Row['kind'], name: string, parent: string | null, open?: boolean) => {
      const top = TOP + rows.length * (H + GAP)
      rows.push({ kind, name, parent, open, top, bottom: top + H, left: LEFT })
    }
    for (const it of t) {
      if (it.kind === 'board') { push('board', it.name, null); continue }
      const open = !closed.includes(it.name)
      push('folder', it.name, null, open)
      if (open) for (const b of it.boards) push('board', b, it.name)
    }
    push('board', 'all-scenes', null)
    return rows
  }
  const rowY = (rows: Row[], name: string, frac: number) => { const r = rows.find((x) => x.name === name)!; return r.top + (r.bottom - r.top) * frac }
  const board = { kind: 'board' as const, name: 'b' }
  const folder = { kind: 'folder' as const, name: 'f' }
  const ICON = LEFT + 12, LABEL = LEFT + 40   // where a root row is grabbed: its icon (inside the child indent), its label

  it('a board over root rows: the nearest gap by midline - upper half = before, lower half = after', () => {
    const rows = layout(tree())
    expect(resolveDrop(tree(), board, rows, LABEL, rowY(rows, 'a', 0.2))).toEqual({ list: null, index: 0 })
    expect(resolveDrop(tree(), board, rows, LABEL, rowY(rows, 'a', 0.8))).toEqual({ list: null, index: 1 })
    expect(resolveDrop(tree(), board, rows, ICON, rowY(rows, 'a', 0.8))).toEqual({ list: null, index: 1 })   // x never matters at an unambiguous gap
  })
  it('a board over a folder header: top quarter = before it, middle = into it, bottom quarter = first inside', () => {
    const rows = layout(tree())
    expect(resolveDrop(tree(), board, rows, LABEL, rowY(rows, 'f', 0.1))).toEqual({ list: null, index: 1 })
    expect(resolveDrop(tree(), board, rows, LABEL, rowY(rows, 'f', 0.5))).toEqual({ into: 'f' })
    expect(resolveDrop(tree(), board, rows, ICON, rowY(rows, 'f', 0.9))).toEqual({ list: 'f', index: 0 })
  })
  it('the field bug: a root board grabbed by its ICON and dragged between two folder boards lands between them', () => {
    const rows = layout(tree())
    expect(resolveDrop(tree(), { kind: 'board', name: 'a' }, rows, ICON, rowY(rows, 'x', 0.8))).toEqual({ list: 'f', index: 1 })
    expect(resolveDrop(tree(), { kind: 'board', name: 'a' }, rows, ICON, rowY(rows, 'y', 0.2))).toEqual({ list: 'f', index: 1 })
    expect(resolveDrop(tree(), { kind: 'board', name: 'a' }, rows, ICON, rowY(rows, 'x', 0.2))).toEqual({ list: 'f', index: 0 })
  })
  it('after a folder’s LAST board the gap is shared: over that board = inside (the gutter = root); over the root row below = root', () => {
    const rows = layout(tree())
    expect(resolveDrop(tree(), { kind: 'board', name: 'a' }, rows, LEFT + INDENT, rowY(rows, 'y', 0.8))).toEqual({ list: 'f', index: 2 })
    expect(resolveDrop(tree(), { kind: 'board', name: 'a' }, rows, LEFT + INDENT - 1, rowY(rows, 'y', 0.8))).toEqual({ list: null, index: 2 })
    // the same gap seen from the row below it (b's upper half) is the root, wherever x is
    expect(resolveDrop(tree(), { kind: 'board', name: 'a' }, rows, LABEL, rowY(rows, 'b', 0.2))).toEqual({ list: null, index: 2 })
    expect(resolveDrop(tree(), { kind: 'board', name: 'a' }, rows, ICON, rowY(rows, 'b', 0.2))).toEqual({ list: null, index: 2 })
    // a folder's last board dragged onto the root row under it leaves the folder (the second field bug)
    expect(resolveDrop(tree(), { kind: 'board', name: 'y' }, rows, LABEL, rowY(rows, 'b', 0.2))).toEqual({ list: null, index: 2 })
  })
  it('a closed folder: its lower band is into it; the gap after it is root (nothing to slot into)', () => {
    const rows = layout(tree(), ['f'])
    expect(resolveDrop(tree(), board, rows, LABEL, rowY(rows, 'f', 0.9))).toEqual({ into: 'f' })
    expect(resolveDrop(tree(), board, rows, LABEL, rowY(rows, 'f', 0.1))).toEqual({ list: null, index: 1 })
    expect(resolveDrop(tree(), { kind: 'board', name: 'a' }, rows, LABEL, rowY(rows, 'b', 0.2))).toEqual({ list: null, index: 2 })
  })
  it('an open EMPTY folder: its lower band = inside at 0 (the gutter = after it); the root row below = after it', () => {
    const t = T(['a', { folder: 'e', boards: [] }, 'b'])
    const rows = layout(t)
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'e', 0.9))).toEqual({ list: 'e', index: 0 })
    expect(resolveDrop(t, board, rows, ICON, rowY(rows, 'e', 0.9))).toEqual({ list: null, index: 2 })
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'b', 0.2))).toEqual({ list: null, index: 2 })
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'e', 0.5))).toEqual({ into: 'e' })
  })
  it('the ends clamp: above the first row = root 0, over or under all-scenes = root end', () => {
    const rows = layout(tree())
    expect(resolveDrop(tree(), board, rows, LABEL, TOP - 40)).toEqual({ list: null, index: 0 })
    expect(resolveDrop(tree(), { kind: 'board', name: 'a' }, rows, LABEL, rowY(rows, 'all-scenes', 0.9))).toEqual({ list: null, index: 3 })
    expect(resolveDrop(tree(), { kind: 'board', name: 'a' }, rows, LABEL, rowY(rows, 'all-scenes', 0.9) + 300)).toEqual({ list: null, index: 3 })
  })
  it('a folder lands in root gaps only, each root item one block: never into, never between a folder’s boards', () => {
    const rows = layout(tree())
    expect(resolveDrop(tree(), folder, rows, LABEL, rowY(rows, 'a', 0.2))).toEqual({ list: null, index: 0 })
    expect(resolveDrop(tree(), folder, rows, LABEL, rowY(rows, 'x', 0.4))).toEqual({ list: null, index: 1 })   // still in its own block's upper half (the block spans header + x + y)
    expect(resolveDrop(tree(), folder, rows, LABEL, rowY(rows, 'y', 0.9))).toEqual({ list: null, index: 2 })
    expect(resolveDrop(tree(), folder, rows, LABEL, rowY(rows, 'all-scenes', 0.9))).toEqual({ list: null, index: 3 })
    const g = { kind: 'folder' as const, name: 'g' }
    expect(resolveDrop([...tree(), F('g', [])], g, layout([...tree(), F('g', [])]), LABEL, rowY(rows, 'f', 0.5))).toEqual({ list: null, index: 1 })
  })
  it('the terminal folder: over all-scenes (either half) or the tail = the root end, wherever x is; its own last board only from its lower band', () => {
    const t = T(['a', { folder: 'f', boards: ['x'] }])
    const rows = layout(t)
    for (const x of [ICON, LABEL, LEFT + 180]) {
      expect(resolveDrop(t, { kind: 'board', name: 'a' }, rows, x, rowY(rows, 'all-scenes', 0.2))).toEqual({ list: null, index: 2 })
      expect(resolveDrop(t, { kind: 'board', name: 'a' }, rows, x, rowY(rows, 'all-scenes', 0.8))).toEqual({ list: null, index: 2 })
      expect(resolveDrop(t, { kind: 'board', name: 'a' }, rows, x, rowY(rows, 'all-scenes', 0.8) + 500)).toEqual({ list: null, index: 2 })
    }
    expect(resolveDrop(t, { kind: 'board', name: 'a' }, rows, LABEL, rowY(rows, 'x', 0.8))).toEqual({ list: 'f', index: 1 })
    expect(resolveDrop(t, { kind: 'board', name: 'a' }, rows, ICON, rowY(rows, 'x', 0.8))).toEqual({ list: null, index: 2 })
    // the header bands exactly: 25% is into, just under it is before; 75% is the first slot inside, just under it is into
    expect(resolveDrop(t, { kind: 'board', name: 'a' }, rows, LABEL, rowY(rows, 'f', 0.25))).toEqual({ into: 'f' })
    expect(resolveDrop(t, { kind: 'board', name: 'a' }, rows, LABEL, rowY(rows, 'f', 0.25) - 1)).toEqual({ list: null, index: 1 })
    expect(resolveDrop(t, { kind: 'board', name: 'a' }, rows, LABEL, rowY(rows, 'f', 0.75))).toEqual({ list: 'f', index: 0 })
    expect(resolveDrop(t, { kind: 'board', name: 'a' }, rows, LABEL, rowY(rows, 'f', 0.75) - 1)).toEqual({ into: 'f' })
  })
  it('two folders in a row, the first empty: the gap between them belongs to the row under the pointer', () => {
    const t = T([{ folder: 'e', boards: [] }, { folder: 'g', boards: ['z'] }, 'b'])
    const rows = layout(t)
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'e', 0.9))).toEqual({ list: 'e', index: 0 })       // e's lower band: inside e
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'g', 0.1))).toEqual({ list: null, index: 1 })      // g's top band: before g, at the root
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'g', 0.9))).toEqual({ list: 'g', index: 0 })
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'z', 0.9))).toEqual({ list: 'g', index: 1 })
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'b', 0.1))).toEqual({ list: null, index: 2 })
  })
  it('rows the tree no longer has (a stale render) resolve to null, never to a guess', () => {
    const rows = layout(T(['a', { folder: 'f', boards: ['x', 'y'] }, 'ghost', 'b']))
    expect(resolveDrop(tree(), board, rows, LABEL, rowY(rows, 'ghost', 0.8))).toBeNull()
  })
  it('SWEEP: every point inside the list resolves, applies, and moves monotonically down the list as y grows', () => {
    const t = T(['a', { folder: 'f', boards: ['x', 'y'] }, { folder: 'e', boards: [] }, 'b', { folder: 'c', boards: ['z'] }])
    for (const closed of [[], ['c'], ['f', 'c']]) {
      const rows = layout(t, closed)
      const bottom = rows[rows.length - 1]!.bottom
      const drags = [{ kind: 'board', name: 'a' }, { kind: 'board', name: 'x' }, { kind: 'board', name: 'y' }, { kind: 'board', name: 'b' }, { kind: 'board', name: 'z' }, { kind: 'folder', name: 'f' }, { kind: 'folder', name: 'c' }] as const
      for (const d of drags) for (const x of [ICON, LABEL, LEFT + 180]) {
        let lastPos = -1
        for (let y = TOP - 20; y <= bottom + 20; y += 2) {
          const target = resolveDrop(t, d, rows, x, y)
          expect(target, `${d.kind} ${d.name} at x=${x} y=${y} closed=${closed}`).not.toBeNull()
          if (target && 'into' in target) { expect(d.kind).toBe('board'); expect(rows.find((r) => r.kind === 'folder' && r.name === target.into && y >= r.top && y < r.bottom)).toBeTruthy(); continue }
          if (isOwnSlot(t, d, target!)) continue
          const next = applyDrop(t, d, target!)
          expect(next, `apply ${d.kind} ${d.name} → ${JSON.stringify(target)}`).not.toBeNull()
          expect(flatten(next!).sort()).toEqual(flatten(t).sort())
          // where the item ended up, as a position down the rendered list (folders by their header)
          const listOf = (tree: TreeItem[]) => tree.flatMap((it) => (it.kind === 'board' ? [it.name] : [`f:${it.name}`, ...it.boards]))
          const pos = listOf(next!).indexOf(d.kind === 'folder' ? `f:${d.name}` : d.name)
          expect(pos, `${d.kind} ${d.name} x=${x} y=${y} went up (${lastPos} → ${pos}) closed=${closed}`).toBeGreaterThanOrEqual(lastPos)
          lastPos = pos
        }
      }
    }
  })
})

describe('isOwnSlot + applyDrop - every boundary', () => {
  // a  |  f: [x, y]  |  b  |  all-scenes   (f expanded)
  const tree = () => T(['a', { folder: 'f', boards: ['x', 'y'] }, 'b'])
  const board = { kind: 'board' as const, name: 'b' }
  const folder = { kind: 'folder' as const, name: 'f' }
  it('own slots: the item’s slot and the one after it; into its own folder only when already last', () => {
    expect(isOwnSlot(tree(), board, { list: null, index: 2 })).toBe(true)
    expect(isOwnSlot(tree(), board, { list: null, index: 3 })).toBe(true)
    expect(isOwnSlot(tree(), board, { list: null, index: 0 })).toBe(false)
    expect(isOwnSlot(tree(), folder, { list: null, index: 1 })).toBe(true)
    expect(isOwnSlot(tree(), folder, { list: null, index: 2 })).toBe(true)
    expect(isOwnSlot(tree(), folder, { list: null, index: 0 })).toBe(false)
    expect(isOwnSlot(tree(), { kind: 'board', name: 'y' }, { into: 'f' })).toBe(true)    // already last
    expect(isOwnSlot(tree(), { kind: 'board', name: 'x' }, { into: 'f' })).toBe(false)   // moves to the end
    expect(isOwnSlot(tree(), { kind: 'board', name: 'x' }, { list: 'f', index: 1 })).toBe(true)
    expect(isOwnSlot(tree(), folder, { into: 'f' })).toBe(true)                           // a folder never goes into one
  })
  it('applyDrop: root moves account for the removed slot; into appends; cross-list keeps the index', () => {
    expect(toWire(applyDrop(tree(), board, { list: null, index: 0 })!)).toEqual(['b', 'a', { folder: 'f', boards: ['x', 'y'] }])
    expect(toWire(applyDrop(tree(), { kind: 'board', name: 'a' }, { list: null, index: 3 })!)).toEqual([{ folder: 'f', boards: ['x', 'y'] }, 'b', 'a'])
    expect(toWire(applyDrop(tree(), board, { into: 'f' })!)).toEqual(['a', { folder: 'f', boards: ['x', 'y', 'b'] }])
    expect(toWire(applyDrop(tree(), { kind: 'board', name: 'x' }, { into: 'f' })!)).toEqual(['a', { folder: 'f', boards: ['y', 'x'] }, 'b'])
    expect(toWire(applyDrop(tree(), board, { list: 'f', index: 1 })!)).toEqual(['a', { folder: 'f', boards: ['x', 'b', 'y'] }])
    expect(toWire(applyDrop(tree(), { kind: 'board', name: 'y' }, { list: 'f', index: 0 })!)).toEqual(['a', { folder: 'f', boards: ['y', 'x'] }, 'b'])
    expect(toWire(applyDrop(tree(), { kind: 'board', name: 'x' }, { list: null, index: 2 })!)).toEqual(['a', { folder: 'f', boards: ['y'] }, 'x', 'b'])
    expect(toWire(applyDrop(tree(), folder, { list: null, index: 3 })!)).toEqual(['a', 'b', { folder: 'f', boards: ['x', 'y'] }])
    expect(toWire(applyDrop(tree(), folder, { list: null, index: 0 })!)).toEqual([{ folder: 'f', boards: ['x', 'y'] }, 'a', 'b'])
    expect(applyDrop(tree(), folder, { into: 'f' })).toBeNull()
    expect(applyDrop(tree(), board, { into: 'ghost' })).toBeNull()
  })
})

describe('the published bundle', () => {
  it('publishedTree: folders over the published boards only, a private-only folder drops out, names follow the tree, all-scenes last', async () => {
    const { publishedTree } = await import('../src/server/build.ts')
    const all = {
      overview: { order: 1 }, deck: { order: 0, folder: 'decks' }, secret: { order: 0, folder: 'private' }, notes: { order: 2, folder: 'decks' },
    }
    const reg = [{ name: 'private', order: 0 }, { name: 'decks', order: 2 }]
    const { tree, names } = publishedTree(['overview', 'deck', 'notes', 'all-scenes'], all, reg)
    expect(tree).toEqual([B('overview'), F('decks', ['deck', 'notes'])])
    expect(names).toEqual(['overview', 'deck', 'notes', 'all-scenes'])
    expect(JSON.stringify(tree)).not.toContain('private')
    expect(JSON.stringify(tree)).not.toContain('secret')
    // a folder ranked first makes its first board the landing
    expect(publishedTree(['overview', 'deck'], all, [{ name: 'decks', order: 0 }]).names[0]).toBe('deck')
  })
})
