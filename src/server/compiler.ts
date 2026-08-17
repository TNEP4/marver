// SPEC-M7 — the artifact compiler. Drives a persistent headless SYSTEM Chrome (playwright-core,
// channel:'chrome' - no bundled browser) to render each frame via the /__mv/compile harness and persist
// its lean as a durable file. A FRESH, service-worker-blocked browser context per capture (isolation +
// privacy). Bounded concurrency. The serialize + settle happen in the harness page; this drives it.
import type { Browser } from 'playwright-core'
import { ArtifactStore, buildKey, variantKey, type Variant } from './artifacts.ts'

export interface CompileJob {
  frameId: string; theme: string; width: number; height: number; kind: 'tsx' | 'html'
  depRevision: string   // hash of the frame's resolved source closure (restart-safe identity)
}
export interface CompilerOpts { concurrency?: number; globalEnvRevision: string; serializerVersion: string }

interface HarnessResult { ok: boolean; html: string; degraded: string[]; notes?: string[]; note?: string; ms: number }

export class Compiler {
  private browser: Browser | null = null
  private engine = ''
  private launching: Promise<Browser> | null = null
  private baseUrl: string
  private store: ArtifactStore
  private opts: CompilerOpts
  constructor(baseUrl: string, store: ArtifactStore, opts: CompilerOpts) { this.baseUrl = baseUrl; this.store = store; this.opts = opts }

  /** Lazily launch ONE persistent Chrome (cold cost once). Records the exact browser id in the cache key. */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser
    if (this.launching) return this.launching
    this.launching = (async () => {
      // Lazy so the dev server boots (and non-compiling users install) without playwright-core/Chrome.
      const { chromium } = await import('playwright-core')
      const b = await chromium.launch({ channel: 'chrome', headless: true })
      this.engine = `lean/${this.opts.serializerVersion}/chrome-${b.version()}`
      await this.store.load(this.engine)   // (re)load the manifest under the real capture-engine id
      this.browser = b
      return b
    })()
    return this.launching
  }

  browserEngine(): string { return this.browser ? `chrome-${this.browser.version()}` : 'unlaunched' }

  private key(job: CompileJob): string {
    return buildKey({
      depRevision: job.depRevision, globalEnvRevision: this.opts.globalEnvRevision,
      theme: job.theme, viewport: String(job.width), routeKey: job.frameId,
      serializerVersion: this.opts.serializerVersion, browserEngineVersion: this.browserEngine(),
    })
  }

  /** Compile one frame variant. Returns the cached artifact if the buildKey already has a ready object. */
  async compileOne(job: CompileJob): Promise<Variant> {
    const browser = await this.ensureBrowser()
    const vk = variantKey(job.theme, String(job.width))
    const key = this.key(job)
    const cached = await this.store.lookup(job.frameId, vk, key)
    if (cached) return cached
    const ctx = await browser.newContext({ serviceWorkers: 'block' })   // fresh + isolated + no SW state
    try {
      const page = await ctx.newPage()
      const url = `${this.baseUrl}/__mv/compile/?id=${encodeURIComponent(job.frameId)}`
        + `&theme=${encodeURIComponent(job.theme)}&width=${job.width}&height=${job.height}&kind=${job.kind}`
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
      const handle = await page.waitForFunction(() => (window as unknown as { __mvArtifact: unknown }).__mvArtifact, { timeout: 15000 })
      const r = (await handle.jsonValue()) as HarnessResult
      if (r.ok && r.html) return await this.store.writeReady(job.frameId, vk, key, r.html, [{ path: job.frameId, hash: job.depRevision }])
      return await this.store.writeStatus(job.frameId, vk, key, 'incompatible', (r.degraded ?? []).join(',') || r.note || 'degraded', [])
    } finally { await ctx.close() }
  }

  /** Compile many frames with bounded concurrency (the big speed lever). Failures don't fail the batch. */
  async compileMany(jobs: CompileJob[], onDone?: (v: Variant, job: CompileJob) => void): Promise<{ ok: number; failed: number }> {
    const N = Math.max(1, this.opts.concurrency ?? 4)
    const queue = [...jobs]
    let ok = 0, failed = 0
    await Promise.all(Array.from({ length: N }, async () => {
      for (;;) {
        const job = queue.shift(); if (!job) break
        try { const v = await this.compileOne(job); if (v.status === 'ready') ok++; else failed++; onDone?.(v, job) }
        catch { failed++ }
      }
    }))
    return { ok, failed }
  }

  async close(): Promise<void> { const b = this.browser; this.browser = null; this.launching = null; await b?.close() }
}
