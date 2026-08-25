import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { _isPublicAddress, avatarFromResponse, fetchAvatar } from '../src/server/avatar.ts'

/**
 * The one place the canvas fetches an address that arrived in a token.
 *
 * Storing somebody's picture instead of hotlinking it is the right call - it
 * keeps a private canvas from reporting each of its page views to Google, and it
 * survives the URL rotating. The cost is that a self-hosted server, usually
 * sitting inside somebody's own network, now makes an outbound request to a URL
 * it was handed. These are the guards on that, and the rule they all share: any
 * doubt at all returns null, because a picture is decoration and no failure here
 * is worth breaking a sign-in over.
 */
describe('the address rule', () => {
  it('refuses everything a self-hosted canvas could be pointed at internally', () => {
    // Each of these is a real place somebody would want a canvas server to
    // fetch from on their behalf.
    for (const addr of [
      '127.0.0.1', '127.1.2.3',        // the canvas itself, and its neighbours on the box
      '0.0.0.0',
      '10.1.2.3',                       // private
      '172.16.0.1', '172.31.255.255',   // private
      '192.168.1.1',                    // private
      '169.254.169.254',                // cloud metadata - the prize
      '100.64.0.1',                     // carrier-grade NAT
      '224.0.0.1', '255.255.255.255',   // multicast, broadcast
      '::1',                            // loopback
      'fe80::1',                        // link-local
      'fd00::1', 'fc00::1',             // unique local
      '::ffff:127.0.0.1',               // loopback wearing an IPv6 hat
      '::ffff:10.0.0.1',                // private, same trick
      // Found by review: the first version matched PREFIXES on the printed
      // form, so everything below walked past it.
      '::ffff:a00:1',                   // 10.0.0.1 written in hex
      '::ffff:7f00:1',                  // 127.0.0.1 written in hex
      'fe90::1', 'febf::1',             // link-local is fe80::/10, not fe80:
      'fec0::1', 'feff::1',             // site-local, deprecated but routable
      'fd12:3456:789a::1',              // unique local, longer form
      '::',                             // unspecified
      'ff02::1',                        // multicast
      '0:0:0:0:0:ffff:192.168.0.1',     // mapped, written out in full
      // NAT64 (RFC 6052). On an IPv6-only network this is a live route to the
      // address inside it, through the translator - so the well-known prefix
      // is not a public address, it is whatever it carries.
      '64:ff9b::127.0.0.1',
      '64:ff9b::10.0.0.1',
      '64:ff9b::169.254.169.254',       // cloud metadata, one translation away
      '64:ff9b:1::192.168.1.1',
      '64:ff9b:1:a9fe:a9:fe00:808:808', // the /48 encoding, which my decoder got wrong
      // Reserved and special-purpose space that a blocklist simply never named.
      '1::', 'fe00::1', 'fe7f::1',
      '2001:db8::1',                    // documentation
      '2001::1', '2001:2::1', '2001:10::1', // Teredo, benchmarking, ORCHID
      '2002:0a00:0001::1',              // 6to4 carrying 10.0.0.1
    ]) {
      expect(_isPublicAddress(addr), `${addr} must be refused`).toBe(false)
    }
  })

  it('allows ordinary public addresses', () => {
    for (const addr of [
      '8.8.8.8', '142.250.187.206',
      '2a00:1450:4009:81f::200e',       // googleusercontent, in practice
      '2001:4860:4860::8888',            // ordinary allocation inside 2001::/16
      // 3ffe::/16 was the 6bone. It was deprecated and RETURNED to the free
      // pool in 2008, so it is allocatable global unicast now - refusing it
      // would be preserving a fact that stopped being true.
      '3ffe::1',
    ]) {
      expect(_isPublicAddress(addr), `${addr} should be allowed`).toBe(true)
    }
  })
})

