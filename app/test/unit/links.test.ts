/** One parser for a canvas link (src/shared/links.ts; spec 28 A2.7, v1.10 r1 #4). */
import { describe, expect, it } from 'vitest'
import { boardOf, parseLink } from '../../src/shared/links.ts'

describe('parseLink()', () => {
  it('reads a running canvas\'s link on each loopback host, keeping path, query and hash', () => {
    expect(parseLink('http://127.0.0.1:4806/#/b/x')).toEqual({ kind: 'local', port: 4806, rest: '/#/b/x', host: '127.0.0.1:4806', board: 'x' })
    expect(parseLink('http://localhost:4806/?n=1#/b/checkout?f=checkout/plans')).toMatchObject({ kind: 'local', port: 4806, rest: '/?n=1#/b/checkout?f=checkout/plans', board: 'checkout' })
    expect(parseLink('http://[::1]:4806/')).toMatchObject({ kind: 'local', port: 4806, rest: '/', board: null })
  })

  it('takes a bare localhost:<port> as agents print it, and trims', () => {
    expect(parseLink('  localhost:4806/#/b/x  ')).toMatchObject({ kind: 'local', port: 4806, board: 'x' })
    expect(parseLink('127.0.0.1:4807')).toMatchObject({ kind: 'local', port: 4807, rest: '/' })
  })

  it('an https link is a shared canvas (A4.4)', () => {
    expect(parseLink('https://pilot.example.com/')).toEqual({ kind: 'https', url: 'https://pilot.example.com/', host: 'pilot.example.com' })
  })

  it('refuses anything else', () => {
    for (const s of [
      'http://example.com/', 'http://localhost/', 'http://u:p@localhost:4806/', 'https://u:p@pilot.example.com/',
      `http://localhost:4806/${'a'.repeat(2048)}`, 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x',
      'mailto:x@y.z', '', '   ', 'http://localhost:4806/ x', 'http://192.168.1.4:4806/', 'http://localhost:0/', 'ftp://localhost:21/',
    ]) expect(parseLink(s), s).toEqual({ kind: 'bad' })
    for (const v of [null, undefined, 4806, {}, ['http://localhost:4806/']]) expect(parseLink(v)).toEqual({ kind: 'bad' })
  })

  it('names the board of a hash route only', () => {
    expect(boardOf('#/b/flow')).toBe('flow')
    expect(boardOf('#/b/a%20b?f=x')).toBe('a b')
    expect(boardOf('#/x')).toBeNull()
    expect(boardOf('')).toBeNull()
  })
})
