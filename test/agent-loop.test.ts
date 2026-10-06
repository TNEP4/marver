import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLog, appendEvents, replay } from '../src/server/comments.ts'
import { resolveLink } from '../src/cli/link.ts'
import { commentsCommand } from '../src/cli/comments.ts'
import { createActivity } from '../src/server/jam/activity.ts'
import { runningAgent } from '../src/server/jam/agent.ts'
import { localOnlyThreads } from '../src/server/sync.ts'
import { engagedThreads } from '../src/server/jam/watch.ts'

/**
 * The agent loop on the canvas: a link an agent can write (frame ids, not node keys), the board it
 * opens, and the notes and replies it leaves in Marver's voice.
 */

// hash.ts reads location at import (bootHash) - give it one, then load it
;(globalThis as any).location ??= { hash: '', search: '' }
const { parseHash, buildHash, linkTargets } = await import('../src/client/shell/hash.ts')

describe('links by frame id', () => {
  it('parses ?f= frame ids and ?s= scenes on a board link, and drops what is not an id', () => {
    expect(parseHash('#/b/flow?f=shop/cart,shop/pay&s=shop')).toEqual({ board: 'flow', f: ['shop/cart', 'shop/pay'], s: ['shop'] })
    expect(parseHash('#/b/flow?f=../etc,shop/ca rt,ok/x')).toEqual({ board: 'flow', f: ['ok/x'] })
    expect(parseHash('#/b/flow?s=..')).toEqual({ board: 'flow' })
    // n and c are untouched
    expect(parseHash('#/b/flow?n=k1,k2&c=th-1')).toEqual({ board: 'flow', n: ['k1', 'k2'], c: 'th-1' })
    // the shell's own projection keeps writing node keys
    expect(buildHash({ board: 'flow', n: ['k1'] })).toBe('#/b/flow?n=k1')
  })

  it('resolves to the node keys on the loaded board: frames, whole scenes, keys - each once, in board order', () => {
    const nodes = [
      { key: 'a', frame: 'shop/cart' }, { key: 'b', frame: 'shop/pay' }, { key: 'c', frame: 'shop/pay/a-card' },
      { key: 'd', frame: 'other/x' }, { key: 'e', frame: 'shop/gone', missing: true },
    ]
    expect(linkTargets({ f: ['shop/pay'] }, nodes)).toEqual(['b'])
    expect(linkTargets({ s: ['shop'] }, nodes)).toEqual(['a', 'b', 'c'])           // nested variants included, tombstones not
    expect(linkTargets({ f: ['other/x'], n: ['a'] }, nodes)).toEqual(['a', 'd'])
    expect(linkTargets({ n: ['e'] }, nodes)).toEqual(['e'])                        // a key asked by name is the shell's own - kept
    expect(linkTargets({ f: ['nowhere/y'] }, nodes)).toEqual([])
    expect(linkTargets({ s: ['sho'] }, nodes)).toEqual([])                         // a scene is a folder, not a prefix
  })
})

