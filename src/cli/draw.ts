/** `marver draw`: describe the live drawing, then make exact edits through its dev server. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readDevInfo } from '../server/work.ts'
import type { AgentOp } from '../server/draw/service.ts'
import { isBoardName } from '../shared/board-tree.ts'
import { NAME } from './name.ts'

export interface DrawOptions {
  scene?: unknown; name?: unknown; title?: unknown; size?: unknown; since?: unknown
  elements?: unknown; mermaid?: unknown; at?: unknown; by?: unknown
}

export type DrawRequest =
  | { action: 'new'; body: { board: string; scene?: string; name?: string; title?: string; size?: { w: number; h: number } } }
  | { action: 'describe'; frame: string; since?: number }
  | { action: 'op'; frame: string; op: AgentOp }

function optionText(value: unknown, flag: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) throw new Error(`${flag}: provide a value`)
  return String(value)
}

function pair(value: unknown, flag: string): [number, number] {
  const parts = optionText(value, flag).split(',')
  if (parts.length !== 2 || parts.some((p) => !p.trim() || !Number.isFinite(Number(p)))) throw new Error(`${flag}: use two finite numbers, x,y (for negatives: ${flag}=-10,20)`)
  return parts.map(Number) as [number, number]
}

/** Validate before making a request; exported so argument errors can be tested without a server. */
export function parseDrawArgs(action: string | undefined, args: string[], opts: DrawOptions = {}): DrawRequest {
  if (opts.mermaid !== undefined) throw new Error('Mermaid conversion is not available yet - write elements (see draw.md)')
  const flags: Record<string, string[]> = { new: ['scene', 'name', 'title', 'size'], describe: ['since'], add: ['elements', 'at'], set: [], move: ['by'], rm: [] }
  if (!action || !Object.hasOwn(flags, action)) throw new Error(`use: ${NAME} draw new|describe|add|set|move|rm …`)
  for (const key of ['scene', 'name', 'title', 'size', 'since', 'elements', 'at', 'by'] as const) {
    if (opts[key] !== undefined && !flags[action].includes(key)) throw new Error(`--${key} is not used by draw ${action}`)
  }
  const need = (min: number, max: number, usage: string) => {
    if (args.length < min || args.length > max || args.some((s) => !s.trim())) throw new Error(`use: ${NAME} draw ${usage}`)
  }
  if (action === 'new') {
    need(1, 1, 'new <board> [--scene s] [--name n] [--title t] [--size 960x640]')
    if (!isBoardName(args[0])) throw new Error('board: use 1-64 lowercase letters, digits or dashes, starting with a letter or digit')
    const body: Extract<DrawRequest, { action: 'new' }>['body'] = { board: args[0] }
    for (const key of ['scene', 'name', 'title'] as const) if (opts[key] !== undefined) body[key] = optionText(opts[key], `--${key}`)
    if (opts.size !== undefined) {
      const match = /^(\d+)x(\d+)$/i.exec(optionText(opts.size, '--size'))
      const w = Number(match?.[1]), h = Number(match?.[2])
      if (!match || w < 120 || h < 80 || w > 8000 || h > 8000) throw new Error('--size: use WIDTHxHEIGHT (width 120-8000, height 80-8000)')
      body.size = { w, h }
    }
    return { action: 'new', body }
  }
  if (action === 'describe') {
    need(1, 1, 'describe <frame> [--since <rev>]')
    const since = opts.since === undefined ? undefined : Number(optionText(opts.since, '--since'))
    if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) throw new Error('--since: use a non-negative integer revision')
    return { action: 'describe', frame: args[0], ...(since !== undefined ? { since } : {}) }
  }
  let op: AgentOp
  if (action === 'add') {
    need(1, 1, 'add <frame> --elements <file.json> [--at x,y]')
    const file = optionText(opts.elements, '--elements')
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, 'utf8')) }
    catch (err) { throw new Error(`--elements ${file}: ${(err as Error).message}`) }
    const elements = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && 'elements' in raw ? raw.elements : undefined
    if (!Array.isArray(elements) || elements.some((e) => !e || typeof e !== 'object' || Array.isArray(e))) throw new Error('--elements: expected a JSON array of element objects or {"elements":[…]}')
    const at = opts.at === undefined ? undefined : pair(opts.at, '--at')
    op = { kind: 'add', elements, ...(at ? { at: { x: at[0], y: at[1] } } : {}) }
  } else if (action === 'set') {
    need(3, Infinity, 'set <frame> <id> key=value …')
    const fields: Record<string, unknown> = Object.create(null)
    for (const field of args.slice(2)) {
      const eq = field.indexOf('=')
      if (eq <= 0 || !field.slice(0, eq).trim()) throw new Error(`set: expected key=value, got "${field}"`)
      const key = field.slice(0, eq), value = field.slice(eq + 1)
      try { fields[key] = JSON.parse(value) } catch { fields[key] = value }
    }
    op = { kind: 'set', id: args[1], fields }
  } else if (action === 'move') {
    need(2, Infinity, 'move <frame> <ids...> --by dx,dy')
    const [dx, dy] = pair(opts.by, '--by')
    op = { kind: 'move', ids: args.slice(1), dx, dy }
  } else {
    need(2, Infinity, 'rm <frame> <ids...>')
    op = { kind: 'rm', ids: args.slice(1) }
  }
  return { action: 'op', frame: args[0], op }
}

export async function drawCommand(root: string, action: string | undefined, args: string[], opts: DrawOptions = {}): Promise<void> {
  const request = parseDrawArgs(action, args, opts)
  const info = readDevInfo(root)
  if (!info) throw new Error(`\`npx ${NAME} dev\` must be running in this repo (no live design/.local/dev.json) - start it first.`)
  const path = request.action === 'new' ? 'new' : encodeURIComponent(request.frame)
  const query = request.action === 'describe' ? `?describe=1${request.since !== undefined ? `&since=${request.since}` : ''}` : ''
  // Freeze the body, including the fresh opId, before either attempt. A lost reply must not apply an op twice.
  const body = request.action === 'op' ? JSON.stringify({ op: request.op, opId: randomUUID() }) : request.action === 'new' ? JSON.stringify(request.body) : undefined
  const attempts = request.action === 'op' ? 2 : 1 // creation has no dedupe key
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response, text: string
    try {
      res = await fetch(`http://localhost:${info.port}/__mv/api/draw/${path}${query}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-mv-work': info.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body, signal: AbortSignal.timeout(15_000),
      })
      text = await res.text()
    } catch {
      if (attempt + 1 < attempts) continue
      throw new Error(`could not reach \`npx ${NAME} dev\` on port ${info.port}. It must be running in this repo; if this sandbox blocks localhost, run this command outside the sandbox.`)
    }
    let data: Record<string, unknown> | undefined
    try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed } catch { /* describe is plain text */ }
    if (!res.ok || data?.error !== undefined) throw new Error(typeof data?.error === 'string' ? data.error : `draw failed (${res.status})`)
    if (request.action === 'describe') { console.log(text); return }
    let frame: string
    if (request.action === 'new') {
      if (typeof data?.id !== 'string' || typeof data.file !== 'string') throw new Error('draw new: invalid server response')
      frame = data.id
      console.log(`${frame}\n${data.file}`)
    } else {
      if (!Number.isSafeInteger(data?.rev) || !Array.isArray(data?.ids)) throw new Error('draw: invalid server response')
      frame = request.frame
      console.log(`rev ${data.rev}${data.ids.length ? ` · ${data.ids.join(', ')}` : ''}`)
    }
    console.log(`then: npx ${NAME} shot ${frame}`)
    return
  }
}
