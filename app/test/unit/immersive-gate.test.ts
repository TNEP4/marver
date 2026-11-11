/**
 * Spec 32 C8: main's immersive gate, pure (app/src/main/immersive-gate.ts) - `gateOf` fails on each of its conditions
 * alone, `step` answers each row of C8's table, and the listed paths run through it compose by compose, as views.ts
 * drives it (the grant and `answered` kept between composes; `answered` set only when an answer is sent).
 */
import { describe, expect, it } from 'vitest'
import { gateOf, step, type GateFacts, type Grant, type StepOut, type Wish } from '../../src/main/immersive-gate.ts'

const PASS: GateFacts = {
  active: true, local: true, view: true, page: false, placed: 'full', seeThrough: true, pending: false, htmlFullscreen: false,
  trusted: true, hung: false, gone: false, wish: true,
}

describe('gateOf: C8\'s first paragraph, every condition', () => {
  it('passes with all of them', () => { expect(gateOf(PASS)).toBe(true) })
  const fails: [string, Partial<GateFacts>][] = [
    ['not the active tab (a tab switch)', { active: false }],
    ['a shared canvas', { local: false }],
    ['no view', { view: false }],
    ['a tab page over it', { page: true }],
    ['placed below', { placed: 'below' }],
    ['no placement', { placed: undefined }],
    ['not see-through', { seeThrough: false }],
    ['a navigation pending', { pending: true }],
    ['HTML fullscreen', { htmlFullscreen: true }],
    ['untrusted', { trusted: false }],
    ['hung', { hung: true }],
    ['its entry gone', { gone: true }],
    ['a missing report (no wish on)', { wish: false }],
    ['main ends it (F6)', { mainEnds: true }],
  ]
  for (const [name, f] of fails) it(`fails: ${name}`, () => { expect(gateOf({ ...PASS, ...f })).toBe(false) })
})

describe('step: each row of C8\'s table', () => {
  const W = (on: boolean, n: number): Wish => ({ on, n })
  const rows: [string, { grant: Grant; wish?: Wish; answered?: number; gate: boolean }, StepOut][] = [
    ['on / off (the shell\'s own) / any: none, {on: false} with no end, the strip shown', { grant: 'on', wish: W(false, 2), answered: 1, gate: true }, { grant: 'none', answer: { on: false }, stripShown: true }],
    ['on / off / any - row 1 answers whatever `answered` says (the table writes no "if unanswered" there)', { grant: 'on', wish: W(false, 2), answered: 2, gate: true }, { grant: 'none', answer: { on: false }, stripShown: true }],
    ['on / off / any - answered even when the gate fails', { grant: 'on', wish: W(false, 2), answered: 1, gate: false }, { grant: 'none', answer: { on: false }, stripShown: true }],
    ['on / on / fails (main\'s cause): ended, {on: false, end: true}', { grant: 'on', wish: W(true, 3), answered: 3, gate: false }, { grant: 'ended', answer: { on: false, end: true }, stripShown: true }],
    ['on / on / passes, answered: nothing to send, the strip hidden', { grant: 'on', wish: W(true, 1), answered: 1, gate: true }, { grant: 'on', stripShown: false }],
    ['on / on / passes, unanswered (an off and an on in one compose): {on: true}', { grant: 'on', wish: W(true, 3), answered: 1, gate: true }, { grant: 'on', answer: { on: true }, stripShown: false }],
    ['ended / off / any, unanswered: none in this same compose, {on: false}', { grant: 'ended', wish: W(false, 4), answered: 3, gate: false }, { grant: 'none', answer: { on: false }, stripShown: true }],
    ['ended / off / any, answered: none, nothing sent', { grant: 'ended', wish: W(false, 4), answered: 4, gate: true }, { grant: 'none', stripShown: true }],
    ['ended / on / any, unanswered: refused {on: false}, no end', { grant: 'ended', wish: W(true, 5), answered: 4, gate: true }, { grant: 'ended', answer: { on: false }, stripShown: true }],
    ['ended / on / any, answered: nothing', { grant: 'ended', wish: W(true, 5), answered: 5, gate: true }, { grant: 'ended', stripShown: true }],
    ['none / on / passes: on, {on: true}, the strip hidden', { grant: 'none', wish: W(true, 1), gate: true }, { grant: 'on', answer: { on: true }, stripShown: false }],
    ['none / on / passes after a refusal of the same n (the gate opened later): {on: true} again', { grant: 'none', wish: W(true, 1), answered: 1, gate: true }, { grant: 'on', answer: { on: true }, stripShown: false }],
    ['none / on / fails, unanswered: refused {on: false}', { grant: 'none', wish: W(true, 1), gate: false }, { grant: 'none', answer: { on: false }, stripShown: true }],
    ['none / on / fails, answered: nothing', { grant: 'none', wish: W(true, 1), answered: 1, gate: false }, { grant: 'none', stripShown: true }],
    ['none / off / any, unanswered: {on: false}', { grant: 'none', wish: W(false, 2), answered: 1, gate: true }, { grant: 'none', answer: { on: false }, stripShown: true }],
    ['none / off / any, answered: nothing moves', { grant: 'none', wish: W(false, 2), answered: 2, gate: true }, { grant: 'none', stripShown: true }],
    ['none / no report: nothing to answer', { grant: 'none', gate: true }, { grant: 'none', stripShown: true }],
  ]
  for (const [name, i, out] of rows) it(name, () => { expect(step(i)).toEqual(out) })
})