let root = ''
const frame = (title: string, body = '') => `export const meta = { title: '${title}', viewport: 'mobile' }\nexport default () => <main><h1>${title}</h1>${body}</main>\n`
const board = (name: string, extra: Record<string, unknown>, nodes: unknown[]) =>
  writeFileSync(join(root, 'design', 'boards', `${name}.json`), JSON.stringify({ version: 1, name, auto: false, ...extra, nodes }, null, 2) + '\n')

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mv-agent-loop-'))
  for (const [scene, files] of Object.entries({ shop: ['cart', 'pay'], other: ['far'], old: ['cart'], 'shop/wallet': ['a-card', 'b-apple'] })) {
    mkdirSync(join(root, 'design', 'scenes', scene), { recursive: true })
    for (const f of files) writeFileSync(join(root, 'design', 'scenes', scene, `${f}.tsx`), frame(f, '<p>Pay now with card</p>'))
  }
  mkdirSync(join(root, 'design', 'boards'), { recursive: true })
  // the archive ranks FIRST by order - and still loses to a feature board that shows the frame
  board('archive', { order: 0, type: 'archive' }, [{ frame: 'shop/cart' }, { frame: 'shop/pay' }, { frame: 'old/cart' }])
  board('cart-only', { order: 1 }, [{ frame: 'shop/cart', key: 'k-cart' }])
  board('flow', { order: 2 }, [{ frame: 'shop/cart', key: 'f-cart' }, { frame: 'shop/pay', key: 'f-pay' }, { frame: 'shop/wallet/a-card' }, { frame: 'shop/wallet/b-apple' }])
  // an archive by its folder, not its own type - ranked last all the same
  board('old-flow', { order: 0, folder: 'history' }, [{ frame: 'other/far' }])
  board('far-live', { order: 5 }, [{ frame: 'other/far' }])
  writeFileSync(join(root, 'design', 'boards', '_folders.json'), JSON.stringify({ version: 2, folders: [{ name: 'history', type: 'archive' }] }, null, 2) + '\n')
  mkdirSync(join(root, 'design', '.local'), { recursive: true })
  writeFileSync(join(root, 'design', '.local', 'profile.json'), JSON.stringify({ name: 'Nic', email: 'nic@example.com' }))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('marver link - which board', () => {
  it('opens the first board in sidebar order that shows every frame asked for', () => {
    expect(resolveLink(root, ['shop/cart']).hash).toBe('#/b/cart-only?f=shop/cart')
    expect(resolveLink(root, ['shop/cart', 'shop/pay']).hash).toBe('#/b/flow?f=shop/cart,shop/pay')
    expect(resolveLink(root, ['shop']).hash).toBe('#/b/flow?s=shop')
  })

  it('takes a file path as well as an id', () => {
    expect(resolveLink(root, ['design/scenes/shop/pay.tsx']).frames).toEqual(['shop/pay'])
  })

  it('ranks archive boards last - by their own type or their folder\'s - and falls back to all-scenes', () => {
    expect(resolveLink(root, ['old/cart']).board).toBe('archive')          // only there - history is where it lives
    expect(resolveLink(root, ['other/far']).board).toBe('far-live')        // old-flow ranks first, but its folder is an archive
    const both = resolveLink(root, ['other/far', 'shop/cart'])
    expect(both).toMatchObject({ board: 'all-scenes', fellBack: true, hash: '#/b/all-scenes?f=other/far,shop/cart' })
  })

  it('a folder inside a scene travels as its frames - the link grammar names scenes, not paths', () => {
    expect(resolveLink(root, ['shop/wallet']).hash).toBe('#/b/flow?f=shop/wallet/a-card,shop/wallet/b-apple')
    expect(parseHash(resolveLink(root, ['shop/wallet']).hash).f).toEqual(['shop/wallet/a-card', 'shop/wallet/b-apple'])
  })

  it('honours --board, and refuses one that does not show the frames', () => {
    expect(resolveLink(root, ['shop/cart'], 'flow').hash).toBe('#/b/flow?f=shop/cart')
    expect(() => resolveLink(root, ['shop/pay'], 'cart-only')).toThrow(/does not show shop\/pay/)
    expect(() => resolveLink(root, ['shop/cart'], 'nope')).toThrow(/no board "nope"/)
  })

  it('refuses a name that is neither a frame nor a scene', () => {
    expect(() => resolveLink(root, ['shop/checkout'])).toThrow(/no frame or scene "shop\/checkout"/)
    expect(() => resolveLink(root, [])).toThrow(/name what to link/)
  })
})

