/**
 * Which coding agent drives this repo.
 *
 * Live Jam is ON by default, so this is the answer to "on by default with WHAT" - asked
 * once by `init` (which writes the answer into design/config.ts, where it is visible and
 * editable) and again at every dev boot, so a workspace that predates the block - or a
 * human who switched tools - still jams without editing anything.
 *
 * The tool RUNNING us wins: `init` is usually run BY the agent, so its env markers are
 * evidence rather than a guess. Whatever wins must still be on PATH - the daemon has to
 * spawn it.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export type JamAgent = 'claude' | 'codex' | 'cursor' | 'droid' | 'opencode' | 'grok' | 'pi'

/** Ordered by preference when a machine has several installed and none is running us. */
const AGENTS: JamAgent[] = ['claude', 'codex', 'cursor', 'droid', 'opencode', 'grok', 'pi']

/** Env vars each CLI sets in the processes it spawns. Deliberately NOT CODEX_HOME or
 *  ANTHROPIC_API_KEY: those are configuration a human exports by hand, not evidence that
 *  the tool is running right now. (opencode's `AGENT=1` and pi's `AI_AGENT` are skipped
 *  for the same reason in reverse - too generic to prove WHICH tool is running.)
 *  droid and grok set no marker at all in the shells they spawn (verified against the
 *  grok-build source and droid 0.200.0), so they are found by PATH order only. */
const MARKERS: Record<JamAgent, string[]> = {
  claude: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  codex: ['CODEX_SANDBOX', 'CODEX_THREAD_ID'],
  cursor: ['CURSOR_AGENT'],
  droid: [],
  opencode: ['OPENCODE', 'OPENCODE_PID'],
  grok: [],
  pi: ['PI_CODING_AGENT', 'PI_SESSION_ID'],
}

/** The executable each agent name maps to. Only cursor differs: its CLI installs BOTH
 *  `cursor-agent` and a bare `agent` - and grok's installer symlinks `agent` too, so the
 *  short name is a coin flip on a machine with both. The long name is unambiguous. */
export const AGENT_BIN: Record<JamAgent, string> = {
  claude: 'claude', codex: 'codex', cursor: 'cursor-agent', droid: 'droid',
  opencode: 'opencode', grok: 'grok', pi: 'pi',
}

/** The valid `jam.agent` values as an English list - one string, so every surface
 *  (config warning, init note, dev boot line) names the same set and none goes stale. */
export const AGENT_NAMES = `${AGENTS.slice(0, -1).map((a) => `"${a}"`).join(', ')}, or "${AGENTS[AGENTS.length - 1]}"`

/** Is `cmd` an executable FILE on PATH? A direct stat per PATH entry - no spawn, no shell,
 *  so this is safe to call on every dev boot. Two deliberate narrowings, both in service of
 *  "found means spawnable", because arming an agent that cannot run is worse than staying off:
 *
 *  - `isFile`, because a directory carries the execute bit too (it means "traversable"), so an
 *    access check alone would call a folder named `claude` an agent.
 *  - the bare name only, no PATHEXT: the daemon spawns without a shell, and Node cannot run a
 *    Windows `.cmd`/`.bat` shim that way. Finding one would arm a job that fails on every run.
 *
 *  Only ABSOLUTE PATH entries count. An empty entry means the current directory on POSIX, and
 *  a relative one (`.`, `bin`) resolves against it too - and the current directory is the repo
 *  that was just opened, so a `claude` binary shipped inside it is precisely what must never
 *  be found and spawned. */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue
    try {
      const file = join(dir, cmd)
      if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return true }
    } catch { /* missing, or not ours to run - keep looking */ }
  }
  return false
}

/** The agent to jam with, or undefined when this machine has none installed.
 *
 *  One knowingly-imperfect case: agents nest, and env is inherited, so a codex run started
 *  FROM Claude Code carries both marker families and this picks claude. Env has no depth to
 *  read, and walking the process tree to find the nearest agent ancestor costs more than the
 *  case is worth - so the answer is made visible instead of clever: `init` prints the agent
 *  it chose and writes it into design/config.ts, and instructions/jam.md has the agent confirm
 *  that line names the tool it actually is. One word to correct, once per repo. */
export function detectAgent(env: NodeJS.ProcessEnv = process.env): JamAgent | undefined {
  const running = AGENTS.find((a) => MARKERS[a].some((k) => env[k]))
  if (running && onPath(AGENT_BIN[running], env)) return running
  return AGENTS.find((a) => onPath(AGENT_BIN[a], env))
}
