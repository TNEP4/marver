/**
 * The proof's pure parts (spec 28 A2.3, A2.14 #11) and the proved logo fetch (A2.4, A2.10's logo cases): the
 * check against A1's own formula, headers sent twice, the URLs a canvas tab's main frame may load, and a logo
 * dropped for every way a listener can fail it - no proof, another instance, 300 KB, an endless stream, silence,
 * HTML, a redirect - while a PNG named .svg shows as the PNG it is.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { docProof, logoProof } from '../../../src/server/proof.ts'
import { checkProof, commitsNothing, fetchLogo, oneHeaders, probeProof, REDIRECTS, shellDocUrl, unsafePrefs } from '../../src/main/proof.ts'
import type { RegistryEntry } from '../../src/main/registry.ts'

const key = randomBytes(32)
const instance = randomUUID()
const nonce = randomBytes(24).toString('base64url')

describe('checkProof', () => {
  const port = 30003
  const good = { 'x-mv-instance': instance, 'x-mv-proof': docProof(key, nonce, port) }
  const check = (headers: Record<string, string>, o: { kind?: 'doc' | 'logo'; inst?: string } = {}) => checkProof({ headers, nonce, key, port, instance: o.inst ?? instance, kind: o.kind })
  it('passes A1\'s own docProof, and only for that nonce, port and key', () => {
    expect(check(good)).toBe('ok')
    expect(check({ ...good, 'x-mv-proof': docProof(key, nonce, port + 1) })).toBe('proof')
    expect(check({ ...good, 'x-mv-proof': docProof(randomBytes(32), nonce, port) })).toBe('proof')
    expect(check({ ...good, 'x-mv-proof': docProof(key, randomBytes(24).toString('base64url'), port) })).toBe('proof')
  })
  it('a logo proof is not a document proof, and the other way round', () => {
    expect(check({ ...good, 'x-mv-proof': logoProof(key, nonce, port) })).toBe('proof')
    expect(check({ ...good, 'x-mv-proof': logoProof(key, nonce, port) }, { kind: 'logo' })).toBe('ok')
    expect(check(good, { kind: 'logo' })).toBe('proof')
  })
  it('missing headers, another instance, elsewhere, a proof of another length (no throw)', () => {
    expect(check({})).toBe('proof')
    expect(check({ 'x-mv-proof': good['x-mv-proof'] })).toBe('proof')
    expect(check(good, { inst: randomUUID() })).toBe('instance')
    expect(check({ 'x-mv-elsewhere': '1' })).toBe('elsewhere')
    expect(check({ ...good, 'x-mv-proof': 'short' })).toBe('proof')
    expect(check({ ...good, 'x-mv-proof': good['x-mv-proof'] + 'x' })).toBe('proof')
  })
})

describe('oneHeaders', () => {
  it('lowercases, and drops a name sent twice', () => {
    expect(oneHeaders({ 'X-MV-Proof': ['a'], 'x-mv-instance': ['i'] })).toEqual({ 'x-mv-proof': 'a', 'x-mv-instance': 'i' })
    expect(oneHeaders({ 'x-mv-proof': ['a', 'b'], other: ['1'] })).toEqual({ other: '1' })
    expect(oneHeaders({ 'x-mv-proof': ['a'], 'X-Mv-Proof': ['a'] })).toEqual({})
    expect(oneHeaders(undefined)).toEqual({})
  })
})

describe('shellDocUrl: what a canvas tab\'s main frame may load', () => {
  const ready = { port: 30003, origin: 'http://[::1]:30003' }
  const starting = { port: 30003, origin: null }
  const ok = (u: string, e: typeof ready | typeof starting = ready) => shellDocUrl(u, e) !== null
  it('the shell\'s document on the bound origin, with its query and hash', () => {
    expect(ok('http://[::1]:30003/')).toBe(true)
    expect(ok('http://[::1]:30003/index.html?x=1#/b/main')).toBe(true)
  })
  it('never another path, origin, scheme, port, or credentials', () => {
    expect(ok('http://[::1]:30003/__mv/frame/?id=x')).toBe(false)
    expect(ok('http://[::1]:30003/index.htm')).toBe(false)
    expect(ok('http://127.0.0.1:30003/')).toBe(false)
    expect(ok('http://localhost:30003/')).toBe(false)
    expect(ok('https://[::1]:30003/')).toBe(false)
    expect(ok('http://[::1]:30004/')).toBe(false)
    expect(ok('http://u:p@[::1]:30003/')).toBe(false)
    expect(ok('http://example.com:30003/')).toBe(false)
    expect(ok('file:///etc/passwd')).toBe(false)
    expect(ok('not a url')).toBe(false)
  })
  it('while starting (no origin yet): any loopback host on the entry\'s port - the response\'s check decides', () => {
    expect(ok('http://127.0.0.1:30003/', starting)).toBe(true)
    expect(ok('http://[::1]:30003/', starting)).toBe(true)
    expect(ok('http://192.168.1.5:30003/', starting)).toBe(false)
    expect(ok('http://[::1]:30004/', starting)).toBe(false)
  })
})

describe('what a view must be, and what commits nothing', () => {
  const view = (p: Record<string, unknown> | null) => ({ getLastWebPreferences: () => p })
  const ok = { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, disableDialogs: true }
  it('unsafePrefs: sandboxed, isolated, no Node, no webview tags, no dialogs; nothing to tell, nothing refused', () => {
    expect(unsafePrefs(view(ok))).toBe(null)
    expect(unsafePrefs(view({ ...ok, sandbox: false }))).toBe('not sandboxed')
    expect(unsafePrefs(view({ ...ok, sandbox: undefined }))).toBe('not sandboxed')
    expect(unsafePrefs(view({ ...ok, contextIsolation: false }))).toBe('no context isolation')
    expect(unsafePrefs(view({ ...ok, nodeIntegrationInSubFrames: true }))).toBe('Node in its pages')
    expect(unsafePrefs(view({ ...ok, webviewTag: true }))).toBe('webview tags')
    expect(unsafePrefs(view({ ...ok, disableDialogs: false }))).toBe('dialogs not disabled')
    expect(unsafePrefs(view(null))).toBe(null)
    expect(unsafePrefs({})).toBe(null)
  })
  it('a redirect is 301, 302, 303, 307 or 308 - never a 304, which would commit a cached copy unproved', () => {
    expect([301, 302, 303, 307, 308].every((c) => REDIRECTS.has(c))).toBe(true)
    expect([300, 304, 305, 306].some((c) => REDIRECTS.has(c))).toBe(false)
  })
  it('commitsNothing: a 204, a 205 or a download', () => {
    expect(commitsNothing(204, {})).toBe(true)
    expect(commitsNothing(205, {})).toBe(true)
    expect(commitsNothing(200, { 'content-disposition': 'attachment; filename="x"' })).toBe(true)
    expect(commitsNothing(200, { 'content-disposition': 'inline' })).toBe(false)
    expect(commitsNothing(200, {})).toBe(false)
    expect(commitsNothing(500, {})).toBe(false)
  })
})

// ---- the logo ------------------------------------------------------------------------------------------------

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)])
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>')
type Mode = 'honest' | 'unsigned' | 'other-instance' | 'big' | 'endless' | 'silent' | 'html' | 'png-as-svg' | 'redirect' | 'doc'
let server: Server
let port = 0
let mode: Mode = 'honest'
let hits = 0
beforeAll(async () => {
  server = createServer((req, res: ServerResponse) => {
    hits++
    const n = String(req.headers['x-mv-nonce'] ?? '')
    const sign = (inst = instance, kind: 'logo' | 'doc' = 'logo') => ({ 'x-mv-instance': inst, 'x-mv-proof': (kind === 'logo' ? logoProof : docProof)(key, n, port) })
    if (mode === 'doc') {
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html', ...sign(instance, 'doc') }); return res.end('<html>') }
    }
    if (req.url !== '/__mv/logo') { res.writeHead(404); return res.end() }
    switch (mode) {
      case 'honest': res.writeHead(200, { 'content-type': 'image/svg+xml', ...sign() }); return res.end(SVG)
      case 'unsigned': res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(SVG)
      case 'other-instance': res.writeHead(200, { 'content-type': 'image/svg+xml', ...sign(randomUUID()) }); return res.end(SVG)
      case 'big': res.writeHead(200, { 'content-type': 'image/png', ...sign() }); return res.end(Buffer.concat([PNG, Buffer.alloc(300 * 1024)]))
      case 'endless': {
        res.writeHead(200, { 'content-type': 'image/png', ...sign() })
        res.write(PNG)
        const t = setInterval(() => { if (!res.write(Buffer.alloc(16 * 1024))) { /* back-pressure */ } }, 2)
        res.on('close', () => clearInterval(t))
        return
      }
      case 'silent': return   // never answers
      case 'html': res.writeHead(200, { 'content-type': 'text/html', ...sign() }); return res.end('<!doctype html><svg></svg>')
      case 'png-as-svg': res.writeHead(200, { 'content-type': 'image/svg+xml', ...sign() }); return res.end(PNG)
      case 'redirect': res.writeHead(302, { location: '/__mv/logo2', ...sign() }); return res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)) })

