import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Spec 31 B.2's other half (Codex r3): resolve-all checks Jam's queue and appends in one synchronous step - which holds
 * only if the page's comment write appends a tag AND ledgers it as the owner's in one step too. An `await` between the
 * two would let a resolve-all see the tag in the log, not ledgered, and close its thread before its card exists.
 */
describe('the comment write appends and ledgers in one synchronous step', () => {
  it('nothing is awaited between appendEvents and the ledger line in the dev comments POST', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'api.ts'), 'utf8')
    const at = src.indexOf('const fresh = appendEvents(dir, cm[1], stamped)')
    const to = src.indexOf("record(root, cm[1], ev.id)", at)
    expect(at).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(at)
    expect(src.slice(at, to)).not.toMatch(/\bawait\b/)
  })
})