describe('marver comments new / reply - Marver\'s voice', () => {
  const env = { ...process.env }
  afterEach(() => { process.env = { ...env } })
  const log = (b: string) => readLog(join(root, 'design', 'comments'), b)

  it('new pins a note on the frame, on the board its link opens, as Marver - with the harness that ran it', async () => {
    process.env.CLAUDECODE = '1'
    await commentsCommand(root, 'new', 'shop/pay', { body: 'Kept the card first — the wallet moved below. Right call?', on: '  Pay now\n with card ' })
    const [ev] = log('flow')
    expect(ev).toMatchObject({
      type: 'create', board: 'flow', frame: 'shop/pay', nodeKey: 'f-pay', agent: true,
      author: { name: 'Nic', email: 'nic@example.com' }, agentMeta: { devUser: 'Nic', harness: 'claude' },
      anchor: { el: { semantics: { quote: 'Pay now with card' } }, pos: { fx: 1, fy: 0.5 } },
      body: 'Kept the card first - the wallet moved below. Right call?',   // the house dash
    })
    expect(ev.commentId).toBeTruthy()
  })

  it('new without --on is a frame-level pin; a scene or a folder is refused', async () => {
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'OPENCODE', 'OPENCODE_PID', 'PI_CODING_AGENT', 'PI_SESSION_ID']) delete process.env[k]
    await commentsCommand(root, 'new', 'shop/cart', { body: 'Look here', board: 'flow' })
    const ev = log('flow').find((e) => e.frame === 'shop/cart')!
    expect(ev.anchor).toBeUndefined()
    expect(ev.agentMeta).toEqual({ devUser: 'Nic' })                     // no marker in the env: no harness claimed
    await expect(commentsCommand(root, 'new', 'shop', { body: 'x' })).rejects.toThrow(/folder of frames/)
    await expect(commentsCommand(root, 'new', 'shop/wallet', { body: 'Which wallet?' })).rejects.toThrow(/folder of frames/)   // never silently its first frame
    await expect(commentsCommand(root, 'new', 'shop/cart', {})).rejects.toThrow(/usage/)
  })

  it('reply answers the owner\'s thread as Marver, and a collaborator\'s in the owner\'s voice', async () => {
    const dir = join(root, 'design', 'comments')
    appendEvents(dir, 'flow', [
      { id: 'o1', ts: 1, type: 'create', commentId: 'mine', board: 'flow', frame: 'shop/cart', author: { email: 'NIC@example.com', name: 'Nic' }, body: 'tighter' },
      { id: 'o2', ts: 2, type: 'create', commentId: 'sams', board: 'flow', frame: 'shop/cart', author: { email: 'sam@example.com', name: 'Sam' }, body: 'bigger CTA' },
    ])
    await commentsCommand(root, 'reply', 'mine', { body: 'Tightened the rows.' })
    await commentsCommand(root, 'reply', 'sams', { body: 'CTA is 48px now.' })
    const threads = replay(log('flow'))
    const mine = threads.find((t) => t.id === 'mine')!.replies[0]
    const sams = threads.find((t) => t.id === 'sams')!.replies[0]
    expect(mine).toMatchObject({ agent: true, body: 'Tightened the rows.' })
    expect(sams.agent).toBeFalsy()
    expect(sams.author).toEqual({ email: 'nic@example.com', name: 'Nic' })
    // a reply in Marver's own note is Marver's too
    const note = threads.find((t) => t.agent && t.frame === 'shop/pay')!
    await commentsCommand(root, 'reply', note.id, { body: 'Moved it.' })
    expect(replay(log('flow')).find((t) => t.id === note.id)!.replies[0].agent).toBe(true)
  })
})

