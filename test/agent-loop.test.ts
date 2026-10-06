import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLog, appendEvents, replay } from '../src/server/comments.ts'
import { resolveLink } from '../src/cli/link.ts'
import { commentsCommand } from '../src/cli/comments.ts'
import { createActivity } from '../src/server/jam/activity.ts'
import { runningAgent } from '../src/server/jam/agent.ts'

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
  for (const [scene, files] of Object.entries({ shop: ['cart', 'pay'], other: ['far'], old: ['cart'] })) {
    mkdirSync(join(root, 'design', 'scenes', scene), { recursive: true })
    for (const f of files) writeFileSync(join(root, 'design', 'scenes', scene, `${f}.tsx`), frame(f, '<p>Pay now with card</p>'))
  }
  mkdirSync(join(root, 'design', 'boards'), { recursive: true })
  // the archive ranks FIRST by order - and still loses to a feature board that shows the frame
  board('archive', { order: 0, type: 'archive' }, [{ frame: 'shop/cart' }, { frame: 'shop/pay' }, { frame: 'old/cart' }])
  board('cart-only', { order: 1 }, [{ frame: 'shop/cart', key: 'k-cart' }])
  board('flow', { order: 2 }, [{ frame: 'shop/cart', key: 'f-cart' }, { frame: 'shop/pay', key: 'f-pay' }])
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

  it('ranks archive boards last, and falls back to all-scenes when no curated board shows them all', () => {
    expect(resolveLink(root, ['old/cart']).board).toBe('archive')          // only there - history is where it lives
    const far = resolveLink(root, ['other/far'])
    expect(far).toMatchObject({ board: 'all-scenes', fellBack: true, hash: '#/b/all-scenes?f=other/far' })
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

  it('new without --on is a frame-level pin; a scene is refused', async () => {
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'OPENCODE', 'OPENCODE_PID', 'PI_CODING_AGENT', 'PI_SESSION_ID']) delete process.env[k]
    await commentsCommand(root, 'new', 'shop/cart', { body: 'Look here', board: 'flow' })
    const ev = log('flow').find((e) => e.frame === 'shop/cart')!
    expect(ev.anchor).toBeUndefined()
    expect(ev.agentMeta).toEqual({ devUser: 'Nic' })                     // no marker in the env: no harness claimed
    await expect(commentsCommand(root, 'new', 'shop', { body: 'x' })).rejects.toThrow(/is a scene/)
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
