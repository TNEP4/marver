import { describe, expect, it } from 'vitest'
import {
  applyDrop, buildTree, createFolder, deleteFolder, flatten, fromWire, isOwnSlot, moveBoard, newFolderSlot, parseFolders, renameFolder, resolveDrop, slugify, toWire, validateWire,
  type Hit, type TreeItem,
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
  it('reads rows, ignores a missing order', () => {
    expect(parseFolders({ version: 1, folders: [{ name: 'a', order: 2 }, { name: 'b' }] })).toEqual([{ name: 'a', order: 2 }, { name: 'b' }])
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
  it('round-trips', () => {
    const tree = [B('a'), F('f', ['x', 'y']), B('b')]
    expect(fromWire(toWire(tree))).toEqual(tree)
    expect(toWire(tree)).toEqual(['a', { folder: 'f', boards: ['x', 'y'] }, 'b'])
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
  it('renameFolder keeps the boards; refuses a taken name', () => {
    expect(toWire(renameFolder(tree(), 'f', 'g')!)).toEqual(['a', { folder: 'g', boards: ['x', 'y'] }, 'b'])
    expect(renameFolder([...tree(), F('g', [])], 'f', 'g')).toBeNull()
  })
  it('deleteFolder puts the boards back at the root in its slot, in order', () => {
    expect(toWire(deleteFolder(tree(), 'f')!)).toEqual(['a', 'x', 'y', 'b'])
    expect(deleteFolder(tree(), 'nope')).toBeNull()
  })
})

describe('resolveDrop + isOwnSlot + applyDrop - every boundary', () => {
  // a  |  f: [x, y]  |  b  |  all-scenes   (f expanded)
  const tree = () => T(['a', { folder: 'f', boards: ['x', 'y'] }, 'b'])
  const hit = (h: Partial<Hit> & Pick<Hit, 'kind' | 'name'>): Hit => ({ parent: null, below: false, topEdge: false, gutter: false, ...h })
  const board = { kind: 'board' as const, name: 'b' }
  const folder = { kind: 'folder' as const, name: 'f' }

  it('a board over root rows: halves give the slot before/after', () => {
    expect(resolveDrop(tree(), board, hit({ kind: 'board', name: 'a' }))).toEqual({ list: null, index: 0 })
    expect(resolveDrop(tree(), board, hit({ kind: 'board', name: 'a', below: true }))).toEqual({ list: null, index: 1 })
  })
  it('a board over a folder header: the top edge = before it, the rest = into it', () => {
    expect(resolveDrop(tree(), board, hit({ kind: 'folder', name: 'f', topEdge: true }))).toEqual({ list: null, index: 1 })
    expect(resolveDrop(tree(), board, hit({ kind: 'folder', name: 'f', below: true }))).toEqual({ into: 'f' })
  })
  it('a board over a folder child: halves give the slot inside; the root gutter = after the folder', () => {
    expect(resolveDrop(tree(), board, hit({ kind: 'board', name: 'x', parent: 'f' }))).toEqual({ list: 'f', index: 0 })
    expect(resolveDrop(tree(), board, hit({ kind: 'board', name: 'y', parent: 'f', below: true }))).toEqual({ list: 'f', index: 2 })
    expect(resolveDrop(tree(), board, hit({ kind: 'board', name: 'y', parent: 'f', gutter: true }))).toEqual({ list: null, index: 2 })
  })
  it('over all-scenes = the root end slot; an unknown row = null', () => {
    expect(resolveDrop(tree(), board, hit({ kind: 'board', name: 'all-scenes' }))).toEqual({ list: null, index: 3 })
    expect(resolveDrop(tree(), board, hit({ kind: 'board', name: 'ghost' }))).toBeNull()
    expect(resolveDrop(tree(), board, hit({ kind: 'folder', name: 'ghost' }))).toBeNull()
  })
  it('a folder lands in root slots only: never into a folder, children mean "after that folder"', () => {
    expect(resolveDrop(tree(), folder, hit({ kind: 'board', name: 'a' }))).toEqual({ list: null, index: 0 })
    expect(resolveDrop(tree(), folder, hit({ kind: 'folder', name: 'f', below: true }))).toEqual({ list: null, index: 2 })
    expect(resolveDrop(tree(), folder, hit({ kind: 'board', name: 'x', parent: 'f' }))).toEqual({ list: null, index: 2 })
    expect(resolveDrop([...tree(), F('g', [])], folder, hit({ kind: 'folder', name: 'g' }))).toEqual({ list: null, index: 3 })
  })
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
