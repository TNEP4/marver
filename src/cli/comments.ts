/**
 * `marver comments <action>` - the collaboration CLI.
 *
 * connect <url>   sign in against a published canvas and store the device credential
 *                 in ~/.marver/canvases/ (outside the repo - `dev` serves the repo).
 *                 Three ways in: --token <t>, the
 *                 canvas's MARVER_CLI_TOKEN (the only one an identity-mode canvas
 *                 has), --invite <t> to claim an invite, or email + password.
 * sync            one full exchange with the publish target (agent/CI path)
 * list            threads from design/comments/ (--open, --board, --json)
 * reply <thread>  append a reply (--body) - the agent's voice in the loop
 * resolve <thread>  mark addressed (--addressed-in <frame> records WHICH variant)
 * invite <email>  mint a single-use invite link (owner only, needs connect first)
 * revoke <email>  revoke an account and its sessions (owner only)
 */
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { NAME } from './name.ts'
import { appendEvents, listBoards, readLog, replay, type Thread } from '../server/comments.ts'
import { connect, connectClaim, connectToken, loadCollab, syncOnce } from '../server/sync.ts'
import { localProfile } from '../server/profile.ts'

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
      // A token is its own gate passage, so it skips the canvas-password prompt
      // entirely - asking for a shared secret that an identity-mode canvas does
      // not even have was the confusing part of this flow.
      const cliToken = opts.token ?? process.env.MARVER_CLI_TOKEN
      if (cliToken) {
        await connectToken(root, value, String(cliToken))
        console.log(`[${NAME}] connected - the device credential is in ~/.marver/canvases/, outside this repo`)
        console.log(`[${NAME}] \`${NAME} dev\` now syncs comments every 30s; \`${NAME} comments sync\` does one exchange`)
        return
      }
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
      console.log(`[${NAME}] connected - the device credential is in ~/.marver/canvases/, outside this repo`)
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
      const { token, idMode } = await ownerApi(root, 'invite', { email: value })
      const url = loadCollab(root)!.url.replace(/\/+$/, '')
      console.log(`  invite for ${value} (single-use, 7 days):`)
      // On an identity canvas there is no link to send and no canvas password
      // to send with it: the address IS the invitation, spent the first time
      // that address signs in through Marver ID. Printing the claim link there
      // sends people to a door that is deliberately bolted shut.
      if (idMode) {
        console.log(`    ${url}`)
        console.log(`  send them that address - they sign in with ${value} and they are in.`)
        console.log(`  no link to forward, no password: the invitation IS the email address.`)
      } else {
        console.log(`    ${url}/#/i/${token}`)
        console.log(`  send them that link (plus the canvas password) - it opens straight into`)
        console.log(`  "pick your name and password".`)
      }
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
  const p = localProfile(root)
  return p.email ? { email: p.email, name: p.name } : undefined
}
