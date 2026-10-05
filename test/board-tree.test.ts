import { describe, expect, it } from 'vitest'
import {
  applyDrop, buildTree, createFolder, deleteFolder, flatten, fromWire, holdsFolders, INDENT, isOwnSlot, moveBoard, moveFolderToRoot, newFolderSlot, parseFolders, readTitle, resolveDrop, retitleFolder, slugFor, slugify, toWire, validateWire,
  type Row, type TreeItem,
} from '../src/shared/board-tree.ts'

// The sidebar's folder tree is pure and MANDATORY-tested here: ranking, the wire contract, every
// mutation, and the drop resolver at each boundary. The browser suite proves the pointer gesture
// and the files on top of this; it is Chrome-optional, this is not.

const T = (wire: Parameters<typeof fromWire>[0]) => fromWire(wire)
const B = (name: string): TreeItem => ({ kind: 'board', name })
/** A folder; plain strings are its boards, items pass through (a sub-folder). */
const F = (name: string, items: (string | TreeItem)[]): TreeItem => ({ kind: 'folder', name, items: items.map((k) => (typeof k === 'string' ? B(k) : k)) })

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
    expect(buildTree([{ name: 'x', folder: 'ui' }], [{ name: 'ui', title: 'UI' }])).toEqual([{ ...F('ui', ['x']), title: 'UI' }])
  })
  it('names what is wrong instead of reading an empty registry', () => {
    expect(typeof parseFolders(null)).toBe('string')
    expect(typeof parseFolders([])).toBe('string')
    expect(typeof parseFolders({ version: 3, folders: [] })).toBe('string')
    expect(typeof parseFolders({ folders: 'x' })).toBe('string')
    expect(typeof parseFolders({ folders: [{ name: 'Bad Name' }] })).toBe('string')
    expect(typeof parseFolders({ folders: [{ name: 'a' }, { name: 'a' }] })).toBe('string')
  })
})

