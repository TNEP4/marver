import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { routesMiddleware } from '../src/server/routes.ts'
import { appProof, docProof, NONCE, type DocProof } from '../src/server/proof.ts'
import { ROUTE } from '../src/cli/name.ts'

/**
 * The document proof (spec 28 A1.4): the shell's document, asked for with a nonce, comes back signed
 * with the slot file's key - and nothing else ever does. The math is pinned, so the Mac app can compute
 * the same: HMAC-SHA256 over `doc|<nonce>|<port>`, base64url.
 */

const clientDir = join(import.meta.dirname, '..', 'src', 'client')
const key = Buffer.alloc(32, 7)
const proof: DocProof = { instance: 'the-instance', key, port: 4806 }
const nonce = 'abcdefghijklmnopqrstuvwxyz012345'   // 32 base64url characters

function get(path: string, headers: Record<string, unknown> = {}, opts: { proof?: DocProof; method?: string; failTransform?: boolean } = { proof }) {
  const server: any = {
    config: { root: '/nowhere' },
    transformIndexHtml: async (_url: string, html: string) => { if (opts.failTransform) throw new Error('broken'); return html },
  }
  const mw = routesMiddleware(server, clientDir, undefined, opts.proof)
  return new Promise<{ status: number; headers: Record<string, string>; next: boolean }>((resolve) => {
    const res: any = { statusCode: 200, headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v }, end() { resolve({ status: this.statusCode, headers: this.headers, next: false }) } }
    void mw({ url: path, method: opts.method ?? 'GET', headers } as any, res, () => resolve({ status: 0, headers: res.headers, next: true }))
  })
}
const expected = (n: string, port = 4806) => createHmac('sha256', key).update(`doc|${n}|${port}`).digest('base64url')

describe('the document proof (A1.4)', () => {
  it('the shell\'s document with a nonce: the instance, and a proof that verifies', async () => {
    for (const path of ['/', '/index.html', '/?x=1']) {
      const r = await get(path, { 'x-mv-nonce': nonce })
      expect(r.status).toBe(200)
      expect(r.headers['x-mv-instance']).toBe('the-instance')
      expect(r.headers['x-mv-proof']).toBe(expected(nonce))
      expect(r.headers['x-mv-proof']).toMatch(/^[A-Za-z0-9_-]{43}$/)   // base64url, no padding
    }
  })

  it('without a nonce, nothing changes', async () => {
    const r = await get('/')
    expect(r.status).toBe(200)
    expect(r.headers).not.toHaveProperty('x-mv-proof')
    expect(r.headers).not.toHaveProperty('x-mv-instance')
  })

  it('anything that is not a nonce is ignored: too short, too long, other characters, more than one', async () => {
    for (const bad of ['a'.repeat(15), 'a'.repeat(65), `${'a'.repeat(20)}+/=`, `${'a'.repeat(20)} `, [nonce, nonce], '']) {
      const r = await get('/', { 'x-mv-nonce': bad })
      expect(r.status).toBe(200)
      expect(r.headers, JSON.stringify(bad)).not.toHaveProperty('x-mv-proof')
    }
    for (const ok of ['a'.repeat(16), 'a'.repeat(64)]) expect((await get('/', { 'x-mv-nonce': ok })).headers['x-mv-proof']).toBe(expected(ok))
  })

  it('never on another page: frame host, stage, anything else', async () => {
    for (const path of [`${ROUTE}/frame/?id=x`, `${ROUTE}/stage/`, `${ROUTE}/bridge.js`, '/design/scenes/a.html', '/unknown', '/index.htm']) {
      const r = await get(path, { 'x-mv-nonce': nonce })
      expect(r.headers, path).not.toHaveProperty('x-mv-proof')
      expect(r.headers, path).not.toHaveProperty('x-mv-instance')
    }
  })

  it('never on a failed page, a request that is not a GET, or a canvas with no key (a build)', async () => {
    const failed = await get('/', { 'x-mv-nonce': nonce }, { proof, failTransform: true })
    expect(failed.status).toBe(500)
    expect(failed.headers).not.toHaveProperty('x-mv-proof')
    for (const method of ['HEAD', 'POST']) expect((await get('/', { 'x-mv-nonce': nonce }, { proof, method })).headers).not.toHaveProperty('x-mv-proof')
    expect((await get('/', { 'x-mv-nonce': nonce }, {})).headers).not.toHaveProperty('x-mv-proof')
  })

  it('the math, pinned', () => {
    expect(docProof(key, nonce, 4806)).toBe(expected(nonce))
    expect(docProof(key, nonce, 4807)).not.toBe(expected(nonce))
    expect(appProof(key, 4806)).toBe(createHmac('sha256', key).update('app|4806').digest('base64url'))
    expect(appProof(Buffer.alloc(32, 1), 4805)).toBe('qa-8BfONEDtk2Snz2yGeCU1IBqCko97vHjnEpMxVJno')
    expect(NONCE.test('A-z_0'.repeat(4))).toBe(true)
  })
})