describe('fetching a picture', () => {
  let origin: Server
  let base = ''
  let hits = 0

  beforeAll(async () => {
    origin = createServer((req, res) => {
      hits++
      const url = req.url ?? '/'
      if (url === '/ok.png') {
        res.setHeader('content-type', 'image/png')
        return res.end(Buffer.from('89504e470d0a1a0a', 'hex'))
      }
      if (url === '/huge.png') {
        res.setHeader('content-type', 'image/png')
        return res.end(Buffer.alloc(200 * 1024, 1))
      }
      if (url === '/lies.png') {          // an image extension over an HTML body
        res.setHeader('content-type', 'text/html')
        return res.end('<script>alert(1)</script>')
      }
      if (url === '/svg') {               // renders, and can carry script
        res.setHeader('content-type', 'image/svg+xml')
        return res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
      }
      if (url === '/redirect') {
        res.statusCode = 302
        res.setHeader('location', '/ok.png')
        return res.end()
      }
      if (url === '/empty.png') {
        res.setHeader('content-type', 'image/png')
        return res.end()
      }
      res.statusCode = 404
      res.end('no')
    })
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`
  })

  afterAll(async () => { await new Promise<void>((r) => origin.close(() => r())) })

  it('refuses http, whatever it is pointed at', async () => {
    // The loopback server above is reachable and serving a real PNG. The scheme
    // alone must stop it - a canvas is not a proxy.
    expect(await fetchAvatar(`${base}/ok.png`)).toBeNull()
  })

  it('refuses a URL carrying credentials, and anything that is not a URL', async () => {
    expect(await fetchAvatar('https://user:pass@example.test/a.png')).toBeNull()
    expect(await fetchAvatar('not a url')).toBeNull()
    expect(await fetchAvatar('data:image/png;base64,AAAA')).toBeNull()
    expect(await fetchAvatar('file:///etc/passwd')).toBeNull()
  })

  it('refuses an https URL that resolves into private space', async () => {
    // localhost over https: the scheme passes, and the address rule is what
    // stops it. There is nothing listening, so a pass here would be a timeout
    // rather than a hang - but it must not even be attempted.
    const before = hits
    expect(await fetchAvatar('https://localhost/whatever.png')).toBeNull()
    expect(hits, 'nothing should have been requested at all').toBe(before)
  })
})

describe('what comes back is checked, not assumed', () => {
  /** A Response-shaped thing, so the real rules run against real values. */
  const reply = (type: string, body: Buffer | null, ok = true, declared?: number) => ({
    ok,
    headers: {
      get: (n: string) => n.toLowerCase() === 'content-type' ? type
        : n.toLowerCase() === 'content-length' ? String(declared ?? body?.byteLength ?? 0)
        : null,
    },
    // Buffer.from pools its allocations, so `.buffer` is the whole pool rather
    // than these bytes. Slice by the view's own offset or the "response" is
    // 8KB of somebody else's memory.
    arrayBuffer: async () => {
      const b = body ?? Buffer.alloc(0)
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    },
  })

  const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

  it('stores a real bitmap as a data URI', async () => {
    const got = await avatarFromResponse(reply('image/png', PNG))
    expect(got).toMatch(/^data:image\/png;base64,/)
    expect(got).toContain(PNG.toString('base64'))
  })

  it('refuses SVG - it renders like an image and is a document that can carry script', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
    expect(await avatarFromResponse(reply('image/svg+xml', svg))).toBeNull()
  })

  it('refuses anything that is not a bitmap, whatever the URL looked like', async () => {
    for (const type of ['text/html', 'application/json', 'text/plain', '', 'application/octet-stream']) {
      expect(await avatarFromResponse(reply(type, PNG)), type).toBeNull()
    }
  })

  it('ignores the extension and reads the type - a .png serving HTML is HTML', async () => {
    const html = Buffer.from('<script>alert(1)</script>')
    expect(await avatarFromResponse(reply('text/html', html))).toBeNull()
  })

  it('refuses an oversized body even when the header understates it', async () => {
    const huge = Buffer.alloc(200 * 1024, 1)
    // Content-Length lies about the size; the body is what counts.
    expect(await avatarFromResponse(reply('image/png', huge, true, 10))).toBeNull()
  })

  it('stops reading a body that keeps going, rather than buffering it first', async () => {
    // The cap used to be applied to the result of arrayBuffer() - a check
    // performed after the thing it was checking had already been allocated. A
    // chunked response, or one whose Content-Length simply lies, could stream
    // hundreds of megabytes into the process inside the timeout window.
    let pushed = 0
    const chunk = new Uint8Array(16 * 1024)
    const streamed = {
      ok: true,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'image/png' : null) },
      body: {
        getReader: () => ({
          read: async () => {
            pushed += chunk.byteLength
            // Would run for ever if nobody stopped it.
            return { done: false, value: chunk }
          },
          cancel: async () => {},
        }),
      },
      arrayBuffer: async () => { throw new Error('must not buffer the whole body') },
    }
    expect(await avatarFromResponse(streamed as any)).toBeNull()
    // Read past the cap, and then stopped - not "read everything, then judged".
    expect(pushed).toBeGreaterThan(64 * 1024)
    expect(pushed, 'must stop within a chunk of the cap').toBeLessThan(64 * 1024 + 32 * 1024)
  })

  it('refuses an empty body and a failed response', async () => {
    expect(await avatarFromResponse(reply('image/png', Buffer.alloc(0)))).toBeNull()
    expect(await avatarFromResponse(reply('image/png', PNG, false))).toBeNull()
  })

  it('accepts the content-type with parameters attached', async () => {
    expect(await avatarFromResponse(reply('image/jpeg; charset=binary', PNG))).toMatch(/^data:image\/jpeg;/)
  })
})