const entry = (): RegistryEntry => ({
  file: 'port-x.json', state: 'ready', pid: process.pid, instance, slot: null, port, origin: `http://127.0.0.1:${port}`,
  url: `http://localhost:${port}/`, root: '/tmp/x', name: 'x', version: '0.27.1', features: ['bridge'], ws: '0123456789abcdef', startedAt: 0, key,
})

describe('fetchLogo', () => {
  it('a proved SVG: its type by the bytes, a data: URL', async () => {
    mode = 'honest'
    const l = await fetchLogo(entry())
    expect(l?.type).toBe('svg')
    expect(l?.dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(Buffer.from(l!.dataUrl.split(',')[1], 'base64').equals(SVG)).toBe(true)
  })
  it('a PNG named .svg shows as the PNG it is', async () => {
    mode = 'png-as-svg'
    expect((await fetchLogo(entry()))?.type).toBe('png')
  })
  it('dropped: no proof (a plain server on the port), another instance, HTML, a redirect', async () => {
    for (const m of ['unsigned', 'other-instance', 'html', 'redirect'] as const) {
      mode = m
      expect(await fetchLogo(entry()), m).toBe(null)
    }
  })
  it('dropped: 300 KB, and an endless stream cut at 256 KB', async () => {
    mode = 'big'
    expect(await fetchLogo(entry())).toBe(null)
    mode = 'endless'
    const t0 = Date.now()
    expect(await fetchLogo(entry())).toBe(null)
    expect(Date.now() - t0).toBeLessThan(4000)
  })
  it('dropped at 5 s when nothing answers', async () => {
    mode = 'silent'
    const t0 = Date.now()
    expect(await fetchLogo(entry())).toBe(null)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900)
    expect(Date.now() - t0).toBeLessThan(6500)
  }, 10_000)
  it('never for an entry that is not ready; aborted by the caller', async () => {
    mode = 'honest'
    const before = hits
    expect(await fetchLogo({ ...entry(), state: 'starting', origin: null })).toBe(null)
    expect(hits).toBe(before)
    mode = 'silent'
    const c = new AbortController()
    setTimeout(() => c.abort(), 50)
    const t0 = Date.now()
    expect(await fetchLogo(entry(), c.signal)).toBe(null)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

describe('probeProof', () => {
  it('proved for the canvas\'s own proof, answers for anything else, silent for nothing', async () => {
    mode = 'doc'
    expect(await probeProof(entry())).toBe('proved')
    mode = 'honest'   // `/` now answers 404, unsigned
    expect(await probeProof(entry())).toBe('answers')
    expect(await probeProof({ ...entry(), port: 1, origin: 'http://127.0.0.1:1' })).toBe('silent')
  })
})
