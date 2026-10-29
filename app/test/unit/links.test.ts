/** One parser for a canvas link (src/shared/links.ts; spec 28 A2.7, v1.10 r1 #4). */
import { describe, expect, it } from 'vitest'
import { boardOf, loopbackHost, parseLink, remoteFavicon, remoteStart, shellDestination, shellPath } from '../../src/shared/links.ts'

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

  it('an https link to a loopback host is no canvas link (A4.6 #39): every spelling URL normalises to, and the unspecified address', () => {
    for (const s of [
      'https://localhost/', 'https://localhost:4806/#/b/x', 'https://LOCALHOST./', 'https://app.localhost/', 'https://127.0.0.1/', 'https://127.9.8.7:8443/',
      'https://127.1/', 'https://0x7f.1/', 'https://[::1]/', 'https://[0:0:0:0:0:0:0:1]:4806/', 'https://0.0.0.0/', 'https://[::]/', 'https://[::ffff:127.0.0.1]/',
    ]) expect(parseLink(s), s).toEqual({ kind: 'bad' })
    for (const h of ['localhost', 'a.b.localhost', '127.0.0.1', '127.255.0.1', '0.0.0.0', '[::1]', '[::]', '[::ffff:7f00:1]']) expect(loopbackHost(h), h).toBe(true)
    for (const h of ['localhost.example.com', '128.0.0.1', '10.0.0.1', '[2001:db8::1]', 'pilot.example.com', 'mylocalhost']) expect(loopbackHost(h), h).toBe(false)
  })

  it('a bare non-loopback host reads as https, a bare loopback one as a local link; a bare word is no link (A4.6 #39)', () => {
    expect(parseLink('pilot.example.com/#/b/flow')).toEqual({ kind: 'https', url: 'https://pilot.example.com/#/b/flow', host: 'pilot.example.com' })
    expect(parseLink('pilot.example.com:8443')).toEqual({ kind: 'https', url: 'https://pilot.example.com:8443/', host: 'pilot.example.com:8443' })
    expect(parseLink('localhost:4806/#/b/x')).toMatchObject({ kind: 'local', port: 4806 })
    for (const s of ['pilot', 'u:p@pilot.example.com', 'localhost', `pilot.example.com/${'a'.repeat(2048)}`]) expect(parseLink(s), s).toEqual({ kind: 'bad' })
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

  it('a shared tab starts at its opening link, or its origin and / under /__mv/ (A4.6 r1 #9)', () => {
    expect(remoteStart('https://pilot.example.com/#/b/flow?f=x')).toBe('https://pilot.example.com/#/b/flow?f=x')
    expect(remoteStart('https://pilot.example.com/other/page?q=1')).toBe('https://pilot.example.com/other/page?q=1')
    for (const u of ['https://pilot.example.com/__mv/id/start?next=/', 'https://pilot.example.com/__mv/id/finish#code=abc', 'https://pilot.example.com/__mv']) {
      expect(remoteStart(u), u).toBe('https://pilot.example.com/')
    }
  })

  it('its place moves only to a shell page of its own origin - never a sign-in route, another page or another origin (A4.6 r1 #9)', () => {
    const o = 'https://pilot.example.com'
    for (const u of [`${o}/`, `${o}/#/b/plans`, `${o}/index.html?n=1#/b/x?f=y`, `${o}/?share=1`]) expect(shellDestination(o, u), u).toBe(true)
    for (const u of [
      `${o}/__mv/id/start?next=%2F`, `${o}/__mv/id/finish#code=abc`, `${o}/__mv/logo.svg`, `${o}/other/page`, `${o}/index.htm`,
      'https://id.marver.design/login', 'https://accounts.google.com/o/oauth2/auth', 'https://pilot.example.com:8443/', 'http://pilot.example.com/',
      'https://u:p@pilot.example.com/', 'not a url',
    ]) expect(shellDestination(o, u), u).toBe(false)
  })

  it('a shared tab\'s favicon: https on its own origin, its document there too - never a sign-in host\'s or another site\'s (A4.6 #46)', () => {
    const o = 'https://pilot.example.com'
    expect(remoteFavicon(`${o}/favicon.png`, o, `${o}/#/b/x`)).toBe(true)
    expect(remoteFavicon(`${o}/__mv/logo.svg`, o, `${o}/index.html`)).toBe(true)
    for (const [url, doc] of [
      ['https://id.marver.design/favicon.ico', 'https://id.marver.design/login'],   // during sign-in: its document elsewhere
      [`${o}/favicon.png`, 'https://id.marver.design/login'],
      ['https://cdn.example.com/icon.png', `${o}/`],
      [`http://pilot.example.com/favicon.png`, `${o}/`],
      ['https://u:p@pilot.example.com/favicon.png', `${o}/`],
      ['https://pilot.example.com:8443/favicon.png', `${o}/`],
      ['data:image/png;base64,AAAA', `${o}/`],
      [`${o}/favicon.png`, 'chrome-error://chromewebdata/'],
    ]) expect(remoteFavicon(url, o, doc), `${url} on ${doc}`).toBe(false)
    expect(remoteFavicon(undefined, o, `${o}/`)).toBe(false)
  })

  it('names the board of a hash route only', () => {
    expect(boardOf('#/b/flow')).toBe('flow')
    expect(boardOf('#/b/a%20b?f=x')).toBe('a b')
    expect(boardOf('#/x')).toBeNull()
    expect(boardOf('')).toBeNull()
  })
})