describe('the wire contract', () => {
  it('round-trips; a folder title rides the wire (it lives in the registry the write rewrites)', () => {
    const tree = [B('a'), F('f', ['x', 'y']), B('b')]
    expect(fromWire(toWire(tree))).toEqual(tree)
    expect(toWire(tree)).toEqual(['a', { folder: 'f', items: ['x', 'y'] }, 'b'])
    const titled: TreeItem[] = [{ kind: 'folder', name: 'ui', items: [], title: 'UI', description: 'd' }]
    expect(toWire(titled)).toEqual([{ folder: 'ui', items: [], title: 'UI', description: 'd' }])
    expect(fromWire(toWire(titled))).toEqual(titled)
    expect(validateWire([{ folder: 'ui', items: [], title: 'UI 🚀' }])).toBeNull()
    expect(validateWire([{ folder: 'ui', items: [], title: 'x'.repeat(121) }])).toMatch(/title/)
    expect(validateWire([{ folder: 'ui', items: [], title: 5 }])).toMatch(/title/)
  })
  it('validateWire refuses every malformed shape and accepts the sound one', () => {
    expect(validateWire(['a', { folder: 'f', items: ['x'] }])).toBeNull()
    expect(validateWire([])).toBeNull()
    expect(validateWire('a')).toMatch(/invalid/)
    expect(validateWire(['all-scenes'])).toMatch(/invalid board/)
    expect(validateWire([{ folder: 'f', items: ['all-scenes'] }])).toMatch(/invalid board/)
    expect(validateWire(['a', 'a'])).toMatch(/twice/)
    expect(validateWire(['a', { folder: 'f', items: ['a'] }])).toMatch(/twice/)
    expect(validateWire([{ folder: 'f', items: [] }, { folder: 'f', items: [] }])).toMatch(/twice/)
    expect(validateWire([{ folder: 'f', items: [{ folder: 'g', items: [{ folder: 'h', items: [] }] }] }])).toMatch(/one level/)   // three levels
    expect(validateWire([{ folder: 'Bad', items: [] }])).toMatch(/invalid folder/)
    expect(validateWire([{ folder: 'f' }])).toMatch(/invalid folder/)
    expect(validateWire([null])).toMatch(/invalid/)
    expect(validateWire(Array.from({ length: 51 }, (_, i) => ({ folder: `f${i}`, items: [] })))).toMatch(/too large/)
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
  const tree = () => T(['a', { folder: 'f', items: ['x', 'y'] }, 'b'])
  it('moveBoard into a folder appends; to the root inserts at the slot; a missing board is null', () => {
    expect(toWire(moveBoard(tree(), 'a', 'f')!)).toEqual([{ folder: 'f', items: ['x', 'y', 'a'] }, 'b'])
    expect(toWire(moveBoard(tree(), 'x', null, 1)!)).toEqual(['a', 'x', { folder: 'f', items: ['y'] }, 'b'])
    expect(toWire(moveBoard(tree(), 'x', null)!)).toEqual(['a', { folder: 'f', items: ['y'] }, 'b', 'x'])
    expect(moveBoard(tree(), 'ghost', 'f')).toBeNull()
    expect(moveBoard(tree(), 'a', 'nope')).toBeNull()
  })
  it('createFolder takes the board out of wherever it sat; refuses a taken name', () => {
    expect(toWire(createFolder(tree(), 'g', 0, 'y')!)).toEqual([{ folder: 'g', items: ['y'] }, 'a', { folder: 'f', items: ['x'] }, 'b'])
    expect(toWire(createFolder(tree(), 'g', 99)!)).toEqual(['a', { folder: 'f', items: ['x', 'y'] }, 'b', { folder: 'g', items: [] }])
    expect(createFolder(tree(), 'f', 0)).toBeNull()
  })
  it('newFolderSlot: the board’s own slot at its own level - a root board at the root, a foldered board inside its folder', () => {
    expect(newFolderSlot(tree(), 'b')).toEqual({ parent: null, index: 2 })
    expect(newFolderSlot(tree(), 'y')).toEqual({ parent: 'f', index: 1 })
  })
  it('retitleFolder sets or clears the title; the slug and the boards never move; a new folder can carry one', () => {
    expect(retitleFolder(tree(), 'f', 'F!')![1]).toEqual({ ...F('f', ['x', 'y']), title: 'F!' })
    expect(retitleFolder(retitleFolder(tree(), 'f', 'F!')!, 'f', '')![1]).toEqual(F('f', ['x', 'y']))
    expect(retitleFolder(tree(), 'nope', 'x')).toBeNull()
    expect(createFolder(tree(), 'ui', 0, undefined, 'UI')![0]).toEqual({ kind: 'folder', name: 'ui', items: [], title: 'UI' })
  })
  it('deleteFolder puts the boards back at the root in its slot, in order', () => {
    expect(toWire(deleteFolder(tree(), 'f')!)).toEqual(['a', 'x', 'y', 'b'])
    expect(deleteFolder(tree(), 'nope')).toBeNull()
  })
})

describe('resolveDrop - the gap model over the rendered rows', () => {
  // a  |  f: [x, y]  |  b  |  all-scenes   (f expanded) - rows 28px tall, 1px apart, from y=100, left edge 10
  const tree = () => T(['a', { folder: 'f', items: ['x', 'y'] }, 'b'])
  const H = 28, GAP = 1, TOP = 100, LEFT = 10
  /** The rows the sidebar would render for a tree: headers, the boards of OPEN folders, all-scenes last. */
  const layout = (t: TreeItem[], closed: string[] = []): Row[] => {
    const rows: Row[] = []
    const push = (kind: Row['kind'], name: string, parent: string | null, depth: number, open?: boolean) => {
      const top = TOP + rows.length * (H + GAP)
      rows.push({ kind, name, parent, depth, open, top, bottom: top + H, left: LEFT })
    }
    const walk = (items: TreeItem[], parent: string | null, depth: number) => {
      for (const it of items) {
        if (it.kind === 'board') { push('board', it.name, parent, depth); continue }
        const open = !closed.includes(it.name)
        push('folder', it.name, parent, depth, open)
        if (open) walk(it.items, it.name, depth + 1)
      }
    }
    walk(t, null, 0)
    push('board', 'all-scenes', null, 0)
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
    const t = T(['a', { folder: 'e', items: [] }, 'b'])
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
  it('a folder never lands inside itself: over its own rows it finds its own slot', () => {
    const rows = layout(tree())
    expect(resolveDrop(tree(), folder, rows, LABEL, rowY(rows, 'a', 0.2))).toEqual({ list: null, index: 0 })
    // over its own header or what it holds: always its own slot - nothing moves
    for (const at of [['f', 0.5], ['x', 0.4], ['y', 0.9]] as const) expect(isOwnSlot(tree(), folder, resolveDrop(tree(), folder, rows, LABEL, rowY(rows, at[0], at[1]))!)).toBe(true)
    expect(resolveDrop(tree(), folder, rows, LABEL, rowY(rows, 'all-scenes', 0.9))).toEqual({ list: null, index: 3 })
  })
  it('a folder without sub-folders can go INTO a top-level folder; one holding sub-folders moves between root blocks only', () => {
    const t = [...tree(), F('g', [])]
    const rows = layout(t)
    expect(resolveDrop(t, { kind: 'folder', name: 'g' }, rows, LABEL, rowY(rows, 'f', 0.5))).toEqual({ into: 'f' })
    expect(resolveDrop(t, { kind: 'folder', name: 'g' }, rows, LABEL, rowY(rows, 'x', 0.8))).toEqual({ list: 'f', index: 1 })
    const n = T(['a', { folder: 'f', items: ['x', 'y'] }, { folder: 'h', items: [{ folder: 's', items: [] }] }, 'b'])
    const nrows = layout(n)
    expect(resolveDrop(n, { kind: 'folder', name: 'h' }, nrows, LABEL, rowY(nrows, 'f', 0.5))).toEqual({ list: null, index: 1 })   // never into
    expect(resolveDrop(n, { kind: 'folder', name: 'h' }, nrows, LABEL, rowY(nrows, 'x', 0.2))).toEqual({ list: null, index: 1 })   // f's block, upper half: before f
    expect(resolveDrop(n, { kind: 'folder', name: 'h' }, nrows, LABEL, rowY(nrows, 'a', 0.2))).toEqual({ list: null, index: 0 })
  })
  it('the terminal folder: over all-scenes (either half) or the tail = the root end, wherever x is; its own last board only from its lower band', () => {
    const t = T(['a', { folder: 'f', items: ['x'] }])
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
    const t = T([{ folder: 'e', items: [] }, { folder: 'g', items: ['z'] }, 'b'])
    const rows = layout(t)
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'e', 0.9))).toEqual({ list: 'e', index: 0 })       // e's lower band: inside e
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'g', 0.1))).toEqual({ list: null, index: 1 })      // g's top band: before g, at the root
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'g', 0.9))).toEqual({ list: 'g', index: 0 })
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'z', 0.9))).toEqual({ list: 'g', index: 1 })
    expect(resolveDrop(t, board, rows, LABEL, rowY(rows, 'b', 0.1))).toEqual({ list: null, index: 2 })
  })
  it('rows the tree no longer has (a stale render) resolve to null, never to a guess', () => {
    const rows = layout(T(['a', { folder: 'f', items: ['x', 'y'] }, 'ghost', 'b']))
    expect(resolveDrop(tree(), board, rows, LABEL, rowY(rows, 'ghost', 0.8))).toBeNull()
  })
  it('SWEEP: every point inside the list resolves, applies, and moves monotonically down the list as y grows', () => {
    const t = T(['a', { folder: 'f', items: ['x', 'y'] }, { folder: 'e', items: [] }, 'b', { folder: 'c', items: ['z'] }])
    for (const closed of [[], ['c'], ['f', 'c']]) {
      const rows = layout(t, closed)
      const bottom = rows[rows.length - 1]!.bottom
      const drags = [{ kind: 'board', name: 'a' }, { kind: 'board', name: 'x' }, { kind: 'board', name: 'y' }, { kind: 'board', name: 'b' }, { kind: 'board', name: 'z' }, { kind: 'folder', name: 'f' }, { kind: 'folder', name: 'c' }] as const
      for (const d of drags) for (const x of [ICON, LABEL, LEFT + 180]) {
        let lastPos = -1
        for (let y = TOP - 20; y <= bottom + 20; y += 2) {
          const target = resolveDrop(t, d, rows, x, y)
          expect(target, `${d.kind} ${d.name} at x=${x} y=${y} closed=${closed}`).not.toBeNull()
          if (target && 'into' in target) { expect(target.into).not.toBe(d.name); expect(rows.find((r) => r.kind === 'folder' && r.name === target.into && y >= r.top && y < r.bottom)).toBeTruthy(); continue }
          if (isOwnSlot(t, d, target!)) continue
          const next = applyDrop(t, d, target!)
          expect(next, `apply ${d.kind} ${d.name} → ${JSON.stringify(target)}`).not.toBeNull()
          expect(flatten(next!).sort()).toEqual(flatten(t).sort())
          // where the item ended up, as a position down the rendered list (folders by their header)
          const listOf = (tree: TreeItem[]): string[] => tree.flatMap((it) => (it.kind === 'board' ? [it.name] : [`f:${it.name}`, ...listOf(it.items)]))
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
  const tree = () => T(['a', { folder: 'f', items: ['x', 'y'] }, 'b'])
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
    expect(isOwnSlot(tree(), folder, { into: 'f' })).toBe(false)                          // not a no-op - an impossible drop, refused below
  })
  it('applyDrop: root moves account for the removed slot; into appends; cross-list keeps the index', () => {
    expect(toWire(applyDrop(tree(), board, { list: null, index: 0 })!)).toEqual(['b', 'a', { folder: 'f', items: ['x', 'y'] }])
    expect(toWire(applyDrop(tree(), { kind: 'board', name: 'a' }, { list: null, index: 3 })!)).toEqual([{ folder: 'f', items: ['x', 'y'] }, 'b', 'a'])
    expect(toWire(applyDrop(tree(), board, { into: 'f' })!)).toEqual(['a', { folder: 'f', items: ['x', 'y', 'b'] }])
    expect(toWire(applyDrop(tree(), { kind: 'board', name: 'x' }, { into: 'f' })!)).toEqual(['a', { folder: 'f', items: ['y', 'x'] }, 'b'])
    expect(toWire(applyDrop(tree(), board, { list: 'f', index: 1 })!)).toEqual(['a', { folder: 'f', items: ['x', 'b', 'y'] }])
    expect(toWire(applyDrop(tree(), { kind: 'board', name: 'y' }, { list: 'f', index: 0 })!)).toEqual(['a', { folder: 'f', items: ['y', 'x'] }, 'b'])
    expect(toWire(applyDrop(tree(), { kind: 'board', name: 'x' }, { list: null, index: 2 })!)).toEqual(['a', { folder: 'f', items: ['y'] }, 'x', 'b'])
    expect(toWire(applyDrop(tree(), folder, { list: null, index: 3 })!)).toEqual(['a', 'b', { folder: 'f', items: ['x', 'y'] }])
    expect(toWire(applyDrop(tree(), folder, { list: null, index: 0 })!)).toEqual([{ folder: 'f', items: ['x', 'y'] }, 'a', 'b'])
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

describe('two levels - folders in folders', () => {
  // a  |  f: [x, s: [p, q], y]  |  b  |  all-scenes
  const tree = () => T(['a', { folder: 'f', items: ['x', { folder: 's', items: ['p', 'q'] }, 'y'] }, 'b'])

  it('parseFolders: a parent needs version 2, a known top-level folder, and never itself', () => {
    expect(parseFolders({ version: 2, folders: [{ name: 'f', order: 0 }, { name: 's', parent: 'f', order: 1 }] })).toEqual([{ name: 'f', order: 0 }, { name: 's', parent: 'f', order: 1 }])
    expect(parseFolders({ version: 2, folders: [{ name: 'f' }] })).toEqual([{ name: 'f' }])                                   // version 2 without nesting reads too
    expect(parseFolders({ version: 1, folders: [{ name: 'f' }, { name: 's', parent: 'f' }] })).toMatch(/version": 2/)
    expect(parseFolders({ folders: [{ name: 'f' }, { name: 's', parent: 'f' }] })).toMatch(/version": 2/)
    expect(parseFolders({ version: 2, folders: [{ name: 's', parent: 'ghost' }] })).toMatch(/unknown parent/)
    expect(parseFolders({ version: 2, folders: [{ name: 's', parent: 's' }] })).toMatch(/own parent/)
    expect(parseFolders({ version: 2, folders: [{ name: 'f' }, { name: 's', parent: 'f' }, { name: 't', parent: 's' }] })).toMatch(/three levels/)
    expect(parseFolders({ version: 2, folders: [{ name: 's', parent: 'Bad' }] })).toMatch(/invalid parent/)
  })
  it('buildTree: boards and sub-folders share their folder’s order; a sub-folder holds its boards; an implied folder is top-level', () => {
    const t = buildTree(
      [{ name: 'x', folder: 'f', order: 0 }, { name: 'y', folder: 'f', order: 2 }, { name: 'p', folder: 's', order: 1 }, { name: 'q', folder: 's', order: 0 }, { name: 'a', order: 0 }, { name: 'z', folder: 'loose' }],
      [{ name: 'f', order: 1 }, { name: 's', parent: 'f', order: 1 }],
    )
    expect(t).toEqual([B('a'), F('f', ['x', F('s', ['q', 'p']), 'y']), F('loose', ['z'])])
    expect(flatten(t)).toEqual(['a', 'x', 'q', 'p', 'y', 'z'])                              // depth-first: the landing board
  })
  it('buildTree stays total: a parent that is not a top-level folder leaves the child at the top', () => {
    expect(buildTree([], [{ name: 'f' }, { name: 's', parent: 'f' }, { name: 't', parent: 's' }])).toEqual([F('f', [F('s', [])]), F('t', [])])
  })
  it('the wire nests one level and reads the older one-level shape', () => {
    expect(toWire(tree())).toEqual(['a', { folder: 'f', items: ['x', { folder: 's', items: ['p', 'q'] }, 'y'] }, 'b'])
    expect(fromWire(toWire(tree()))).toEqual(tree())
    expect(validateWire(toWire(tree()))).toBeNull()
    expect(fromWire([{ folder: 'f', boards: ['x'] }] as never)).toEqual([F('f', ['x'])])
    expect(validateWire([{ folder: 'f', boards: ['x'] }])).toBeNull()
    expect(validateWire([{ folder: 'f', boards: [{ folder: 'g', boards: [] }] }])).toMatch(/invalid folder/)   // the old shape never nests
    expect(validateWire([{ folder: 'f', items: [{ folder: 'f', items: [] }] }])).toMatch(/twice/)
  })
  it('createFolder inside a top-level folder, never inside a sub-folder', () => {
    expect(toWire(createFolder(tree(), 'n', 1, undefined, undefined, 'f')!)).toEqual(['a', { folder: 'f', items: ['x', { folder: 'n', items: [] }, { folder: 's', items: ['p', 'q'] }, 'y'] }, 'b'])
    expect(toWire(createFolder(tree(), 'n', 0, 'y', undefined, 'f')!)).toEqual(['a', { folder: 'f', items: [{ folder: 'n', items: ['y'] }, 'x', { folder: 's', items: ['p', 'q'] }] }, 'b'])
    expect(createFolder(tree(), 'n', 0, undefined, undefined, 's')).toBeNull()
    expect(createFolder(tree(), 's', 0)).toBeNull()                                       // slugs are unique across both levels
  })
  it('deleteFolder moves what it held up one level, into its place, in order', () => {
    expect(toWire(deleteFolder(tree(), 's')!)).toEqual(['a', { folder: 'f', items: ['x', 'p', 'q', 'y'] }, 'b'])
    expect(toWire(deleteFolder(tree(), 'f')!)).toEqual(['a', 'x', { folder: 's', items: ['p', 'q'] }, 'y', 'b'])
  })
  it('moveFolderToRoot and Move to top level for a board, from either level', () => {
    expect(toWire(moveFolderToRoot(tree(), 's', 2)!)).toEqual(['a', { folder: 'f', items: ['x', 'y'] }, { folder: 's', items: ['p', 'q'] }, 'b'])
    expect(toWire(moveBoard(tree(), 'p', null, 2)!)).toEqual(['a', { folder: 'f', items: ['x', { folder: 's', items: ['q'] }, 'y'] }, 'p', 'b'])
    expect(toWire(moveBoard(tree(), 'a', 's')!)).toEqual([{ folder: 'f', items: ['x', { folder: 's', items: ['p', 'q', 'a'] }, 'y'] }, 'b'])
  })
  it('regression: a sub-folder wobbled over its OWN header stays put - never ejected to the root', () => {
    // f: [x, s: [p]] then b - s is f's last item
    const t = T(['a', { folder: 'f', items: ['x', { folder: 's', items: ['p'] }] }, 'b'])
    const rows = layout(t)
    const s = { kind: 'folder' as const, name: 's' }
    // wherever it was grabbed - at or right of its own indent - a wobble over its header is a no-op
    for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const x of [LEFT + INDENT + 6, LEFT + 2 * INDENT + 6, LEFT + 180]) {
      const target = resolveDrop(t, s, rows, x, rowY(rows, 's', frac))!
      expect(isOwnSlot(t, s, target), `s at frac=${frac} x=${x} → ${JSON.stringify(target)}`).toBe(true)
    }
    // pulled LEFT into the root gutter at the bottom of its folder: the existing gutter rule - out to the root
    expect(resolveDrop(t, s, rows, LEFT + 12, rowY(rows, 's', 0.9))).toEqual({ list: null, index: 2 })
  })
  it('regression: Move to top level with no slot appends at the end - the removal is not counted twice', () => {
    expect(toWire(moveFolderToRoot(T([{ folder: 'f', items: [] }, 'a', 'b']), 'f')!)).toEqual(['a', 'b', { folder: 'f', items: [] }])
    expect(toWire(moveFolderToRoot(T([{ folder: 'f', items: [] }, 'a', 'b']), 'f', 2)!)).toEqual(['a', { folder: 'f', items: [] }, 'b'])   // a slot measured before the removal does shift
    expect(toWire(moveFolderToRoot(tree(), 's')!)).toEqual(['a', { folder: 'f', items: ['x', 'y'] }, 'b', { folder: 's', items: ['p', 'q'] }])
  })
  it('holdsFolders: the root and a top-level folder hold folders; a sub-folder or a vanished folder does not', () => {
    expect(holdsFolders(tree(), null)).toBe(true)
    expect(holdsFolders(tree(), 'f')).toBe(true)
    expect(holdsFolders(tree(), 's')).toBe(false)
    expect(holdsFolders(tree(), 'gone')).toBe(false)
  })
  it('newFolderSlot: a board in a sub-folder gets the new folder right after that sub-folder', () => {
    expect(newFolderSlot(tree(), 'p')).toEqual({ parent: 'f', index: 2 })
    expect(newFolderSlot(tree(), 'x')).toEqual({ parent: 'f', index: 0 })
  })
  it('applyDrop: boards anywhere; a folder without sub-folders into a top-level folder; never three levels', () => {
    expect(toWire(applyDrop(tree(), { kind: 'board', name: 'b' }, { into: 's' })!)).toEqual(['a', { folder: 'f', items: ['x', { folder: 's', items: ['p', 'q', 'b'] }, 'y'] }])
    expect(toWire(applyDrop(tree(), { kind: 'board', name: 'q' }, { list: 's', index: 0 })!)).toEqual(['a', { folder: 'f', items: ['x', { folder: 's', items: ['q', 'p'] }, 'y'] }, 'b'])
    const g = [...tree(), F('g', ['z'])]
    expect(toWire(applyDrop(g, { kind: 'folder', name: 'g' }, { into: 'f' })!)).toEqual(['a', { folder: 'f', items: ['x', { folder: 's', items: ['p', 'q'] }, 'y', { folder: 'g', items: ['z'] }] }, 'b'])
    expect(toWire(applyDrop(g, { kind: 'folder', name: 'g' }, { list: 'f', index: 0 })!)).toEqual(['a', { folder: 'f', items: [{ folder: 'g', items: ['z'] }, 'x', { folder: 's', items: ['p', 'q'] }, 'y'] }, 'b'])
    expect(applyDrop(g, { kind: 'folder', name: 'g' }, { into: 's' })).toBeNull()            // a sub-folder holds boards only
    expect(applyDrop(g, { kind: 'folder', name: 'f' }, { into: 'g' })).toBeNull()            // f holds a sub-folder: root only
    expect(toWire(applyDrop(tree(), { kind: 'folder', name: 's' }, { list: null, index: 0 })!)).toEqual([{ folder: 's', items: ['p', 'q'] }, 'a', { folder: 'f', items: ['x', 'y'] }, 'b'])
  })

  // the drop resolver at two levels: rows 28px tall from y=100, left edge 10, INDENT per level
  const H = 28, GAP = 1, TOP = 100, LEFT = 10
  const layout = (t: TreeItem[], closed: string[] = []): Row[] => {
    const rows: Row[] = []
    const push = (kind: Row['kind'], name: string, parent: string | null, depth: number, open?: boolean) => {
      const top = TOP + rows.length * (H + GAP)
      rows.push({ kind, name, parent, depth, open, top, bottom: top + H, left: LEFT })
    }
    const walk = (items: TreeItem[], parent: string | null, depth: number) => {
      for (const it of items) {
        if (it.kind === 'board') { push('board', it.name, parent, depth); continue }
        const open = !closed.includes(it.name)
        push('folder', it.name, parent, depth, open)
        if (open) walk(it.items, it.name, depth + 1)
      }
    }
    walk(t, null, 0)
    push('board', 'all-scenes', null, 0)
    return rows
  }
  const rowY = (rows: Row[], name: string, frac: number) => { const r = rows.find((x) => x.name === name)!; return r.top + (r.bottom - r.top) * frac }
  const a = { kind: 'board' as const, name: 'a' }

  it('a board INTO a sub-folder header, and between a sub-folder’s boards', () => {
    const rows = layout(tree())
    expect(resolveDrop(tree(), a, rows, LEFT + 80, rowY(rows, 's', 0.5))).toEqual({ into: 's' })
    expect(resolveDrop(tree(), a, rows, LEFT + 80, rowY(rows, 'p', 0.8))).toEqual({ list: 's', index: 1 })
  })
  it('where a sub-folder ends inside its folder, the pointer’s indent picks the level - over the row below, its level', () => {
    // f: [x, s: [p, q]] then b - the gap after q is shared by s, f and the root
    const t = T(['a', { folder: 'f', items: ['x', { folder: 's', items: ['p', 'q'] }] }, 'b'])
    const rows = layout(t)
    const y = rowY(rows, 'q', 0.8)
    expect(resolveDrop(t, a, rows, LEFT + 2 * INDENT, y)).toEqual({ list: 's', index: 2 })
    expect(resolveDrop(t, a, rows, LEFT + INDENT, y)).toEqual({ list: 'f', index: 2 })
    expect(resolveDrop(t, a, rows, LEFT + 2, y)).toEqual({ list: null, index: 2 })
    expect(resolveDrop(t, a, rows, LEFT + 2 * INDENT, rowY(rows, 'b', 0.2))).toEqual({ list: null, index: 2 })
  })
  it('a folder never lands in a sub-folder: its header is not INTO, its boards are not slots', () => {
    const t = [...tree(), F('g', [])]
    const rows = layout(t)
    const g = { kind: 'folder' as const, name: 'g' }
    expect(resolveDrop(t, g, rows, LEFT + 80, rowY(rows, 's', 0.5))).not.toEqual({ into: 's' })
    const inside = resolveDrop(t, g, rows, LEFT + 80, rowY(rows, 'p', 0.8))!
    expect('into' in inside ? inside.into : inside.list).not.toBe('s')
  })
  it('SWEEP at two levels: every point resolves, applies, keeps every board, and moves down the list as y grows', () => {
    const t = T(['a', { folder: 'f', items: ['x', { folder: 's', items: ['p', 'q'] }, 'y'] }, { folder: 'e', items: [] }, 'b', { folder: 'c', items: [{ folder: 'u', items: [] }] }])
    const listOf = (tree: TreeItem[]): string[] => tree.flatMap((it) => (it.kind === 'board' ? [it.name] : [`f:${it.name}`, ...listOf(it.items)]))
    for (const closed of [[], ['s'], ['f', 'c']]) {
      const rows = layout(t, closed)
      const bottom = rows[rows.length - 1]!.bottom
      const drags = [
        { kind: 'board', name: 'a' }, { kind: 'board', name: 'p' }, { kind: 'board', name: 'y' }, { kind: 'board', name: 'b' },
        { kind: 'folder', name: 's' }, { kind: 'folder', name: 'e' }, { kind: 'folder', name: 'f' }, { kind: 'folder', name: 'u' },
      ] as const
      for (const d of drags) for (const x of [LEFT + 12, LEFT + INDENT + 4, LEFT + 2 * INDENT + 4, LEFT + 180]) {
        let lastPos = -1
        for (let y = TOP - 20; y <= bottom + 20; y += 2) {
          const target = resolveDrop(t, d, rows, x, y)
          expect(target, `${d.kind} ${d.name} at x=${x} y=${y} closed=${closed}`).not.toBeNull()
          if (isOwnSlot(t, d, target!)) continue
          const next = applyDrop(t, d, target!)
          expect(next, `apply ${d.kind} ${d.name} → ${JSON.stringify(target)}`).not.toBeNull()
          expect(flatten(next!).sort()).toEqual(flatten(t).sort())
          expect(validateWire(toWire(next!)), 'never three levels').toBeNull()
          if ('into' in target!) continue
          const pos = listOf(next!).indexOf(d.kind === 'folder' ? `f:${d.name}` : d.name)
          expect(pos, `${d.kind} ${d.name} x=${x} y=${y} went up (${lastPos} → ${pos}) closed=${closed}`).toBeGreaterThanOrEqual(lastPos)
          lastPos = pos
        }
      }
    }
  })
  it('publishedTree prunes at every depth: a sub-folder with no published board drops out, its parent with it when empty', async () => {
    const { publishedTree } = await import('../src/server/build.ts')
    const all = { deck: { folder: 'slides', order: 0 }, secret: { folder: 'hidden', order: 0 }, top: { order: 0 } }
    const reg = [{ name: 'work', order: 1 }, { name: 'slides', parent: 'work', order: 0 }, { name: 'hidden', parent: 'work', order: 1 }, { name: 'empty', order: 2 }]
    const { tree, names } = publishedTree(['deck', 'top'], all, reg)
    expect(tree).toEqual([B('top'), F('work', [F('slides', ['deck'])])])
    expect(names).toEqual(['top', 'deck'])
    expect(JSON.stringify(tree)).not.toContain('hidden')
  })
})

describe('two levels - what ships and what the manifest says', () => {
  it('publishedManifest keeps a published sub-folder AND its parent, never a private-only sub-folder', async () => {
    const { publishedManifest } = await import('../src/server/build.ts')
    const manifest = {
      scenes: [],
      folders: [{ name: 'work', title: 'Work' }, { name: 'slides', parent: 'work' }, { name: 'hidden', parent: 'work', description: 'secret stuff' }, { name: 'other' }],
      boards: [{ name: 'deck', folder: 'slides' }, { name: 'secret', folder: 'hidden' }, { name: 'loose', folder: 'other' }],
    } as never
    const m = publishedManifest(manifest, [], ['deck'], true)
    expect(m.folders).toEqual([{ name: 'work', title: 'Work' }, { name: 'slides', parent: 'work' }])
    expect(JSON.stringify(m)).not.toMatch(/hidden|secret|other/)
  })
  it('scanFrames: the manifest lists folders in reading order with `parent`, and each board with the folder it sits in', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { scanFrames } = await import('../src/server/manifest.ts')
    const root = mkdtempSync(join(tmpdir(), 'mv-manifest-nest-'))
    try {
      const dir = join(root, 'design', 'boards')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'x.json'), JSON.stringify({ version: 1, nodes: [], folder: 'features', order: 0 }))
      writeFileSync(join(dir, 'p.json'), JSON.stringify({ version: 1, nodes: [], folder: 'shipper', order: 0 }))
      writeFileSync(join(dir, '_folders.json'), JSON.stringify({ version: 2, folders: [{ name: 'features', order: 0 }, { name: 'shipper', parent: 'features', order: 1, title: 'Shipper' }] }))
      const m = scanFrames(root)
      expect(m.folders).toEqual([{ name: 'features' }, { name: 'shipper', parent: 'features', title: 'Shipper' }])
      expect(m.boards).toEqual([{ name: 'x', folder: 'features' }, { name: 'p', folder: 'shipper' }])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('a sub-folder renames like any folder; a new folder whose parent vanished mid-naming is refused, never misplaced', () => {
    const t = T(['a', { folder: 'f', items: [{ folder: 's', items: ['p'] }] }])
    expect(retitleFolder(t, 's', 'Shipper 🚚')![1]).toEqual(F('f', [{ kind: 'folder', name: 's', items: [B('p')], title: 'Shipper 🚚' }]))
    expect(createFolder(t, 'n', 0, undefined, undefined, 'gone')).toBeNull()
  })
})
