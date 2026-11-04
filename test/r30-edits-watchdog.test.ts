import { describe, expect, it } from 'vitest'
import { canAutoReload, shouldArmReadyWatch, silenceAction, type ReadyNode } from '../src/client/shell/canvas/ready-watch.ts'

/** The watchdog's silence, as a line says it (spec 30 #20): its action is what the watchdog then does - pure, beside the
 *  policy test/ready-watch.test.ts covers. The line itself is r30-edits-browser.test.ts's. */
const n = (over: Partial<ReadyNode> = {}): ReadyNode => ({ status: 'loading', ...over })

describe('what a silence comes to', () => {
  it('the first is a retry, the one after it gives up', () => {
    expect(silenceAction(n(), true)).toBe('retry')
    expect(silenceAction(n({ readyRetried: true }), true)).toBe('gave-up')
  })
  it('says what the watchdog does: a retry only where a retry is allowed', () => {
    for (const node of [n(), n({ readyRetried: true })]) {
      expect(silenceAction(node, true) === 'retry').toBe(shouldArmReadyWatch(node, true))
      expect(silenceAction(node, true) === 'retry').toBe(canAutoReload(node))
    }
  })
})
