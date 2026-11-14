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
 * new <frame>    pin a note on an element of a frame (--body, --on "<words it shows>" or --at
 *                 "<selector or data-testid>") - Marver's voice, the owner's pill: what an agent
 *                 leaves where it needs the human's eyes. Checked against the rendered frame when
 *                 `dev` runs; it asks (--fyi: it does not). --thread <id> adds it to an open thread.
 * reply <thread>  append a reply (--body) - the agent's voice in the loop: Marver's on a thread
 *                 started here, the owner's on a collaborator's (the voice that reaches them);
 *                 --ask when the reply asks the human something
 * move <thread>   re-pin a thread on another element (--on / --at) - its author's only
 * resolve <thread>  mark addressed (--addressed-in <frame> records WHICH variant)
 * resolve --all   every open thread in one scope (--board | --folder | --scene | --frame | --canvas; --dry-run counts) -
 *                 never what Jam is at work on; --undo <op> reopens what it resolved. Only on the human's yes.
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
import { runningAgent } from '../server/jam/agent.ts'
import { readDevInfo } from '../server/work.ts'
import { readTarget, uncheckedAnchor, type Anchor, type AnchorCheck, type AnchorTarget } from '../shared/anchor.ts'

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
      const { readHeld, heldWords } = await import('../server/sync.ts')
      const held = readHeld(root)
      for (const [b, n] of Object.entries(out)) console.log(`  ${b}: pulled ${n.pulled}, pushed ${n.pushed}${held[b]?.length ? ` - ${heldWords(held[b]).join('; ')}` : ''}`)
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
        console.log(`  ${t.resolved ? '✓' : '○'} ${t.id}${anchor} - ${t.deleted ? '(comment deleted)' : `${t.agent ? 'Marver' : t.author?.name ?? '?'}: ${t.body ?? ''}`}${t.replies.length ? ` (+${t.replies.length})` : ''}${t.addressedIn ? ` → ${t.addressedIn}` : ''}`)
      }
      return
    }
    case 'reply': {
      if (!value || !opts.body) throw new Error('usage: comments reply <thread-id> --body "..."')
      const t = allThreads(root).find((t) => t.id === value)
      if (!t) throw new Error(`no thread ${value} in design/comments/`)
      // The reply goes where the asker is. A thread the owner (or Marver) started lives on this
      // machine: the agent answers as Marver - its own voice, and the owner gets the pill. A thread a
      // collaborator started arrived from the published canvas, and agent events never leave this
      // machine (sync.ts) - so that reply keeps the owner's voice, the one that reaches them.
      const local = ownerThread(root, t)
      appendEvents(join(root, 'design', 'comments'), t.board, [{
        id: randomUUID(), ts: Date.now(), type: 'reply', commentId: randomUUID(), parentId: t.id, board: t.board,
        ...(local ? marverAuthor(root) : { author: localAuthor(root) }), body: plainDashes(String(opts.body)), asks: !!opts.ask,
      }])
      if (!local) await pushIfConnected(root)
      return void console.log(local ? `  replied to ${t.id} as Marver` : `  replied to ${t.id} in your voice - ${t.author?.name ?? 'its author'} sees it on the published canvas`)
    }
    case 'new': {
      if (opts.thread !== undefined) return addToThread(root, String(opts.thread), value, opts)
      if (!value || !opts.body) throw new Error('usage: comments new <scene/frame> --body "..." --on "<words it shows>" | --at "<selector or data-testid>" [--nth <n>] [--fyi] [--board <board>]')
      const { resolveLink, devOrigin, linkFor } = await import('./link.ts')
      const r = resolveLink(root, [value], opts.board)
      if (r.exact.length !== 1) throw new Error(`"${value}" is a folder of frames - pin a note on one frame: comments new <scene/frame>`)
      // a note lives on a board: a frame on none gets the hint first (spec 26, Part 7) - then its element
      if (!r.board) throw new Error(`a note needs a board to live on - ${r.hints.join('\n')}`)
      const target = readTarget(opts)
      if (typeof target === 'string') throw new Error(`a note goes on an element - ${target}`)
      const frame = r.exact[0]
      const nodeKey = r.nodesOf(r.board).find((n) => n.frame === frame && typeof n.key === 'string')?.key
      const open = allThreads(root).filter((t) => !t.resolved && t.frame === frame && !isNoteThread(t))
      const { anchor, holders } = await pinOn(root, frame, target, opts, open)
      const threadId = randomUUID()
      appendEvents(join(root, 'design', 'comments'), r.board, [{
        id: randomUUID(), ts: Date.now(), type: 'create', commentId: threadId, board: r.board, frame,
        ...(nodeKey ? { nodeKey } : {}), anchor,
        ...marverAuthor(root), body: plainDashes(String(opts.body)), asks: !opts.fyi,
      }])
      const origin = await devOrigin(root)
      console.log(`  pinned a note on ${frame} (board ${r.board})${origin ? `: ${linkFor(root, origin, `#/b/${r.board}?c=${threadId}`)}` : ''}`)
      // one thread per topic: the note is written, and the next one about this element is a reply
      for (const t of open.filter((t) => holders.includes(t.id))) {
        const next = ownerThread(root, t) ? `comments new --thread ${t.id} --body "..."` : `comments reply ${t.id} --body "..."`
        console.log(`  that element already holds thread ${t.id} (${t.agent ? 'Marver' : t.author?.name ?? 'someone'}: "${(t.body ?? '').slice(0, 60)}") - a follow-up on it is \`${NAME} ${next}\``)
      }
      return
    }
    case 'move': {
      if (!value) throw new Error('usage: comments move <thread-id> --on "<words it shows>" | --at "<selector or data-testid>" [--nth <n>]')
      const target = readTarget(opts)
      if (typeof target === 'string') throw new Error(target)
      const t = allThreads(root).find((t) => t.id === value)
      if (!t) throw new Error(`no thread ${value} in design/comments/`)
      if (!t.frame || isNoteThread(t)) throw new Error(`thread ${value} is not pinned in a frame - move it on the canvas`)
      // who may move a pin follows the published rule (collab.ts): its author - here, the owner or Marver
      if (!ownerThread(root, t)) throw new Error(`thread ${value} is ${t.author?.name ?? 'a collaborator'}'s - only its author can move it`)
      const others = allThreads(root).filter((o) => !o.resolved && o.frame === t.frame && o.id !== t.id && !isNoteThread(o))
      const { anchor } = await pinOn(root, t.frame, target, opts, others)
      appendEvents(join(root, 'design', 'comments'), t.board, [{
        id: randomUUID(), ts: Date.now(), type: 'reanchor', commentId: t.id, board: t.board, anchor,
        ...(t.agent ? marverAuthor(root) : { author: localAuthor(root) }),
      }])
      if (!t.agent) await pushIfConnected(root)
      return void console.log(`  moved ${t.id} on ${t.frame}`)
    }
    case 'resolve': {
      if (opts.undo !== undefined) return resolveUndo(root, String(opts.undo))
      if (opts.all) return resolveAllCli(root, value, opts)
      if (!value) throw new Error('usage: comments resolve <thread-id> [--addressed-in <frame>] | --all (--board b | --folder f | --scene s | --frame scene/frame | --canvas) [--dry-run]')
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
      throw new Error(`unknown action "${action}" - connect | sync | list | new | reply | move | resolve (--all) | invite | revoke`)
  }
}

