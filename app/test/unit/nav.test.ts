/**
 * The navigation adapter's core (spec 28 A2.14 #8), without Electron: each method is one Electron event. The
 * attribution rules - current generation only, one proof one commit, one instance since the last commit, the
 * tab's live instance - and what failures and aborts do to the committed document's trust. The same sequences
 * run against Electron's real events in test/pw/trust-traces.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { NavCore, noHash, type NavEvent } from '../../src/main/nav.ts'

const U = 'http://[::1]:30003/'
const A = 'inst-aaaaaaaa'
const B = 'inst-bbbbbbbb'
function core(live: (i: string) => boolean = () => true) {
  const events: NavEvent[] = []
  const c = new NavCore(live, (e) => events.push(e))
  return { c, events, last: () => events.at(-1) }
}
const proved = (url = U, instance = A) => ({ kind: 'proved' as const, url, instance })

describe('commits', () => {
  it('a proved attempt commits attributed, its hash ignored', () => {
    const { c, last } = core()
    expect(c.stamp()).toBe(null)
    c.start(U + '#/b/main', true, false)
    expect(c.stamp()).toBe(1)
    c.response(1, proved())
    c.frameNavigate(true, 7, 9)
    c.navigate(U + '#/b/main')
    expect(last()).toEqual({ kind: 'commit', gen: 1, url: U, attributed: true, instance: A })
    expect(c.committed()).toEqual({ gen: 1, url: U, attributed: true, instance: A, lost: false })
    expect(c.frame()).toEqual({ processId: 7, routingId: 9 })
    expect(c.commits()).toBe(1)
  })

  it('subframes and same-document navigations start nothing', () => {
    const { c, events } = core()
    c.start(U, false, false)
    c.start(U + '#x', true, true)
    expect(events).toEqual([])
    expect(c.gen()).toBe(0)
  })

  it('an outcome stamped with an older generation is dropped', () => {
    const { c, last } = core()
    c.start(U, true, false)
    c.start(U, true, false)
    c.response(1, proved())
    expect(c.attempt()?.outcome).toBeUndefined()
    c.navigate(U)
    expect(last()).toMatchObject({ kind: 'commit', gen: 2, attributed: false })
  })

  it('a redirect moves the attempt; the final URL is what the proof and the commit must name', () => {
    const { c, last } = core()
    c.start(U, true, false)
    c.redirect(U + 'index.html', true, false)
    expect(c.attempt()?.url).toBe(U + 'index.html')
    c.response(1, proved(U + 'index.html'))
    c.navigate(U + 'index.html#/b/x')
    expect(last()).toMatchObject({ kind: 'commit', attributed: true })
  })

  it('a proof for another URL than the one committed is not attributed', () => {
    const { c, last } = core()
    c.start(U, true, false)
    c.response(1, proved(U + 'index.html'))
    c.navigate(U)
    expect(last()).toMatchObject({ attributed: false })
  })

  it('one proof, one commit: a second commit with no new proof is unattributed', () => {
    const { c, last } = core()
    c.start(U, true, false)
    c.response(1, proved())
    c.navigate(U)
    expect(last()).toMatchObject({ attributed: true })
    c.navigate(U)
    expect(last()).toMatchObject({ attributed: false })
  })

  it('overlapping loads of one URL: the older commits under the newer proof, the newer then finds it used', () => {
    const { c, events } = core()
    c.start(U, true, false)             // gen 1
    c.start(U, true, false)             // gen 2 supersedes
    c.response(1, proved())             // gen 1's answer: dropped, yet counted (same instance)
    c.response(2, proved())
    c.navigate(U)                       // the older document commits
    c.navigate(U)                       // then the newer
    expect(events.filter((e) => e.kind === 'commit').map((e) => (e as { attributed: boolean }).attributed)).toEqual([true, false])
  })

  it('two instances proving since the last commit (a rebind between loads): unattributed', () => {
    const { c, last } = core()
    c.start(U, true, false)
    c.response(1, proved(U, A))
    c.start(U, true, false)
    c.response(2, proved(U, B))
    c.navigate(U)
    expect(last()).toMatchObject({ attributed: false })
  })

  it('an instance that is no longer the tab\'s live one is not attributed', () => {
    const { c, last } = core((i) => i === B)
    c.start(U, true, false)
    c.response(1, proved(U, A))
    c.navigate(U)
    expect(last()).toMatchObject({ attributed: false })
  })

  it('a back-forward restore made no request: never attributed', () => {
    const { c, last } = core()
    c.start(U, true, false)
    c.navigate(U)
    expect(last()).toMatchObject({ attributed: false })
  })
})

describe('failures and aborts', () => {
  it('a failed proof fails the attempt with its why, and the committed document loses trust', () => {
    const { c, last } = core()
    c.start(U, true, false)
    c.response(1, proved())
    c.navigate(U)
    c.start(U, true, false)
    c.response(2, { kind: 'failed', why: 'unverified' })
    c.failLoad(-20, U, true)
    expect(last()).toEqual({ kind: 'fail', gen: 2, url: U, why: 'unverified', code: -20 })
    expect(c.committed()?.lost).toBe(true)
    expect(c.commits()).toBe(2)
  })

  it('elsewhere and gone come from the proof; a network error with no outcome is unreachable', () => {
    for (const why of ['elsewhere', 'gone'] as const) {
      const { c, last } = core()
      c.start(U, true, false)
      c.response(1, { kind: 'failed', why })
      c.failLoad(-20, U, true)
      expect(last()).toMatchObject({ kind: 'fail', why })
    }
    const { c, last } = core()
    c.start(U, true, false)
    c.failLoad(-102, U, true)
    expect(last()).toMatchObject({ kind: 'fail', why: 'unreachable', code: -102 })
  })

  it('a failure for another URL, a subframe, or ERR_ABORTED changes nothing', () => {
    const { c, events } = core()
    c.start(U, true, false)
    c.response(1, proved())
    c.navigate(U)
    const n = events.length
    c.failLoad(-102, 'http://[::1]:30003/other', true)
    c.failLoad(-102, U, false)
    c.failLoad(-3, U, true)
    expect(events.length).toBe(n)
    expect(c.committed()?.lost).toBe(false)
  })

  it('a late failure after the commit takes the trust of what committed', () => {
    const { c } = core()
    c.start(U, true, false)
    c.response(1, proved())
    c.navigate(U)
    c.failLoad(-2, U, true)
    expect(c.committed()).toMatchObject({ attributed: true, lost: true })
  })

  it('an abort (a denied link, a stop, a 204) leaves the committed document trusted', () => {
    const { c, last } = core()
    c.start(U, true, false)
    c.response(1, proved())
    c.navigate(U)
    c.start('https://example.com/', true, false)
    c.failProvisional(-3, true)
    expect(last()).toEqual({ kind: 'abort', gen: 2 })
    expect(c.committed()).toMatchObject({ gen: 1, attributed: true, lost: false })
    c.stopLoading()
    expect(last()).toEqual({ kind: 'abort', gen: 2 })   // told once
  })

  it('did-stop-loading aborts only an attempt that neither committed nor failed', () => {
    const { c, events } = core()
    c.start(U, true, false)
    c.response(1, proved())
    c.navigate(U)
    c.stopLoading()
    expect(events.some((e) => e.kind === 'abort')).toBe(false)
    c.start(U, true, false)
    c.stopLoading()
    expect(events.at(-1)).toEqual({ kind: 'abort', gen: 2 })
  })

  it('an abort does not spoil a later commit of the same attempt', () => {
    const { c, last } = core()
    c.start(U, true, false)
    c.response(1, proved())
    c.failProvisional(-3, true)   // another navigation's abort, misread as this one's
    c.navigate(U)
    expect(last()).toMatchObject({ kind: 'commit', attributed: true })
  })

  it('a renderer gone leaves no committed document', () => {
    const { c } = core()
    c.start(U, true, false)
    c.response(1, proved())
    c.navigate(U)
    c.rendererGone()
    expect(c.committed()).toBeUndefined()
    expect(c.commits()).toBe(2)
  })
})

it('noHash', () => {
  expect(noHash('http://x/#a#b')).toBe('http://x/')
  expect(noHash('http://x/?q')).toBe('http://x/?q')
})
