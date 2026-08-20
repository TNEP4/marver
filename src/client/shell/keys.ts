/**
 * Node-key identity for comments. Board nodes the file does not key yet used to
 * get a RANDOM key per load - and comments anchor to node keys, so every comment
 * created on a never-saved board orphaned on the next mount: dev board switches
 * and reloads, and every single visit on a published canvas (which can never
 * save keys back). Deriving the key from board + frame + occurrence makes the
 * same board file yield the same keys in every session and for every viewer.
 * Keys stored in the file still win; this only names the unnamed.
 */

/** 64 bits from two independent 32-bit passes (djb2-xor with different seeds):
 *  a single 32-bit hash has practical collisions, and a collision here would
 *  make key assignment depend on which OTHER nodes happen to be present. */
const h32 = (s: string, seed: number): number => {
  let h = seed
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0
  return h >>> 0
}

export function stableNodeKey(board: string, frame: string, salt: number): string {
  const s = `${board}|${frame}|${salt}`
  return 'n_' + h32(s, 5381).toString(36) + h32(s, 52711).toString(36)
}

/**
 * The ONE answer to "which node renders this thread": the stored anchor when that
 * node still exists AND still shows the thread's frame, else the first node showing
 * the frame (adoption - a stale key from a past session, a board rewrite, a deleted
 * copy must degrade to the frame, never to invisible), else null (frame not on this
 * board). Every consumer - pin layer, reveal, the hosting checks - must agree, or
 * a card renders on one node while another claims the hosting behavior.
 */
export function threadHostKey(
  t: { nodeKey?: string; frame?: string },
  nodes: readonly { key: string; frame: string }[],
): string | null {
  if (t.nodeKey && nodes.some((n) => n.key === t.nodeKey && n.frame === t.frame)) return t.nodeKey
  return nodes.find((n) => n.frame === t.frame)?.key ?? null
}