/** One document's state across composes, as views.ts keeps it: the grant, the last wish, `answered`, what was sent. */
function doc() {
  let grant: Grant = 'none'
  let wish: Wish | undefined
  let answered: number | undefined
  const sent: { n: number; on: boolean; end?: true }[] = []
  let shown = true
  return {
    wish(on: boolean, n: number) { wish = { on, n } },
    compose(gate: boolean, o: { send?: boolean } = {}) {
      const out = step({ grant, ...(wish ? { wish } : {}), ...(answered !== undefined ? { answered } : {}), gate })
      grant = out.grant
      shown = out.stripShown
      if (out.answer && wish && o.send !== false) { sent.push({ n: wish.n, ...out.answer }); answered = wish.n }
    },
    /** a commit: every report replaced, so the grant and `answered` too */
    reload() { grant = 'none'; wish = undefined; answered = undefined },
    get grant() { return grant }, get shown() { return shown }, sent,
  }
}

describe('step: the listed paths, compose by compose', () => {
  it('H on, then H off, then H on again: on, {on: false} with no end (none, never ended), on', () => {
    const d = doc()
    d.wish(true, 1); d.compose(true)
    expect([d.grant, d.shown]).toEqual(['on', false])
    d.wish(false, 2); d.compose(true)
    expect([d.grant, d.shown]).toEqual(['none', true])
    d.wish(true, 3); d.compose(true)
    expect(d.grant).toBe('on')
    expect(d.sent).toEqual([{ n: 1, on: true }, { n: 2, on: false }, { n: 3, on: true }])
  })

  it('H off then H on fast, in one compose: only n 3 is seen, still granted - row 3 answers {on: true}', () => {
    const d = doc()
    d.wish(true, 1); d.compose(true)
    d.wish(false, 2); d.wish(true, 3); d.compose(true)
    expect(d.sent).toEqual([{ n: 1, on: true }, { n: 3, on: true }])
    expect(d.grant).toBe('on')
  })

  it('H off then H on fast, each its own compose: n 2 by row 1, n 3 by row 6', () => {
    const d = doc()
    d.wish(true, 1); d.compose(true)
    d.wish(false, 2); d.compose(true)
    d.wish(true, 3); d.compose(true)
    expect(d.sent.slice(1)).toEqual([{ n: 2, on: false }, { n: 3, on: true }])
  })

  it('main takes it away (a hang): ended, {on: false, end: true} once; the shell\'s off then: none; H again: the gate decides', () => {
    const d = doc()
    d.wish(true, 3); d.compose(true)
    d.compose(false); d.compose(false)
    expect(d.sent).toEqual([{ n: 3, on: true }, { n: 3, on: false, end: true }])
    expect(d.grant).toBe('ended')
    d.wish(false, 4); d.compose(false)
    expect(d.grant).toBe('none')
    expect(d.sent.at(-1)).toEqual({ n: 4, on: false })
    d.wish(true, 5); d.compose(false)
    expect(d.sent.at(-1)).toEqual({ n: 5, on: false })   // refused, no end
    d.compose(true)
    expect(d.sent.at(-1)).toEqual({ n: 5, on: true })    // the gate opened later: granted
  })

  it('a granted document that goes pending gets {on: false, end: true} once; after an abort (same document) it stays ended while the wish is on, and goes none in the compose that sees the wish off', () => {
    const d = doc()
    d.wish(true, 1); d.compose(true)
    d.compose(false)                                       // pending
    d.compose(true)                                        // aborted: pending cleared, the same document
    expect(d.grant).toBe('ended')
    expect(d.shown).toBe(true)                             // the strip does not vanish again
    expect(d.sent.filter((s) => s.end)).toEqual([{ n: 1, on: false, end: true }])
    d.wish(false, 2); d.compose(true)
    expect(d.grant).toBe('none')
  })

  it('an `on` wish while ended gets {on: false} with no end; a refused entry gets {on: false} with no end', () => {
    const e = doc()
    e.wish(true, 1); e.compose(true); e.compose(false)
    e.wish(true, 2); e.compose(true)
    expect(e.sent.at(-1)).toEqual({ n: 2, on: false })
    const r = doc()
    r.wish(true, 1); r.compose(false)
    expect(r.sent).toEqual([{ n: 1, on: false }])
    expect(r.grant).toBe('none')
  })

  it('play left while granted: the wish off answers with no end (Hide UI is left as it was)', () => {
    const d = doc()
    d.wish(true, 1); d.compose(true)
    d.wish(false, 2); d.compose(true)
    expect(d.sent.at(-1)).toEqual({ n: 2, on: false })
  })

  it('a new document (a reload while ended) starts at none with nothing answered: its wish on is granted', () => {
    const d = doc()
    d.wish(true, 1); d.compose(true); d.compose(false)
    expect(d.grant).toBe('ended')
    d.reload()
    d.wish(true, 1); d.compose(true)
    expect(d.grant).toBe('on')
    expect(d.sent.at(-1)).toEqual({ n: 1, on: true })
  })

  it('an answer that could not be sent is answered again by the next compose; once sent, never again', () => {
    const d = doc()
    d.wish(true, 1); d.compose(false, { send: false })
    expect(d.sent).toEqual([])
    d.compose(false); d.compose(false)
    expect(d.sent).toEqual([{ n: 1, on: false }])
  })
})
