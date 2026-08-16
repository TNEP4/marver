import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArtifactStore, buildKey, objectHashOf, variantKey } from '../src/server/artifacts.ts'

let root: string
const ENGINE = 'lean-v4/pw-1.62/chrome-140'
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'mv-art-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
const store = () => new ArtifactStore(root, '/__mv/artifacts/v1')

describe('SPEC-M7 artifact store', () => {
  it('buildKey is stable for the same recipe and changes with any input', () => {
    const base = { depRevision: 'a', globalEnvRevision: 'g', theme: 'light', viewport: '1280', routeKey: '/', serializerVersion: 's', browserEngineVersion: 'b' }
    expect(buildKey(base)).toBe(buildKey({ ...base }))
    expect(buildKey({ ...base, theme: 'dark' })).not.toBe(buildKey(base))
    expect(buildKey({ ...base, depRevision: 'z' })).not.toBe(buildKey(base))
    expect(buildKey({ ...base, browserEngineVersion: 'b2' })).not.toBe(buildKey(base))
    expect(buildKey({ ...base, routeKey: '/x' })).not.toBe(buildKey(base))
  })

  it('objectHash is content-addressed (same HTML -> same hash)', () => {
    expect(objectHashOf('<html>a</html>')).toBe(objectHashOf('<html>a</html>'))
    expect(objectHashOf('<html>a</html>')).not.toBe(objectHashOf('<html>b</html>'))
  })

  it('writeReady persists an immutable object + a ready variant, and lookup validates the buildKey', async () => {
    const s = store(); await s.load(ENGINE)
    const key = buildKey({ depRevision: 'r1', globalEnvRevision: 'g', theme: 'light', viewport: '1280', routeKey: '/', serializerVersion: 's', browserEngineVersion: 'b' })
    const vk = variantKey('light', '1280')
    const html = '<!doctype html><html><body>hi</body></html>'
    const v = await s.writeReady('checkout/cart', vk, key, html, [{ path: 'a.tsx', hash: 'h1' }])
    expect(v.status).toBe('ready')
    expect(v.objectHash).toBe(objectHashOf(html))
    // the object file exists at its content-addressed path
    await expect(fs.access(s.objectFilePath(v.objectHash))).resolves.toBeUndefined()
    // lookup returns it for the matching key, and null for a different key (stale)
    expect(await s.lookup('checkout/cart', vk, key)).not.toBeNull()
    expect(await s.lookup('checkout/cart', vk, 'different-key')).toBeNull()
  })

  it('a manifest survives a reload (restart-safe), but a capture-engine bump invalidates the cache', async () => {
    const key = buildKey({ depRevision: 'r1', globalEnvRevision: 'g', theme: 'light', viewport: '1280', routeKey: '/', serializerVersion: 's', browserEngineVersion: 'b' })
    const vk = variantKey('light', '1280')
    const s1 = store(); await s1.load(ENGINE)
    await s1.writeReady('demo/form', vk, key, '<html>x</html>', [])
    // fresh store, same engine -> the ready artifact is still found (no recompile)
    const s2 = store(); await s2.load(ENGINE)
    expect(await s2.lookup('demo/form', vk, key)).not.toBeNull()
    // a different capture engine (serializer/browser bump) wipes the manifest
    const s3 = store(); await s3.load('lean-v5/pw-1.63/chrome-141')
    expect(s3.getVariant('demo/form', vk)).toBeUndefined()
  })

  it('writeStatus records incompatible/dynamic so the compiler does not retry, and never a ready object', async () => {
    const s = store(); await s.load(ENGINE)
    const key = buildKey({ depRevision: 'r1', globalEnvRevision: 'g', theme: 'light', viewport: '1280', routeKey: '/', serializerVersion: 's', browserEngineVersion: 'b' })
    const vk = variantKey('light', '1280')
    const v = await s.writeStatus('demo/canvas', vk, key, 'incompatible', 'canvas element', [])
    expect(v.status).toBe('incompatible')
    expect(v.objectHash).toBe('')
    expect(await s.lookup('demo/canvas', vk, key)).toBeNull()   // incompatible is never a ready lookup hit
  })

  it('invalidateFrame drops a frame so it recompiles; a missing object also fails lookup', async () => {
    const s = store(); await s.load(ENGINE)
    const key = buildKey({ depRevision: 'r1', globalEnvRevision: 'g', theme: 'light', viewport: '1280', routeKey: '/', serializerVersion: 's', browserEngineVersion: 'b' })
    const vk = variantKey('light', '1280')
    const v = await s.writeReady('demo/plain', vk, key, '<html>p</html>', [])
    s.invalidateFrame('demo/plain')
    expect(await s.lookup('demo/plain', vk, key)).toBeNull()
    // even a manifest hit fails lookup if the immutable object was removed from disk
    const s2 = store(); await s2.load(ENGINE)
    await s2.writeReady('demo/plain', vk, key, '<html>p</html>', [])
    await fs.rm(s2.objectFilePath(v.objectHash))
    expect(await s2.lookup('demo/plain', vk, key)).toBeNull()
  })
})
