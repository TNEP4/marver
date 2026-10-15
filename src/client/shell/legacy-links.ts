/**
 * Links from before 0.25 (spec 26, Part 7). The built-in All Scenes board is gone, but links naming
 * it live on in messages, docs and threads - each one lands on a real board:
 *
 *   ?c=<thread>        the first board (sidebar order, archive boards last) that shows its frame
 *   ?f= / ?s=          the board that shows most of them (the first on a tie), those selected, and a
 *                      notice naming where the others are; the Not on a board view only when none
 *                      of them is on a board
 *   ?n=<keys>          the keys turned back into frames - from a leftover all-scenes.json, or the
 *                      keys the old board minted (keys.ts) - then as above; none recovered: the
 *                      landing board, with a notice
 *   #/p/all-scenes     plays on the first board that shows its frame; device, theme and mode kept
 *   #/b/all-scenes     the landing board
 */
import { ALL_SCENES } from '../../shared/board-tree.ts'
import { stableNodeKey } from './keys.ts'
import { UNPLACED, type HashState } from './hash.ts'
import { boardLabel, fetchMembership, PUBLISHED } from './store.ts'
import { useComments } from './comments-store.ts'
import { ROUTE } from '../const.ts'

export const isLegacyLink = (h: HashState): boolean => h.board === ALL_SCENES

/** Where an old link lands now: the hash to apply instead (no board = the landing board), and what
 *  to say about it. */
export async function landLegacy(h: HashState): Promise<{ hash: HashState; notice: string | null }> {
  const { board: _old, n, f, s, c, ...rest } = h
  let m: Awaited<ReturnType<typeof fetchMembership>>
  try { m = await fetchMembership() } catch { return { hash: rest, notice: 'could not read the boards - opened the first one' } }
  const live = [...new Set([...m.boards.flatMap((b) => b.frames), ...m.unplaced])]
  // a frame on no board has the Not on a board view in dev; a published canvas ships no such frame
  const home = (frame: string): string | undefined =>
    m.boards.find((b) => b.frames.includes(frame))?.name ?? (!PUBLISHED && m.unplaced.includes(frame) ? UNPLACED : undefined)

  if (h.play) return { hash: { ...rest, board: h.play.at ? home(h.play.at) : undefined }, notice: null }
  if (c) {
    const t = await useComments.getState().findThread(c)
    return { hash: { ...rest, board: t?.frame ? home(t.frame) : undefined, c }, notice: t ? null : 'that thread is not on this canvas any more' }
  }

  const frames = new Set([...(f ?? []), ...live.filter((id) => s?.some((sc) => id.startsWith(`${sc}/`)))].filter((id) => live.includes(id)))
  if (n?.length) {
    // node keys: the leftover file's, else the ones the old board gave each frame (it minted them all)
    const byKey = new Map(live.map((id) => [stableNodeKey(ALL_SCENES, id, 0), id]))
    if (!PUBLISHED) {
      try {
        const leftover = (await (await fetch(`${ROUTE}/api/boards/${ALL_SCENES}`)).json())?.board as { nodes?: { key?: unknown; frame?: unknown }[] } | null
        for (const node of Array.isArray(leftover?.nodes) ? leftover.nodes : []) if (typeof node?.key === 'string' && typeof node.frame === 'string') byKey.set(node.key, node.frame)
      } catch { /* no leftover, or not JSON: the minted keys stand */ }
    }
    for (const k of n) { const id = byKey.get(k); if (id && live.includes(id)) frames.add(id) }
    if (!frames.size) return { hash: rest, notice: 'the frames that link named could not be found - opened the first board' }
  }
  if (!frames.size) return { hash: rest, notice: null }

  // the board that shows most of them, the first in sidebar order on a tie
  const asked = [...frames]
  let best: { name: string; frames: string[] } | null = null, most = 0
  for (const b of m.boards) { const k = asked.filter((id) => b.frames.includes(id)).length; if (k > most) { best = b; most = k } }
  if (!best) {
    const anyUnplaced = !PUBLISHED && asked.some((id) => m.unplaced.includes(id))
    return { hash: { ...rest, ...(anyUnplaced ? { board: UNPLACED, f: asked } : {}) }, notice: anyUnplaced ? null : 'those frames are on no board - opened the first one' }
  }
  const here = asked.filter((id) => best!.frames.includes(id))
  const elsewhere = asked.filter((id) => !here.includes(id)).map((id) => { const b = home(id); return `${id} is ${b === UNPLACED ? 'on no board' : b ? `on ${boardLabel(b)}` : 'not shipped'}` })
  return { hash: { ...rest, board: best.name, f: here }, notice: elsewhere.length ? `${here.length} of ${asked.length} here - ${elsewhere.join('; ')}` : null }
}
