/**
 * `marver dev --recover` (spec 28 A1.6). A Jam capture the page could not send waits in that browser's
 * storage, at that page's address and under that workspace key, and goes out the next time a canvas
 * opens there. When the canvas moved (0.27 moved every canvas to a slot; a later start can land on
 * another slot), this starts it again on exactly an earlier address: its port, the address it bound,
 * and the workspace key that run used - never another one. Alone it lists them: the project's recorded
 * addresses, newest first, then the one 0.26 gave the folder.
 */
import { dev, DevStartError, type DevOptions } from '../server/dev.ts'
import { legacyEntry, recoverEntries, recoverTarget, type RecoverEntry } from '../server/slots.ts'
import { workspaceId } from '../server/workspace.ts'
import { NAME } from './name.ts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const when = (t: number): string => {
  const d = new Date(t)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The list `--recover` prints (tests read `^\s+(\d+)\s+(http://localhost:\d+/)`). */
export function formatEntries(root: string, entries: RecoverEntry[]): string[] {
  const own = workspaceId(root)
  const width = Math.max(...entries.map((e) => e.url.length))
  return [
    'addresses this canvas ran on, newest first:',
    ...entries.map((e, i) => `  ${String(i + 1).padStart(2)}  ${e.url.padEnd(width)}  ${e.legacy ? 'the address 0.26 gave it'
      : `bound ${e.bind}  ${e.from ? when(e.from) : '?'} - ${e.until ? when(e.until) : '?'}`}${e.ws !== own ? ' (another workspace key)' : ''}`),
    `start on one: npx ${NAME} dev --recover <n> - then open its link in the browser that made the capture`,
  ]
}

/** `--recover` alone (cac hands over `true`), `--recover <n>` (a number or its string), or `--recover --port <p>`. */
export async function recoverCommand(root: string, which: unknown, port?: number, with_: Pick<DevOptions, 'onFail'> = {}): Promise<void> {
  const listOnly = which === true || which === ''
  if (!listOnly && port !== undefined) throw new DevStartError('give --recover <n>, or --recover --port <p> - not both')
  // 0.26 moved off its hash port when that was taken, and said so: that port, with 0.26's key
  if (port !== undefined) { await dev(root, { ...with_, recover: recoverTarget(legacyEntry(root, port)) }); return }
  const entries = recoverEntries(root)
  if (listOnly) {
    console.log(`\n${formatEntries(root, entries).map((l) => `  ${l}`).join('\n')}\n`)
    return
  }
  const n = Number(which)
  const entry = Number.isInteger(n) && n >= 1 ? entries[n - 1] : undefined
  if (!entry) throw new DevStartError(`no address ${String(which)} - npx ${NAME} dev --recover lists them`)
  await dev(root, { ...with_, recover: recoverTarget(entry) })
}
