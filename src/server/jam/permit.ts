/**
 * `marver jam permit` - the permission tool of a background Claude Code run (spec 29b, Part 1).
 *
 * Claude Code refuses a wildcard over every MCP server in `--allowedTools`, and a headless run that
 * meets a permission question just says no - so a background agent could never use your MCP servers.
 * Instead the daemon adds this small stdio MCP server with `--mcp-config` and names its one tool with
 * `--permission-prompt-tool`: every question the run would have asked you comes here, and is answered
 * by the policy below. Nothing is ever asked of anyone; what is not allowed is refused, with a reason
 * the agent reads.
 *
 * Edits inside the repo and Bash inside the sandbox never get here (acceptEdits and
 * autoAllowBashIfSandboxed answer them first). What does: MCP tools, skills, web, subagents - and
 * anything outside those lines, which is refused.
 */
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface PermitPolicy { root: string; mcp: boolean; skills: boolean }

/** Tools a Jam run may use when they ask (reads, web, its own planning and helpers). */
const ALWAYS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'TodoRead', 'NotebookRead', 'ToolSearch', 'BashOutput', 'KillShell', 'TaskOutput', 'TaskStop', 'Monitor'])
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The path an edit would touch, resolved through any link that exists: inside the repo, or not. */
function insideRoot(root: string, p: unknown): boolean {
  if (typeof p !== 'string' || !p) return false
  // the nearest part of the path that exists, resolved through its links, then the rest as written
  let at = isAbsolute(p) ? p : resolve(root, p)
  const tail: string[] = []
  for (;;) {
    try { at = realpathSync(at); break } catch {
      const up = dirname(at)
      if (up === at) return false
      tail.unshift(basename(at)); at = up
    }
  }
  let base: string
  try { base = realpathSync(root) } catch { base = root }
  const rel = relative(base, join(at, ...tail))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !PROTECTED.some((r) => r.test(rel))
}

/** The same protected paths as Claude Code permission globs, relative to the repo - installed as `Edit(...)` deny
 *  rules, which also bound the sandbox's writes: an edit inside the repo is accepted before this tool is asked, so
 *  the rules must hold on their own. */
export const PROTECTED_GLOBS = ['.git/**', '.claude/**', '.codex/**', '.cursor/**', '.grok/**', '.opencode/**', '.vscode/**', '.idea/**', '.husky/**',
  '.mcp.json', 'node_modules/**', 'design/.local/**', '.envrc', '.env', '.env.*']

/** Inside the repo but never a Jam run's to edit: what runs commands outside its sandbox or speaks for the owner -
 *  git, the tools' settings and hooks, MCP configuration, the installed packages, Marver's own Jam state (the
 *  sessions' keys, the journal, the ledger). Matched on the resolved path, any case. */
const PROTECTED = [/^\.git(\/|$)/i, /^\.(claude|codex|cursor|grok|opencode|vscode|idea|husky)(\/|$)/i, /^\.mcp\.json$/i, /(^|\/)node_modules(\/|$)/i,
  /^design\/\.local(\/|$)/i, /^\.envrc$/i, /^\.env(\.|$)/i]

export function decide(p: PermitPolicy, tool: string, input: Record<string, unknown>): { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string } {
  const allow = () => ({ behavior: 'allow' as const, updatedInput: input })
  const deny = (message: string) => ({ behavior: 'deny' as const, message })
  if (tool.startsWith('mcp__')) return p.mcp ? allow() : deny('MCP servers are turned off for Jam runs on this canvas')
  if (tool === 'Skill') return p.skills ? allow() : deny('skills are turned off for Jam runs on this canvas')
  if (ALWAYS.has(tool)) return allow()
  if (EDITS.has(tool)) return insideRoot(p.root, input.file_path ?? input.notebook_path) ? allow() : deny('a Jam run edits only inside this repo')
  if (tool === 'Bash') return deny('a Jam run runs commands inside the sandbox only - do it inside it, or say what is left to do in your reply')
  return deny(`a Jam run cannot use ${tool}`)
}

/** The stdio MCP server: initialize, tools/list (one tool, `decide`), tools/call. */
export function permitCommand(): void {
  let p: PermitPolicy
  try { p = JSON.parse(process.env.MARVER_JAM_PERMIT ?? '') } catch { process.exit(1) }
  if (!p || typeof p.root !== 'string') process.exit(1)
  const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
  createInterface({ input: process.stdin }).on('line', (line) => {
    let m: any
    try { m = JSON.parse(line) } catch { return }
    if (m?.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'marver-jam', version: '1' } } })
    else if (m?.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'decide', description: 'Marver Jam answers the permission questions of a background run. Not for use by the agent.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: ['tool_name', 'input'] } }] } })
    else if (m?.method === 'tools/call') {
      const a = m.params?.arguments ?? {}
      const out = decide(p, String(a.tool_name ?? ''), a.input && typeof a.input === 'object' ? a.input : {})
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } })
    } else if (m?.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
  })
}