/** `comments resolve --all` (spec 31 B.5): every open thread in one scope - through the running \`dev\` (its Jam queue in
 *  memory is the one checked, in the same step as the writes), else here, against the journal on disk. Never decided by
 *  an agent alone: the guide says to ask, with the counts \`--dry-run\` prints. */
const resolveAllCli = async (root: string, value: string | undefined, opts: any) => {
  if (value) throw new Error(`resolve --all takes no thread id - name a scope: --board, --folder, --scene, --frame or --canvas`)
  const ca = await import('../server/comment-actions.ts')
  const named = [opts.board !== undefined && { board: String(opts.board) }, opts.folder !== undefined && { folder: String(opts.folder) },
    opts.scene !== undefined && { scene: String(opts.scene) }, opts.frame !== undefined && { frame: String(opts.frame) },
    opts.canvas && { canvas: true }].filter(Boolean)
  if (named.length !== 1) throw new Error('resolve --all needs exactly one scope: --board <b> | --folder <f> | --scene <s> | --frame <scene/frame> | --canvas')
  const scope = ca.parseScope(named[0])
  if (typeof scope === 'string') throw new Error(scope)
  const op = randomUUID()
  const dryRun = !!opts.dryRun
  // with `dev` running, only through it: its Jam queue in memory is checked in the same step as the writes - a write from
  // here could slip between its ingest and its cards. Without it, the same core here, the queue read from its journal
  const r = readDevInfo(root) ? await viaDev(root, 'resolve-all', { op, scope, dryRun }) : ca.resolveAll(root, op, scope, { dryRun })
  if ('error' in r) throw new Error(r.error)
  if (dryRun) {
    const per = new Map<string, number>()
    for (const t of r.resolved) per.set(t.board, (per.get(t.board) ?? 0) + 1)
    console.log(`  ${ca.scopeLabel(scope)}: ${r.resolved.length} open conversation${r.resolved.length === 1 ? '' : 's'} would be resolved${r.skipped.length ? `, ${r.skipped.length} left open (work in progress)` : ''}`)
    for (const [b, n] of per) console.log(`    ${b}: ${n}`)
    return
  }
  console.log(`  ${ca.resolveSummary(r)} (${ca.scopeLabel(scope)})`)
  if (r.resolved.length) console.log(`  undo: ${NAME} comments resolve --undo ${op}`)
  if (r.resolved.length) await pushIfConnected(root)
  if (r.failed.length) process.exitCode = 1
}

