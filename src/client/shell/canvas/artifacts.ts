// SPEC-M7 (client) — holds the frameId -> variantKey -> artifact href map produced by the server
// compiler, fetched once on boot and kept live via the `sh:artifact` dev-socket event. FrameNode reads
// `artifactHref` to load a frame's prebuilt lean FILE directly (iframe src), instead of compiling it in
// the browser. Pool mode only; no-op without a dev socket / when the endpoint is absent.
import { ROUTE } from '../../const.ts'

type Variant = { href: string; status: string }
let map: Record<string, Record<string, Variant>> = {}   // frameId -> "theme@width" -> {href,status}
const listeners = new Set<() => void>()
const notify = () => { for (const l of listeners) l() }

export const onArtifacts = (cb: () => void): (() => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }

/** The served URL of a frame's ready artifact for this theme+width, or null (compile pending / not built). */
export function artifactHref(frameId: string, theme: string, width: number): string | null {
  const v = map[frameId]?.[`${theme}@${width}`]
  return v && v.status === 'ready' && v.href ? v.href : null
}

let started = false
/** Fetch the artifact manifest (which also kicks off the server's background compile) and subscribe to
 *  per-frame completions. Idempotent. */
export async function initArtifacts(): Promise<void> {
  if (started) return
  started = true
  const load = async () => {
    try {
      const data = await (await fetch(`${ROUTE}/api/artifacts`)).json() as { frames?: Record<string, { variants: Record<string, Variant> }> }
      map = Object.fromEntries(Object.entries(data.frames ?? {}).map(([id, fa]) => [id, fa.variants]))
      notify()
    } catch { /* endpoint absent (published build / older server) - stay empty, snapshots.ts is the fallback */ }
  }
  await load()
  const hot = (import.meta as unknown as { hot?: { on: (e: string, cb: (m: unknown) => void) => void } }).hot
  hot?.on('sh:artifact', (m) => {
    const a = m as { frameId?: string; variant?: string; href?: string; status?: string }
    if (!a?.frameId || !a.variant) return
    ;(map[a.frameId] ??= {})[a.variant] = { href: a.href ?? '', status: a.status ?? '' }
    notify()
  })
  // a second load shortly after boot catches frames compiled before we subscribed
  setTimeout(load, 1500)
}