describe('the jam hold and the harness marker', () => {
  it('activity.has answers per source, and an expired lease is not held', async () => {
    const a = createActivity()
    a.mark('shop/cart', 60_000, 'cli')
    a.mark('shop/pay', 60_000, 'jam')
    a.mark('shop/old', 1, 'cli')
    await new Promise((r) => setTimeout(r, 5))
    expect(a.has('shop/cart', 'cli')).toBe(true)
    expect(a.has('shop/pay', 'cli')).toBe(false)
    expect(a.has('shop/old', 'cli')).toBe(false)
  })

  it('runningAgent reads the env marker only - never a guess from PATH', () => {
    expect(runningAgent({ CODEX_THREAD_ID: 't' })).toBe('codex')
    expect(runningAgent({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('claude')
    expect(runningAgent({ PATH: process.env.PATH })).toBeUndefined()
  })
})

describe('a thread Marver started stays on this machine', () => {
  it('every event in it - the thread, replies, a reaction on a reply - maps into the local-only set', () => {
    const evs = [
      { id: '1', ts: 1, type: 'create', commentId: 'note', agent: true },
      { id: '2', ts: 2, type: 'reply', commentId: 'r1', parentId: 'note' },
      { id: '3', ts: 3, type: 'react', commentId: 'r1', emoji: '👍' },
      { id: '4', ts: 4, type: 'resolve', commentId: 'note' },
      { id: '5', ts: 5, type: 'create', commentId: 'human' },
      { id: '6', ts: 6, type: 'reply', commentId: 'r2', parentId: 'human', agent: true },
    ] as any[]
    const set = localOnlyThreads(evs)
    expect([...set].sort()).toEqual(['note', 'r1'])
    // the human's thread syncs, even though Marver replied in it (that reply alone stays local)
    expect(set.has('human')).toBe(false)
  })
})

describe('engagement starts when Marver engaged', () => {
  it('a Live Jam reply engages from the mention that started it; a chat agent\'s reply or note from its own moment', () => {
    const m = engagedThreads([
      { id: 'm-1', ts: 40, type: 'create', commentId: 't-jam', body: 'make it pop @marver' },
      { id: 'jam-abc', ts: 50, type: 'reply', parentId: 't-jam', agent: true },
      { id: 'jam-def', ts: 55, type: 'reply', parentId: 't-unmentioned', agent: true },   // answered a follow-up: adds nothing
      { id: 'u-1', ts: 70, type: 'reply', parentId: 't-cli', agent: true },
      { id: 'jam-ghi', ts: 80, type: 'reply', parentId: 't-cli', agent: true },           // no mention: the CLI moment stands
      { id: 'u-2', ts: 90, type: 'create', commentId: 't-note', agent: true },
      { id: 'h-1', ts: 95, type: 'reply', parentId: 't-human' },
      { id: 'c-1', ts: 20, type: 'create', commentId: 't-collab', body: '@marver fix this' },   // synced: not the owner's
      { id: 'jam-xyz', ts: 30, type: 'reply', parentId: 't-collab', agent: true },
    ] as any[], (id) => id !== 'c-1')
    expect(m.has('t-collab')).toBe(false)                                     // a collaborator's mention starts nothing
    expect(m.get('t-jam')).toBe(40)
    expect(m.has('t-unmentioned')).toBe(false)
    expect(m.get('t-cli')).toBe(70)
    expect(m.get('t-note')).toBe(90)
    expect(m.has('t-human')).toBe(false)
  })
})

describe('the live signal: which boards show the working frames', () => {
  it('pins, auto boards and all-scenes - read once, until a board changes', async () => {
    const { boardsShowing, boardsChanged, onBoardsChanged } = await import('../src/server/work.ts')
    const r = mkdtempSync(join(tmpdir(), 'mv-live-'))
    const b = (name: string, json: object) => { mkdirSync(join(r, 'design', 'boards'), { recursive: true }); writeFileSync(join(r, 'design', 'boards', `${name}.json`), JSON.stringify({ version: 1, name, ...json })) }
    b('flow', { nodes: [{ frame: 'shop/cart' }, { frame: 'shop/pay' }] })
    b('other', { nodes: [{ frame: 'x/y' }] })
    b('everything', { auto: true, nodes: [] })
    expect(boardsShowing(r, [])).toEqual([])
    expect(boardsShowing(r, ['shop/pay'])).toEqual(['all-scenes', 'everything', 'flow'])
    // the index is kept: a board edit is not seen until the watcher says boards changed
    b('other', { nodes: [{ frame: 'shop/pay' }] })
    expect(boardsShowing(r, ['shop/pay'])).toEqual(['all-scenes', 'everything', 'flow'])
    const heard: string[] = []
    const off = onBoardsChanged((root) => heard.push(root))
    boardsChanged(r)
    off()
    expect(heard).toEqual([r])
    expect(boardsShowing(r, ['shop/pay'])).toEqual(['all-scenes', 'everything', 'flow', 'other'])
    rmSync(r, { recursive: true, force: true })
  })
})
