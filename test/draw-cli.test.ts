import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drawCommand, parseDrawArgs } from '../src/cli/draw.ts'
import { CLI, fixtureRoot, startDev, type Dev } from './dev-server.ts'

describe('draw arguments and transport', () => {
  let root: string, elements: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mv-draw-args-'))
    elements = join(root, 'elements.json')
    mkdirSync(join(root, 'design/.local'), { recursive: true })
    writeFileSync(join(root, 'design/.local/dev.json'), JSON.stringify({ port: 12345, token: 'test-work-token', pid: process.pid }))
    writeFileSync(elements, JSON.stringify([{ id: 'box-cart', type: 'rectangle', x: 20 }]))
  })
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

  it('parses new and describe options', () => {
    expect(parseDrawArgs('new', ['flow'], { scene: 'checkout', name: 'cart', title: 'Cart flow', size: '1200x800' })).toEqual({ action: 'new', body: { board: 'flow', scene: 'checkout', name: 'cart', title: 'Cart flow', size: { w: 1200, h: 800 } } })
    expect(parseDrawArgs('new', ['flow'])).toEqual({ action: 'new', body: { board: 'flow' } })
    expect(parseDrawArgs('describe', ['checkout/cart'], { since: 0 })).toEqual({ action: 'describe', frame: 'checkout/cart', since: 0 })
  })

  it('reads an array or elements wrapper and keeps partial elements intact', () => {
    for (const data of [[{ id: 'cart', type: 'text', text: 'Cart' }], { elements: [{ id: 'cart', type: 'text', text: 'Cart' }] }]) {
      writeFileSync(elements, JSON.stringify(data))
      expect(parseDrawArgs('add', ['checkout/cart'], { elements, at: '-10,20.5' })).toEqual({ action: 'op', frame: 'checkout/cart', op: { kind: 'add', elements: [{ id: 'cart', type: 'text', text: 'Cart' }], at: { x: -10, y: 20.5 } } })
    }
  })

  it('parses JSON set values and preserves strings, empty values and equals signs', () => {
    const request = parseDrawArgs('set', ['s/f', 'cart', 'x=20', 'locked=true', 'roundness=null', 'customData={"tag":"cart"}', 'groupIds=["g"]', 'text=Cart = ready', 'link=', 'fontSize=2.5', 'strokeColor="#fff"', 'locked=false'])
    expect(request).toEqual({ action: 'op', frame: 's/f', op: { kind: 'set', id: 'cart', fields: { x: 20, locked: false, roundness: null, customData: { tag: 'cart' }, groupIds: ['g'], text: 'Cart = ready', link: '', fontSize: 2.5, strokeColor: '#fff' } } })
  })

  it('parses multiple move and rm ids', () => {
    expect(parseDrawArgs('move', ['s/f', 'cart', 'checkout'], { by: '-12.5,0' })).toEqual({ action: 'op', frame: 's/f', op: { kind: 'move', ids: ['cart', 'checkout'], dx: -12.5, dy: 0 } })
    expect(parseDrawArgs('rm', ['s/f', 'cart', 'checkout'])).toEqual({ action: 'op', frame: 's/f', op: { kind: 'rm', ids: ['cart', 'checkout'] } })
  })

  it.each([
    [undefined, [], {}, 'use:'], ['wat', [], {}, 'use:'], ['new', [], {}, 'use:'], ['new', ['../bad'], {}, 'board:'],
    ['new', ['b'], { size: '10x20' }, '--size:'], ['new', ['b'], { size: '960,640' }, '--size:'],
    ['describe', ['s/f'], { since: -1 }, '--since:'], ['describe', ['s/f'], { since: '1.5' }, '--since:'],
    ['describe', ['s/f'], { since: true }, '--since:'], ['describe', ['s/f', 'extra'], {}, 'use:'],
    ['set', ['s/f', 'id'], {}, 'use:'], ['set', ['s/f', 'id', 'bad'], {}, 'key=value'],
    ['set', ['s/f', 'id', '=x'], {}, 'key=value'], ['move', ['s/f', 'id'], {}, '--by:'],
    ['move', ['s/f', 'id'], { by: '1,' }, '--by:'], ['move', ['s/f', 'id'], { by: 'NaN,2' }, '--by:'],
    ['move', ['s/f', 'id'], { by: '1,2,3' }, '--by:'], ['rm', ['s/f'], {}, 'use:'],
    ['rm', ['s/f', 'id'], { at: '1,2' }, '--at is not used'],
  ] as const)('rejects invalid arguments (%s %j %j)', (action, args, opts, error) => {
    expect(() => parseDrawArgs(action, [...args], opts)).toThrow(error)
  })

  it('rejects unreadable, invalid JSON and non-object element lists', () => {
    expect(() => parseDrawArgs('add', ['s/f'], { elements: join(root, 'missing') })).toThrow('--elements')
    for (const text of ['not json', '{}', 'null', '[null]', '[[1]]', '["box"]']) {
      writeFileSync(elements, text)
      expect(() => parseDrawArgs('add', ['s/f'], { elements })).toThrow('--elements')
    }
  })

  it('rejects Mermaid before trying discovery or reading a file', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(drawCommand(root, 'add', ['s/f'], { mermaid: 'missing.mmd' })).rejects.toThrow('Mermaid conversion is not available yet - write elements (see draw.md)')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('authenticates, encodes the whole frame id, and prints the describe text', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Current drawing\n- cart'))
    await drawCommand(root, 'describe', ['scene/a b#c'], { since: '2' })
    expect(fetch).toHaveBeenCalledWith('http://localhost:12345/__mv/api/draw/scene%2Fa%20b%23c?describe=1&since=2', expect.objectContaining({ method: 'GET', headers: { 'x-mv-work': 'test-work-token' } }))
    expect(output).toHaveBeenCalledExactlyOnceWith('Current drawing\n- cart')
  })

  it('retries a network failure once with the identical opId and gives the next op a fresh id', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json({ rev: 2, ids: ['cart'] }))
      .mockResolvedValueOnce(Response.json({ rev: 3, ids: ['cart'] }))
    await drawCommand(root, 'move', ['s/f', 'cart'], { by: '10,20' })
    await drawCommand(root, 'rm', ['s/f', 'cart'])
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0].op).toEqual({ kind: 'move', ids: ['cart'], dx: 10, dy: 20 })
    expect(bodies[0].opId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(bodies[2].opId).not.toBe(bodies[0].opId)
    expect(fetch.mock.calls[0][1]?.headers).toEqual({ 'x-mv-work': 'test-work-token', 'content-type': 'application/json' })
    expect(output).toHaveBeenCalledWith('rev 2 · cart')
    expect(output).toHaveBeenCalledWith('then: npx marver shot s/f')
  })

  it('also retries a lost response body with the same opId', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')) } }))
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(broken).mockResolvedValueOnce(Response.json({ rev: 1, ids: [] }))
    await drawCommand(root, 'rm', ['s/f', 'cart'])
    expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body)
  })

  it('does not retry HTTP errors and prints the server error through the command handler', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'no element "cart" in s/f' }, { status: 409 }))
    await expect(drawCommand(root, 'set', ['s/f', 'cart', 'x=1'])).rejects.toThrow('no element "cart" in s/f')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stops after two failed network attempts with the sandbox/dev guidance', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    await expect(drawCommand(root, 'rm', ['s/f', 'cart'])).rejects.toThrow(/npx marver dev.*must be running.*outside the sandbox/)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry creation, which has no server dedupe key', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    await expect(drawCommand(root, 'new', ['flow'])).rejects.toThrow('could not reach')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('asks for a dev server when dev.json is missing', async () => {
    rmSync(join(root, 'design/.local/dev.json'))
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(drawCommand(root, 'describe', ['s/f'])).rejects.toThrow('npx marver dev` must be running')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('built draw CLI against a real dev server', () => {
  let root = '', dev: Dev | undefined, unavailable = ''
  beforeAll(async () => {
    root = fixtureRoot('mv-draw-cli-', {
      'design/config.ts': 'export default { jam: false }\n',
      'design/scenes/app/home.tsx': 'export default () => <main>Home</main>\n',
      'design/boards/flow.json': JSON.stringify({ version: 1, name: 'flow', auto: false, nodes: [{ key: 'home', frame: 'app/home', x: 0, y: 0, w: 960, h: 640 }] }),
    })
    try { dev = await startDev(root) }
    catch (err) {
      // The sandbox may forbid listening on localhost. Keep argument/transport tests mandatory;
      // skip only the two real-server cases, and never disguise an application startup failure.
      if (!/listen (?:EPERM|EACCES):/.test((err as Error).message)) throw err
      unavailable = 'Sandbox forbids listening on localhost (EPERM/EACCES); run outside the sandbox for real-server coverage.'
      console.warn(unavailable)
    }
  }, 90_000)
  afterAll(async () => {
    await dev?.stop()
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const run = (args: string[], project = root) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, [CLI, 'draw', ...args, '--root', project], { cwd: root, env: { ...process.env, CI: '1', MARVER_NO_UPDATE_CHECK: '1' }, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code) || 1 : 0, out: stdout, err: stderr })
    })
  })
  const readDrawing = (name = 'cart') => JSON.parse(readFileSync(join(root, `design/scenes/checkout/${name}.excalidraw`), 'utf8'))

  it('creates and pins a drawing, then adds, describes, sets, moves and removes elements', async (ctx) => {
    if (unavailable) return ctx.skip(unavailable)
    const made = await run(['new', 'flow', '--scene', 'checkout', '--name', 'cart', '--title', 'Cart flow', '--size', '1200x800'])
    expect(made.code, made.err).toBe(0)
    expect(made.out).toContain('checkout/cart\ndesign/scenes/checkout/cart.excalidraw')
    expect(readDrawing().marver).toMatchObject({ title: 'Cart flow', size: { w: 1200, h: 800 } })
    const board = JSON.parse(readFileSync(join(root, 'design/boards/flow.json'), 'utf8'))
    expect(board.nodes.some((n: { frame: string }) => n.frame === 'checkout/cart')).toBe(true)
    // The manifest watcher discovers the new file asynchronously; wait for the real read endpoint.
    const info = JSON.parse(readFileSync(join(root, 'design/.local/dev.json'), 'utf8'))
    await vi.waitFor(async () => {
      const res = await fetch(`${dev!.origin}/__mv/api/draw/checkout%2Fcart`, { headers: { 'x-mv-work': info.token } })
      expect(res.ok).toBe(true)
    }, { timeout: 15_000, interval: 100 })
    writeFileSync(join(root, 'elements.json'), JSON.stringify({ elements: [{ id: 'box-cart', type: 'rectangle', x: 10, y: 20 }, { id: 'label-cart', type: 'text', text: 'Cart', x: 30, y: 40, containerId: 'box-cart' }] }))
    const added = await run(['add', 'checkout/cart', '--elements', 'elements.json', '--at', '100,200'])
    expect(added.code, added.err).toBe(0)
    expect(added.out).toContain('rev 1')
    expect(added.out).toContain('box-cart')
    expect(added.out).toContain('then: npx marver shot checkout/cart')
    const described = await run(['describe', 'checkout/cart', '--since', '0'])
    expect(described.code, described.err).toBe(0)
    expect(described.out).toContain('Cart flow')
    expect(described.out).toContain('box-cart')
    expect(described.out).toContain('Changes since rev 0:')
    const set = await run(['set', 'checkout/cart', 'label-cart', 'text=Review cart', 'fontSize=24', 'locked=false'])
    expect(set.code, set.err).toBe(0)
    expect(readDrawing().elements.find((e: { id: string }) => e.id === 'label-cart')).toMatchObject({ text: 'Review cart', originalText: 'Review cart', fontSize: 24, locked: false })
    const moved = await run(['move', 'checkout/cart', 'box-cart', 'label-cart', '--by', '-10,20'])
    expect(moved.code, moved.err).toBe(0)
    expect(readDrawing().elements.find((e: { id: string }) => e.id === 'box-cart')).toMatchObject({ x: 90, y: 220 })
    expect(readDrawing().elements.find((e: { id: string }) => e.id === 'label-cart')).toMatchObject({ x: 110, y: 240 })
    const removed = await run(['rm', 'checkout/cart', 'box-cart'])
    expect(removed.code, removed.err).toBe(0)
    expect(readDrawing().elements).toEqual([])
  }, 60_000)

  it('prints API errors and exits 1', async (ctx) => {
    if (unavailable) return ctx.skip(unavailable)
    const result = await run(['describe', 'no/such-frame'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('no drawing "no/such-frame" on this canvas')
  })

  it('rejects Mermaid with and without a filename, with exit 1', async () => {
    for (const args of [['--mermaid', 'flow.mmd'], ['--mermaid']]) {
      const result = await run(['add', 'checkout/cart', ...args])
      expect(result.code).toBe(1)
      expect(result.err).toContain('Mermaid conversion is not available yet - write elements (see draw.md)')
    }
  })

  it('shows draw help and rejects missing or malformed command arguments with exit 1', async () => {
    const help = await run(['--help'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('--elements')
    for (const args of [[], ['new'], ['set', 's/f', 'id', 'x'], ['move', 's/f', 'id', '--by=NaN,1']]) {
      const result = await run(args)
      expect(result.code).toBe(1)
      expect(result.err).toContain('[marver]')
    }
  })

  it('accepts negative coordinate pairs through cac before reporting a missing dev server', async () => {
    const missing = join(root, 'no-server')
    const result = await run(['move', 's/f', 'id', '--by', '-10,20'], missing)
    expect(result.code).toBe(1)
    expect(result.err).toContain('npx marver dev` must be running')
    expect(result.err).not.toContain('Unknown option')
  })
})
