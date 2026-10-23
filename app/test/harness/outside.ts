/**
 * Reading the app from outside (spec 28 A3.8 #2, #47-#49): what the budgets measure, never asked of the app about
 * itself. Owner: the flash and native acceptance stream; the unloading stream's effect report reads it too.
 *
 * - `childrenOf(pid)`: `pgrep -P`, the browser's helpers;
 * - `footprintMB(pids)`: `/usr/bin/footprint -p` (Activity Monitor's Memory), one call for many pids; a pid it
 *   cannot read is missing - a memory gate is then inconclusive, never passed on RSS;
 * - `cpuTimes(pids)`: `procusage.swift` (`proc_pid_rusage`, RUSAGE_INFO_V4, mach ticks converted with
 *   `mach_timebase_info`): each process's own CPU plus its reaped children's (`ri_child_user_time` +
 *   `ri_child_system_time`), so a helper that lived wholly between two reads is counted (A3.8 r2 #1); a pid it
 *   cannot read is missing - the run is then inconclusive;
 * - `rssMB(pids)`: `ps`, reported, never gated.
 * Every spawn is `execFile` with an absolute path. Reading order errs against the app: the browser before its
 * children at the start, after them at the end.
 *
 * FROZEN signatures (A3.8 #53).
 */

/** One process as the CPU gate reads it: its own CPU and its reaped children's, seconds. */
export interface CpuRead { pid: number; startedAt: number; ownS: number; childrenS: number }

/** The helper's exit code when it cannot read: the run is inconclusive. */
export const PROCUSAGE_UNREADABLE = 3

export async function childrenOf(pid: number): Promise<number[]> {
  void pid
  throw new Error('outside.ts: not built yet (spec 28 A3.8 #47)')
}

export async function footprintMB(pids: readonly number[]): Promise<Map<number, number>> {
  void pids
  throw new Error('outside.ts: not built yet (spec 28 A3.8 #48)')
}

export async function cpuTimes(pids: readonly number[]): Promise<Map<number, CpuRead>> {
  void pids
  throw new Error('outside.ts: not built yet (spec 28 A3.8 #49)')
}

export async function rssMB(pids: readonly number[]): Promise<Map<number, number>> {
  void pids
  throw new Error('outside.ts: not built yet (spec 28 A3.8 #47)')
}
