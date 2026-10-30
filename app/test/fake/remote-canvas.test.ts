/**
 * The remote harness on its own (test/harness/remote-canvas.ts; spec 28 A4.6 #50): its hosts over https with the
 * checked-in certificate and the fingerprint the app's test build accepts, the shell page and its favicon, the favicon
 * that redirects to loopback http, a published canvas's icons with the repo's logo first and a favicon that fails
 * once, the sign-in chain, a download, a 204, pausing and answering again on the same port, and a second server whose
 * certificate is not that one. No Electron.
 */
import { request } from 'node:https'
import { createHash, X509Certificate } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CERT_PEM, LOGO_SVG, PNG, PUBLISHED_ICONS, startRemoteCanvas, TEST_FINGERPRINT, type RemoteCanvas } from '../harness/remote-canvas.ts'
import { sniffLogo } from '../../../src/shared/logo-sniff.ts'

let r: RemoteCanvas
beforeAll(async () => { r = await startRemoteCanvas() })
afterAll(async () => { await r?.close() })

interface Got { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; cert: string }
/** a GET of `<name>.canvas.test` on 127.0.0.1, trusting only the test certificate (as the app's test build does) */
function get(name: string, path: string, port = r.port, ca: Buffer | string = CERT_PEM): Promise<Got> {
  return new Promise((resolve, reject) => {
    const q = request({ host: '127.0.0.1', port, path, servername: `${name}.canvas.test`, headers: { host: `${name}.canvas.test:${port}` }, ca, agent: false }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => {
        const peer = (res.socket as unknown as { getPeerCertificate(): { raw: Buffer } }).getPeerCertificate()
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts), cert: `sha256/${createHash('sha256').update(peer.raw).digest('base64')}` })
      })
    })
    q.on('error', reject)
    q.end()
  })
}

describe('the remote harness (A4.6 #50)', () => {
  it('its hosts over https with the test certificate; the fingerprint is Electron\'s format of it; the app\'s switches', async () => {
    const g = await get('pilot', '/')
    expect(g.status).toBe(200)
    expect(g.cert).toBe(TEST_FINGERPRINT)
    expect(TEST_FINGERPRINT).toBe(`sha256/${createHash('sha256').update(new X509Certificate(CERT_PEM).raw).digest('base64')}`)
    expect(new X509Certificate(CERT_PEM).subjectAltName).toBe('DNS:*.canvas.test, DNS:canvas.test')
    expect(String(g.body)).toContain('<link rel="icon" href="/favicon.png">')
    expect(r.env).toEqual({ MARVER_APP_TEST_HOSTS: 'MAP *.canvas.test 127.0.0.1', MARVER_APP_TEST_REMOTE_CERT: TEST_FINGERPRINT, MARVER_APP_TEST_FRONT_DOOR: `https://door.canvas.test:${r.port}` })
    expect(r.hits('pilot', '/')).toBe(1)
  })

  it('a host\'s page: its title, script and favicon; none at all', async () => {
    r.page('other', { title: 'Other', favicon: null, script: 'window.x = 1' })
    const body = String((await get('other', '/index.html')).body)
    expect(body).toContain('<title>Other</title>')
    expect(body).toContain('window.x = 1')
    expect(body).not.toContain('rel="icon"')
    expect((await get('pilot', '/favicon.png')).body.equals(PNG)).toBe(true)
  })

  it('a published canvas\'s icons in marver build\'s order, the logo an SVG the app sniffs as one; a favicon that fails once', async () => {
    r.page('published', { icons: PUBLISHED_ICONS })
    const body = String((await get('published', '/')).body)
    expect([...body.matchAll(/<link rel="icon" href="([^"]+)">/g)].map((m) => m[1])).toEqual(PUBLISHED_ICONS)
    const logo = await get('published', '/__mv/logo.svg')
    expect([logo.status, String(logo.body), sniffLogo(logo.body)]).toEqual([200, LOGO_SVG, 'svg'])
    for (const path of PUBLISHED_ICONS.slice(1)) expect((await get('published', path)).body.equals(PNG)).toBe(true)
    expect((await get('published', '/favicon-flaky.png')).status).toBe(500)
    expect((await get('published', '/favicon-flaky.png')).body.equals(PNG)).toBe(true)
    expect((await get('pilot', '/favicon-flaky.png')).status).toBe(500)   // once per host
  })

  it('a favicon that redirects to loopback http names the plain server, whose requests are kept', async () => {
    const g = await get('pilot', '/favicon-redirect.png')
    expect(g.status).toBe(302)
    expect(g.headers.location).toBe(`http://127.0.0.1:${r.plain.port}/x.png`)
    expect(r.plain.requests).toEqual([])
  })

  it('the sign-in chain: start to the identity host, back to finish with the code in its hash, which moves on to next - or stalls', async () => {
    const start = await get('pilot', '/__mv/id/start?next=%2F%23%2Fb%2Fplans')
    expect(start.headers.location).toBe(`https://id.canvas.test:${r.port}/login?return=${encodeURIComponent(`https://pilot.canvas.test:${r.port}/__mv/id/finish`)}&next=${encodeURIComponent('/#/b/plans')}`)
    const login = await get('id', new URL(String(start.headers.location)).pathname + new URL(String(start.headers.location)).search)
    expect(login.headers.location).toBe(`https://pilot.canvas.test:${r.port}/__mv/id/finish#code=abc&next=${encodeURIComponent('/#/b/plans')}`)
    expect(String((await get('pilot', '/__mv/id/finish')).body)).toContain('location.replace')
    r.finishStalls = true
    expect(String((await get('pilot', '/__mv/id/finish')).body)).not.toContain('location.replace')
    r.finishStalls = false
  })

  it('a download, a redirect to http, a 204, a page that is not the shell', async () => {
    expect((await get('pilot', '/download')).headers['content-disposition']).toBe('attachment; filename="board.zip"')
    expect((await get('pilot', '/to-http')).headers.location).toBe(`http://pilot.canvas.test:${r.port}/`)
    expect((await get('pilot', '/no-content')).status).toBe(204)
    expect((await get('pilot', '/about')).status).toBe(200)
  })

  it('paused it answers nothing; resumed it answers on the same port', async () => {
    await r.pause()
    await expect(get('pilot', '/')).rejects.toThrow()
    await r.resume()
    expect((await get('pilot', '/')).status).toBe(200)
  })

  it('the bad host\'s certificate is not the test one: refused by a client that trusts only it', async () => {
    await expect(get('pilot', '/', r.bad.port)).rejects.toThrow()
    expect(r.bad.origin('pilot')).toBe(`https://pilot.canvas.test:${r.bad.port}`)
  })
})