/** A comment action through the running \`dev\` - tried twice with the same op (a retry returns the same receipt); a
 *  \`dev\` that cannot answer is said, never worked around. */
const viaDev = async (root: string, action: 'resolve-all' | 'undo', body: Record<string, unknown>): Promise<any> => {
  const info = readDevInfo(root)!
  let last = ''
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`http://localhost:${info.port}/__mv/api/comment-actions/${action}`, {
        method: 'POST', headers: { 'x-mv-work': info.token, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      })
      const data = await res.json().catch(() => null) as any
      if (res.ok || res.status === 207) return data
      if (/unknown endpoint/.test(data?.error ?? '')) throw new Error(`the running \`${NAME} dev\` is older than 0.31 and cannot resolve all - restart it, then run this again`)
      if (res.status < 500) return { error: data?.error ?? `dev answered ${res.status}` }
      last = data?.error ?? `dev answered ${res.status}`
    } catch (err) {
      if ((err as Error).message.includes('older than 0.31')) throw err
      last = (err as Error).message
    }
  }
  throw new Error(`\`${NAME} dev\` is running but did not answer (${last}) - run it again (what it already did stays done)`)
}

const resolveUndo = async (root: string, op: string) => {
  const ca = await import('../server/comment-actions.ts')
  const u = readDevInfo(root) ? await viaDev(root, 'undo', { op }) : ca.undoResolveAll(root, op)
  if ('error' in u) throw new Error(u.error)
  console.log(`  ${ca.undoSummary(u)}`)
  if (u.reopened.length) await pushIfConnected(root)
  if (u.failed.length) process.exitCode = 1
}

/** `comments new --thread <id>`: one thread per topic - a follow-up joins the open thread, as
 *  Marver, and asks unless --fyi. A collaborator's thread is answered with `comments reply`, which
 *  keeps its voice and sync rules. */
const addToThread = (root: string, id: string, frame: string | undefined, opts: any) => {
  if (!id || !opts.body) throw new Error('usage: comments new --thread <thread-id> --body "..." [--fyi]')
  if (opts.on !== undefined || opts.at !== undefined) throw new Error(`--thread adds to a thread already pinned - leave out --on/--at (\`${NAME} comments move\` re-pins it)`)
  const t = allThreads(root).find((t) => t.id === id)
  if (!t) throw new Error(`no thread ${id} in design/comments/`)
  if (frame && frame !== t.frame) throw new Error(`thread ${id} is on ${t.frame}, not ${frame}`)
  if (t.resolved) throw new Error(`thread ${id} is resolved - start a new note on its element instead`)
  if (!ownerThread(root, t)) throw new Error(`thread ${id} is ${t.author?.name ?? 'a collaborator'}'s - answer it with \`${NAME} comments reply ${id} --body "..."\``)
  appendEvents(join(root, 'design', 'comments'), t.board, [{
    id: randomUUID(), ts: Date.now(), type: 'reply', commentId: randomUUID(), parentId: t.id, board: t.board,
    ...marverAuthor(root), body: plainDashes(String(opts.body)), asks: !opts.fyi,
  }])
  console.log(`  added to ${t.id} on ${t.frame} as Marver`)
}

/** A thread pinned on a sticky note (spec 18), not in the frame document. */
const isNoteThread = (t: Thread) => !!(t.anchor as { el?: { note?: unknown } } | undefined)?.el?.note

/** The anchor for a target: checked against the rendered frame when `dev` runs (the full element
 *  bundle, and which open threads already sit on that element), unchecked with a warning when the
 *  check cannot run, refused only when the frame rendered with no match or several. */
