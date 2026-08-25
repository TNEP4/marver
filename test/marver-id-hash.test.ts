import { describe, expect, it } from 'vitest'

import { safeHash } from '../src/server/marver-id-gate.ts'

/**
 * Where somebody is put back after signing in.
 *
 * A canvas link keeps its board and thread in the fragment, which no server
 * receives - so the gate's script reads it and hands it over on the query
 * string. By the time it arrives here it is an ordinary attacker-reachable
 * parameter: anyone can request /__mv/id/start?next=<anything>. It ends up in
 * location.replace() on this canvas, so a wrong answer is an open redirect.
 */

describe('safeHash - a route on THIS canvas, or nothing', () => {
  it('keeps the deep links people actually share', () => {
    expect(safeHash('#/b/strategy')).toBe('#/b/strategy')
    expect(safeHash('#/b/strategy?c=8a7f-2b')).toBe('#/b/strategy?c=8a7f-2b')
    expect(safeHash('#/b/strategy?n=k1,k2')).toBe('#/b/strategy?n=k1,k2')
    expect(safeHash('#/p/strategy?at=gate/a&device=laptop')).toBe('#/p/strategy?at=gate/a&device=laptop')
  })

  it('REFUSES a protocol-relative hash, which a browser reads as a host', () => {
    expect(safeHash('#//evil.test')).toBeNull()
    expect(safeHash('#///evil.test')).toBeNull()
    expect(safeHash('#/\\evil.test')).toBeNull()
  })

  it('REFUSES dot segments that NORMALISE into an authority', () => {
    // The bug that got through on the identity service's own sanitiser: it
    // looks like a path, passes a shape check, and resolves to a host.
    expect(safeHash('#/..//evil.test')).toBeNull()
    expect(safeHash('#/a/../..//evil.test')).toBeNull()
  })

  it('REFUSES anything that is not a hash route at all', () => {
    for (const bad of [
      'https://evil.test', '//evil.test', '/b/strategy', 'javascript:alert(1)',
      '#', '#b/strategy', 'data:text/html,x', '#javascript:x', '',
    ]) {
      expect(safeHash(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(safeHash(null)).toBeNull()
  })

  it('REFUSES control characters and absurd length', () => {
    const NUL = String.fromCharCode(0)
    expect(safeHash(`#/b/a${NUL}b`)).toBeNull()
    expect(safeHash('#/b/a\nb')).toBeNull()
    expect(safeHash('#/b/a\rb')).toBeNull()
    expect(safeHash(`#/b/${'x'.repeat(600)}`)).toBeNull()
  })

  it('never returns something that leaves this canvas', () => {
    const hostile = [
      '#//evil.test', '#/\\evil.test', '#/..//evil.test', '#///evil.test',
      '#/a/../..//evil.test', '#/%2f%2fevil.test', '#//evil.test/%2e%2e',
      '#//google.com\\@evil.test', '#/.//evil.test',
    ]
    for (const h of hostile) {
      const out = safeHash(h)
      if (out === null) continue
      // Whatever survives must still resolve back to this canvas.
      expect(new URL(out, 'https://canvas.invalid/').origin, h).toBe('https://canvas.invalid')
      expect(out.startsWith('#//'), h).toBe(false)
    }
  })
})
