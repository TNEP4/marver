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

export type JamAgent = 'claude' | 'codex'

/** Ordered by preference when a machine has both installed and neither is running us. */
const AGENTS: JamAgent[] = ['claude', 'codex']

/** Env vars each CLI sets in the processes it spawns. Deliberately NOT CODEX_HOME or
 *  ANTHROPIC_API_KEY: those are configuration a human exports by hand, not evidence that
 *  the tool is running right now. */
const MARKERS: Record<JamAgent, string[]> = {
  claude: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  codex: ['CODEX_SANDBOX', 'CODEX_THREAD_ID'],
}

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
  if (running && onPath(running, env)) return running
  return AGENTS.find((a) => onPath(a, env))
}
