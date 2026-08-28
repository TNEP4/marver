/**
 * `marver share <action>` - the roster from the terminal (01-sharing §9).
 *
 * The sovereign administration path: on a canvas with no identity issuer this
 * IS the whole interface, and on every canvas it calls the same owner routes
 * the app does, over the device credential `comments connect` stored. The
 * resolver ships with an explainer because a permission system nobody can
 * predict is not safe - `explain` and `who` run the SAME pure function the
 * server enforces with, on the same roster bytes, so the terminal and the
 * dialog can never disagree (acceptance 9).
 *
 * add <who>        grant view (default) or --role comment; --expires <iso>
 * remove <who>     remove the grant
 * block <email> / unblock <email>
 * general <mode>   private · password · public
 * list             the roster - general access, grants, blocklist
 * requests         pending access requests; --approve <email> [--role r] · --decline <email>
 * explain <who>    the resolver's trace for one principal
 * who              the whole matrix
 */
import { NAME } from './name.ts'
import { loadCollab } from '../server/sync.ts'
import { resolveAccess, type Ceilings, type ShareStore } from '../server/share.ts'

interface Opts { role?: string; expires?: string; approve?: string; decline?: string; json?: boolean }

async function api(root: string, method: string, path: string, body?: unknown) {
  const collab = loadCollab(root)
  if (!collab) throw new Error(`no canvas connected - run \`npx ${NAME} comments connect <url>\` first`)
  const res = await fetch(`${collab.url.replace(/\/+$/, '')}/__mv/api/${path}`, {
    method,
    headers: { authorization: `Bearer ${collab.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 403) throw new Error('the canvas refused - sharing is owner-only, and the connect credential must be the owner\'s')
  if (!res.ok) throw new Error((await res.json().catch(() => null) as any)?.error ?? `canvas answered ${res.status}`)
  return res.json() as Promise<any>
}

/** The published ceilings, from the boards route - the same rights serve enforces with. */
async function fetchCeilings(root: string): Promise<Ceilings> {
  const { rights } = await api(root, 'GET', 'boards') as { rights: Record<string, 'read' | 'comment'> }
  return Object.fromEntries(Object.entries(rights).map(([b, r]) => [b, r === 'comment' ? 'comment' as const : 'view' as const]))
}

const asStore = (roster: any): ShareStore => ({
  version: 1, general: roster.general, blocked: roster.blocked, grants: roster.grants,
})

/** The trace, rendered - what `explain` prints and what the dialog shows. */
function renderExplain(who: string, store: ShareStore, ceilings: Ceilings): string {
  const r = resolveAccess({ email: who.startsWith('@') ? null : who, store, ceilings })
  const lines: string[] = []
  for (const step of r.trace) lines.push(`  ${step.where.padEnd(14)} ${step.role.padEnd(9)} ${step.why}`)
  const boards = Object.entries(r.boards)
  const readable = boards.filter(([, role]) => role !== 'none').length
  const writable = boards.filter(([, role]) => role === 'comment').length
  for (const [b, role] of boards) lines.push(`  board ${b.padEnd(14)} ${role}`)
  lines.push(`  → ${readable} of ${boards.length} board${boards.length === 1 ? '' : 's'}, may comment on ${writable}`)
  return lines.join('\n')
}

export async function shareCommand(root: string, action: string, value: string | undefined, opts: Opts) {
  switch (action) {
    case 'add': {
      if (!value) throw new Error('add needs a principal: an email, or @domain')
      const role = opts.role === 'comment' ? 'comment' : 'view'
      const r = await api(root, 'PUT', 'share/grant', { principal: value, scope: 'canvas', assigned: role, expires: opts.expires ?? null })
      console.log(`  granted ${value} → ${role}${opts.expires ? ` until ${opts.expires}` : ''} (${r.grants.length} grant${r.grants.length === 1 ? '' : 's'} total)`)
      return
    }
    case 'remove': {
      if (!value) throw new Error('remove needs the principal to remove')
      await api(root, 'DELETE', 'share/grant', { principal: value, scope: 'canvas' })
      console.log(`  removed ${value}`)
      return
    }
    case 'block':
    case 'unblock': {
      if (!value) throw new Error(`${action} needs an email address`)
      await api(root, action === 'block' ? 'PUT' : 'DELETE', 'share/block', { address: value })
      console.log(action === 'block'
        ? `  blocked ${value} - refused everywhere, ahead of every grant.\n  Blocking only bites while general access is Private.`
        : `  unblocked ${value}`)
      return
    }
    case 'general': {
      if (value !== 'private' && value !== 'password' && value !== 'public')
        throw new Error('general needs a mode: private · password · public')
      await api(root, 'PUT', 'share/general', { mode: value })
      console.log(`  general access → ${value}${value === 'public' ? ' (anyone with the URL reads - Public is called Public)' : ''}`)
      return
    }
    case 'list': {
      const r = await api(root, 'GET', 'share/roster')
      if (opts.json) return console.log(JSON.stringify(r, null, 2))
      console.log(`\n  general access: ${r.general.mode}`)
      if (r.blocked.length) console.log(`  blocked: ${r.blocked.join(', ')}`)
      if (!r.grants.length) console.log('  no grants - only the owner (and general access, if open) gets in')
      for (const g of r.grants)
        console.log(`  ${g.principal.padEnd(28)} ${g.assigned.padEnd(8)}${g.expires ? ` until ${g.expires.slice(0, 10)}` : ''}  by ${g.by}`)
      if (r.requests.length) console.log(`\n  ${r.requests.length} pending request${r.requests.length === 1 ? '' : 's'} - \`${NAME} share requests\``)
      console.log('')
      return
    }
    case 'requests': {
      if (opts.approve || opts.decline) {
        const email = opts.approve ?? opts.decline!
        await api(root, 'POST', `share/request/${encodeURIComponent(email)}`, {
          approve: !!opts.approve, ...(opts.approve ? { assigned: opts.role === 'comment' ? 'comment' : 'view' } : {}),
        })
        console.log(opts.approve
          ? `  approved ${email} → ${opts.role === 'comment' ? 'comment' : 'view'} - CANVAS-WIDE (v1 approval covers every published board)`
          : `  declined ${email} (silently - no rejection reaches them)`)
        return
      }
      const r = await api(root, 'GET', 'share/roster')
      if (!r.requests.length) return console.log('  no pending requests')
      for (const q of r.requests)
        console.log(`  ${q.email.padEnd(28)} asks ${q.requestedRole.padEnd(8)}${q.target ? ` for ${q.target}` : ''}${q.note ? `  "${q.note}"` : ''}`)
      console.log(`\n  approve: \`${NAME} share requests --approve <email> [--role comment]\` · decline: \`--decline <email>\``)
      return
    }
    case 'explain': {
      if (!value) throw new Error('explain needs a principal to explain')
      const [roster, ceilings] = await Promise.all([api(root, 'GET', 'share/roster'), fetchCeilings(root)])
      console.log(`\n${renderExplain(value, asStore(roster), ceilings)}\n`)
      return
    }
    case 'who': {
      const [roster, ceilings] = await Promise.all([api(root, 'GET', 'share/roster'), fetchCeilings(root)])
      const store = asStore(roster)
      const boards = Object.keys(ceilings)
      const principals = [...new Set(store.grants.map((g: any) => g.principal))]
      console.log(`\n  ${''.padEnd(28)} ${boards.map((b) => b.padEnd(16)).join('')}`)
      for (const p of principals) {
        const r = resolveAccess({ email: p.startsWith('@') ? null : p, store, ceilings })
        const cells = p.startsWith('@')
          ? boards.map(() => '(per member)')
          : boards.map((b) => r.boards[b])
        console.log(`  ${p.padEnd(28)} ${cells.map((c) => String(c).padEnd(16)).join('')}`)
      }
      for (const b of store.blocked)
        console.log(`  blocked ${String(b).padEnd(20)} ${boards.map(() => 'none'.padEnd(16)).join('')}`)
      if (store.general.mode !== 'private')
        console.log(`  ${'anyone (general access)'.padEnd(28)} ${boards.map((b) => 'view'.padEnd(16)).join('')}`)
      console.log('')
      return
    }
    default:
      throw new Error(`unknown action "${action}" - use add · remove · block · unblock · general · list · requests · explain · who`)
  }
}
