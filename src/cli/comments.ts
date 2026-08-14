/**
 * `marver comments <action>` (SPEC-M3 §2, §9) - the collaboration CLI.
 *
 * connect <url>   sign in (or --invite <token> to claim) against a published canvas;
 *                 stores the device credential in design/.local/collab.json
 * sync            one full exchange with the publish target (agent/CI path)
 * list            threads from design/comments/ (--open, --board, --json)
 * reply <thread>  append a reply (--body) - the agent's voice in the loop
 * resolve <thread>  mark addressed (--addressed-in <frame> records WHICH variant)
 * invite <email>  mint a single-use invite link (owner only, needs connect first)
 * revoke <email>  revoke an account and its sessions (owner only)
 */
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAME } from './name.ts'
import { appendEvents, listBoards, readLog, replay, type Thread } from '../server/comments.ts'
import { connect, connectClaim, loadCollab, syncOnce } from '../server/sync.ts'

const ask = (q: string, hide = false): Promise<string> => new Promise((done) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  if (hide) {
    // mute the echo: rewrite the line with the prompt only, on every keystroke
    const out = process.stdout
    const orig = (rl as any)._writeToOutput?.bind(rl)
    ;(rl as any)._writeToOutput = (s: string) => { if (s.includes('\n')) orig?.(s); else { out.clearLine?.(0); out.cursorTo?.(0); out.write(q) } }
  }
  rl.question(q, (a) => { rl.close(); if (hide) process.stdout.write('\n'); done(a.trim()) })
})

const allThreads = (root: string, board?: string): (Thread & { board: string })[] => {
  const dir = join(root, 'design', 'comments')
  const boards = board ? [board] : listBoards(dir)
  return boards.flatMap((b) => replay(readLog(dir, b)).map((t) => ({ ...t, board: b })))
}

export async function commentsCommand(root: string, action: string, value: string | undefined, opts: any) {
  switch (action) {
    case 'connect': {
      if (!value) throw new Error('usage: comments connect <published-url>')
      // the canvas gate comes first: MARVER_PASSWORD env, --canvas-password, or prompt
      const canvasPassword = opts.canvasPassword ?? process.env.MARVER_PASSWORD ??
        await ask('canvas password (blank if the canvas is ungated): ', true)
      if (opts.invite) {
        const name = opts.name ?? await ask('display name: ')
        const password = opts.password ?? await ask('choose a password: ', true)
        await connectClaim(root, value, String(opts.invite), { password, name }, canvasPassword || undefined)
      } else {
        const email = opts.email ?? await ask('email: ')
        const password = opts.password ?? await ask('password: ', true)
        await connect(root, value, email, password, canvasPassword || undefined)
      }
      console.log(`[${NAME}] connected - design/.local/collab.json holds the device credential (gitignored)`)
      console.log(`[${NAME}] \`${NAME} dev\` now syncs comments every 30s; \`${NAME} comments sync\` does one exchange`)
      return
    }
    case 'sync': {
      const collab = loadCollab(root)
      if (!collab) throw new Error(`not connected - run \`${NAME} comments connect <url>\` first`)
      const out = await syncOnce(root, collab)
      for (const [b, n] of Object.entries(out)) console.log(`  ${b}: pulled ${n.pulled}, pushed ${n.pushed}`)
      if (!Object.keys(out).length) console.log('  nothing to sync')
      return
    }
    case 'list': {
      let threads = allThreads(root, opts.board)
      if (opts.open) threads = threads.filter((t) => !t.resolved)
      if (opts.json) return void console.log(JSON.stringify(threads, null, 2))
      if (!threads.length) return void console.log(`  no ${opts.open ? 'open ' : ''}comments`)
      for (const t of threads) {
        const anchor = t.frame ? ` on ${t.frame}` : ''
        console.log(`  ${t.resolved ? '✓' : '○'} ${t.id}${anchor} - ${t.author?.name ?? '?'}: ${t.body ?? ''}${t.replies.length ? ` (+${t.replies.length})` : ''}${t.addressedIn ? ` → ${t.addressedIn}` : ''}`)
      }
      return
    }
    case 'reply': {
      if (!value || !opts.body) throw new Error('usage: comments reply <thread-id> --body "..."')
      const t = allThreads(root).find((t) => t.id === value)
      if (!t) throw new Error(`no thread ${value} in design/comments/`)
      appendEvents(join(root, 'design', 'comments'), t.board, [{
        id: randomUUID(), ts: Date.now(), type: 'reply', commentId: randomUUID(), parentId: t.id,
        author: localAuthor(root), body: String(opts.body),
      }])
      await pushIfConnected(root)
      return void console.log(`  replied to ${t.id}`)
    }
    case 'resolve': {
      if (!value) throw new Error('usage: comments resolve <thread-id> [--addressed-in <frame>]')
      const t = allThreads(root).find((t) => t.id === value)
      if (!t) throw new Error(`no thread ${value} in design/comments/`)
      appendEvents(join(root, 'design', 'comments'), t.board, [{
        id: randomUUID(), ts: Date.now(), type: 'resolve', commentId: t.id,
        ...(opts.addressedIn ? { addressedIn: String(opts.addressedIn) } : {}),
      }])
      await pushIfConnected(root)
      return void console.log(`  resolved ${t.id}${opts.addressedIn ? ` - addressed in ${opts.addressedIn}` : ''}`)
    }
    case 'invite': {
      if (!value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new Error('usage: comments invite <email>')
      const { token } = await ownerApi(root, 'invite', { email: value })
      const url = loadCollab(root)!.url.replace(/\/+$/, '')
      console.log(`  invite for ${value} (single-use, 7 days):`)
      console.log(`    canvas:  ${url}`)
      console.log(`    token:   ${token}`)
      console.log(`  they open the canvas, try to comment, pick "I have an invite", paste the token.`)
      return
    }
    case 'revoke': {
      if (!value) throw new Error('usage: comments revoke <email>')
      await ownerApi(root, 'revoke', { email: value })
      return void console.log(`  revoked ${value} - their sessions are dead`)
    }
    default:
      throw new Error(`unknown action "${action}" - connect | sync | list | reply | resolve | invite | revoke`)
  }
}

/** Owner-only account call against the connected canvas, via the device credential. */
const ownerApi = async (root: string, path: string, body: unknown): Promise<any> => {
  const collab = loadCollab(root)
  if (!collab) throw new Error(`not connected - run \`${NAME} comments connect <url>\` first`)
  const res = await fetch(`${collab.url.replace(/\/+$/, '')}/__mv/api/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${collab.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({})) as any
  if (!res.ok) throw new Error(data.error ?? `canvas answered ${res.status}`)
  return data
}

const pushIfConnected = async (root: string) => {
  const collab = loadCollab(root)
  if (collab) await syncOnce(root, collab).catch((e) => console.log(`  (push deferred: ${(e as Error).message})`))
}

/** Author snapshot for CLI-born events: the connected account (the server validates
 *  authors against the session - an authorless push would be rejected), else the
 *  local dev profile. */
const localAuthor = (root: string): { email: string; name?: string } | undefined => {
  const collab = loadCollab(root)
  if (collab?.email) return { email: collab.email, name: collab.name }
  try {
    const p = JSON.parse(readFileSync(join(root, 'design', '.local', 'profile.json'), 'utf8'))
    if (p?.email) return { email: p.email, name: p.name }
  } catch { /* no profile */ }
  return undefined
}
