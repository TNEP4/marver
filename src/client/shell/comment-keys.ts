/**
 * The comment keys, one implementation (spec 39 B4/B5): C (comment mode), ⇧C (pins), ⇧L (laser comment) and the
 * comments-first Escape - shared by the shell's key handler, the comment button, drawing play and the keys a drawing
 * forwards from inside its frame, so the unplaced, stopped, locked, laser and toast rules can never drift apart.
 */
import { useStore, stoppedFor } from './store.ts'
import { useComments, NO_COMMENTS_HERE } from './comments-store.ts'
import { UNPLACED } from './hash.ts'
import { cmd, type CmdOpts, type CmdHandle } from './commands.ts'

const comments = () => useComments.getState()

/** May this viewer comment on the current board? (spec 39 B5) - 'locked' is a published view-only role */
export function commentGate(): 'ok' | 'locked' | 'stopped' | 'unplaced' {
  const c = comments(), s = useStore.getState()
  if (s.board === UNPLACED) return 'unplaced'
  if (c.me && c.myBoards && c.myBoards[s.board] === 'view') return 'locked'
  return 'ok'
}

/** C: comment mode on or off. */
export function toggleCommentMode(how: CmdOpts): CmdHandle {
  const c = comments(), s = useStore.getState()
  const h = cmd('comments', how)
  if (!c.commentMode) {
    const g = commentGate()
    if (g === 'unplaced') { h.noop('unplaced'); s.toast(NO_COMMENTS_HERE); return h }
    if (g === 'locked') { h.noop('locked'); s.toast('commenting is not available for you yet - the comment button asks the owner'); return h }
    if (stoppedFor('Comments need the canvas running')) { h.noop('stopped'); return h }
    s.setLaser(false)
  }
  c.setMode(!c.commentMode)
  s.toast(c.commentMode ? 'comment mode off' : 'comment mode - click an element in a frame')
  return h
}

/** ⇧C: pins shown or hidden. */
export function togglePins(how: CmdOpts): void {
  const c = comments()
  cmd('pins', how)
  c.setShow(!c.show)
}

/** ⇧L: the lighting on the element a comment tags. */
export function toggleLaserComment(how: CmdOpts): void {
  const c = comments()
  cmd('laser-comment', how)
  c.setShowAnchor(!c.showAnchor)
  useStore.getState().toast(c.showAnchor ? 'laser comment off' : 'laser comment on')
}

/** Escape, comments first (every surface): comment mode, an open thread or a draft close before anything else does.
 *  True when it took the key - the caller then does not leave drawing mode, play or the selection. */
export function commentsEscape(h: CmdHandle): boolean {
  const c = comments()
  if (!(c.commentMode || c.active || c.draft)) return false
  h.step('comments-off')
  c.setMode(false); c.setActive(null); c.setDraft(null)
  return true
}