const pinOn = async (root: string, frame: string, target: AnchorTarget, opts: any, open: Thread[]): Promise<{ anchor: Anchor; holders: string[] }> => {
  const check = await askDev(root, frame, target, opts, open)
  if (check.ok) {
    console.log(`  found it on ${frame} at ${check.viewport}, ${check.theme} theme`)
    return { anchor: check.anchor, holders: check.holders }
  }
  const named = target.on ? `"${target.on}"` : `--at "${target.at}"`
  if ('refused' in check && check.refused === 'none') {
    const shows = check.visible.length ? ` It shows:\n${check.visible.map((v) => `    ${v}`).join('\n')}\n ` : ''
    throw new Error(`no visible element on ${frame} matches ${named} (checked at ${check.viewport}, ${check.theme} theme).${shows} Use words one of them shows (--on), --at for an element without words, or --viewport / --theme if only another one shows it.`)
  }
  if ('refused' in check) {
    const past = target.nth ? ` (--nth ${target.nth} is past them)` : ''
    throw new Error(`${named} matches ${check.matches.length} visible elements on ${frame}${past}:\n${check.matches.map((m, i) => `    ${i + 1}. ${m}`).join('\n')}\n  add --nth <n> to pick one`)
  }
  console.error(`  (not checked - ${check.unchecked}. Pinned as named; if it does not resolve on the canvas it shows in the frame's column, and \`${NAME} comments move\` fixes it)`)
  // without the frame, the best guess at "already holds a thread": the same words or selector
  const anchor = uncheckedAnchor(target)
  const sameKey = (a: unknown) => (a as Anchor | undefined)?.el?.semantics?.quote?.toLowerCase() ?? (a as Anchor | undefined)?.el?.at
  return { anchor, holders: open.filter((t) => sameKey(t.anchor) === sameKey(anchor)).map((t) => t.id) }
}

/** Ask the running dev server to find the target in the frame - within 20 s, else unchecked. */
const askDev = async (root: string, frame: string, target: AnchorTarget, opts: any, open: Thread[]): Promise<AnchorCheck> => {
  const info = readDevInfo(root)
  if (!info) return { ok: false, unchecked: `\`${NAME} dev\` is not running` }
  let res: Response
  try {
    res = await fetch(`http://localhost:${info.port}/__mv/api/anchor`, {
      method: 'POST', headers: { 'x-mv-work': info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ frame, ...target, viewport: opts.viewport, theme: opts.theme, others: open.map((t) => ({ key: t.id, anchor: t.anchor })) }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    return { ok: false, unchecked: (err as Error).name === 'TimeoutError' ? 'the check passed its 20 s deadline' : `could not reach \`${NAME} dev\` on port ${info.port}` }
  }
  const data = await res.json().catch(() => null) as (AnchorCheck & { error?: string }) | null
  if (res.status === 400 && data?.error) throw new Error(data.error)
  if (!res.ok || !data) return { ok: false, unchecked: `the dev server answered ${res.status}` }
  return data
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

/** Did this thread start on this machine - by the owner, or by Marver? A thread a collaborator
 *  started carries their address; one with no address was written here before a profile existed. */
const ownerThread = (root: string, t: Thread): boolean => {
  if (t.agent) return true
  const theirs = t.author?.email?.toLowerCase()
  const mine = localProfile(root).email?.toLowerCase()
  return !theirs || (!!mine && theirs === mine)
}

/** Marver's voice for CLI-born events, the way Live Jam writes it (daemon.ts): the owner's identity
 *  (attributable), `agent: true` (renders as Marver, raises the owner's pill, never triggers a jam
 *  job, never syncs), and the harness that ran the command when its marker says so. */
const marverAuthor = (root: string) => {
  const me = localProfile(root)
  const harness = runningAgent()
  return { author: me, agent: true as const, agentMeta: { devUser: me.name, ...(harness ? { harness } : {}) } }
}

/** House style: never an em/en dash in a reply - a plain dash reads human (as Live Jam). */
const plainDashes = (s: string) => s.replace(/\s*[—–]\s*/g, ' - ')

/** Author snapshot for CLI-born events: the connected account (the server validates
 *  authors against the session - an authorless push would be rejected), else the
 *  local dev profile. */
const localAuthor = (root: string): { email: string; name?: string } | undefined => {
  const p = localProfile(root)
  return p.email ? { email: p.email, name: p.name } : undefined
}
