/** One parser for a canvas link (src/shared/links.ts; spec 28 A2.7, v1.10 r1 #4). */
import { describe, expect, it } from 'vitest'
import { boardOf, parseLink, shellPath } from '../../src/shared/links.ts'

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

  it('only the canvas\'s own page: a frame\'s file, an API or any other path on a canvas\'s port is not a canvas link (A2.14 #11)', () => {
    expect(parseLink('http://localhost:4806/index.html?n=1#/b/x')).toMatchObject({ kind: 'local', rest: '/index.html?n=1#/b/x', board: 'x' })
    for (const s of ['http://localhost:4806/design/frames/x.html', 'localhost:4806/api/boards', 'http://[::1]:4806//evil.com/', 'http://127.0.0.1:4806/index.htm', 'http://localhost:4806/__mv/logo']) {
      expect(parseLink(s), s).toEqual({ kind: 'bad', why: 'page', port: 4806 })
    }
  })

  it('shellPath keeps the shell\'s own document, its query and hash, and nothing else', () => {
    expect(shellPath('/#/b/flow?f=x')).toBe('/#/b/flow?f=x')
    expect(shellPath('/index.html?n=1#/b/x')).toBe('/index.html?n=1#/b/x')
    for (const p of ['/other', 'x', 3, `/#${'a'.repeat(2048)}`, '//evil.com/']) expect(shellPath(p)).toBe('/')
  })

  it('names the board of a hash route only', () => {
    expect(boardOf('#/b/flow')).toBe('flow')
    expect(boardOf('#/b/a%20b?f=x')).toBe('a b')
    expect(boardOf('#/x')).toBeNull()
    expect(boardOf('')).toBeNull()
  })
})
