/**
 * Frame screenshots without a dependency - the system's own Chrome, driven over CDP
 * (Node 22 ships a WebSocket client, so this is ~zero cost).
 *
 * This exists for Live Jam's verify loop: a jam agent has no shell (deliberately - the job
 * packet carries untrusted text), so "look at what you built" must be a capability the dev
 * server provides, not a command the agent runs. The /api/shot endpoint calls this; the
 * `marver shot` CLI and a plain WebFetch both reach that endpoint.
 *
 * Readiness is DETERMINISTIC, not a sleep: poll until #root (or body, for html frames) has
 * children, then wait for fonts. A frame that never mounts fails with the page's own
 * exception text - which is exactly what the agent needs to fix it.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTE } from '../cli/name.ts'

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]

/** The browser binary to drive, or null. MARVER_CHROME overrides; otherwise first known install. */
export function findChrome(): string | null {
  const env = process.env.MARVER_CHROME
  if (env) return existsSync(env) ? env : null
  return CHROMES.find((p) => existsSync(p)) ?? null
}

export interface ShotRequest { url: string; width: number; height: number; out: string; timeoutMs?: number }
export type ShotResult = { ok: true } | { ok: false; error: string }

const slug = (frameId: string) => frameId.replace(/\//g, '--')

/** Resolve a frame from the manifest and screenshot it - the shared core behind BOTH
 *  transports (the HTTP /api/shot endpoint and the file-drop inbox), so they validate and
 *  name output identically. `origin` is the dev server's own base URL. */
export async function shootFrame(opts: {
  root: string
  viewports: Record<string, { width: number; height: number }>
  frameId: string
  theme: string
  origin: string
}): Promise<{ ok: true; path: string; width: number; height: number } | { ok: false; error: string }> {
  const { root, viewports, frameId, theme, origin } = opts
  if (!/^[a-z0-9-]+$/i.test(theme)) return { ok: false, error: 'invalid theme' }
  let manifest: { frames?: { id: string; file: string; kind: string; viewport?: string }[] } = {}
  try { manifest = JSON.parse(readFileSync(join(root, 'design', 'manifest.json'), 'utf8')) } catch { /* no manifest yet */ }
  const frame = (manifest.frames ?? []).find((f) => f.id === frameId)
  if (!frame) return { ok: false, error: `unknown frame "${frameId}" - ids are in design/manifest.json` }
  const vp = viewports[frame.viewport ?? ''] ?? viewports.mobile ?? { width: 390, height: 844 }
  const shotsDir = join(root, 'design', '.local', 'shots')
  mkdirSync(shotsDir, { recursive: true })
  const rel = `design/.local/shots/${slug(frameId)}--${theme}.png`
  const target = frame.kind === 'html'
    ? `${origin}/${frame.file}?theme=${encodeURIComponent(theme)}`
    : `${origin}${ROUTE}/frame/?id=${encodeURIComponent(frameId)}&theme=${encodeURIComponent(theme)}`
  const result = await capture({ url: target, width: vp.width, height: vp.height, out: join(root, rel) })
  return result.ok ? { ok: true, path: rel, width: vp.width, height: vp.height } : result
}

/** One capture at a time: shots are seconds apart at most, and a Chrome per concurrent
 *  request would stampede the machine mid-jam. */
let chain: Promise<unknown> = Promise.resolve()

export function capture(req: ShotRequest): Promise<ShotResult> {
  const run = chain.then(() => captureNow(req), () => captureNow(req))
  chain = run
  return run
}

async function captureNow({ url, width, height, out, timeoutMs = 30_000 }: ShotRequest): Promise<ShotResult> {
  const bin = findChrome()
  if (!bin) return { ok: false, error: 'no Chrome/Chromium found - install one or set MARVER_CHROME to a browser binary' }

  const profile = mkdtempSync(join(tmpdir(), 'mv-shot-'))
  const chrome = spawn(bin, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  let ws: WebSocket | null = null
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const to = setTimeout(() => reject(new Error('the browser did not expose devtools in time')), 15_000)
      chrome.stderr?.on('data', (d: Buffer) => {
        buf += d
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf)
        if (m) { clearTimeout(to); resolve(m[1]) }
      })
      chrome.on('error', (e) => { clearTimeout(to); reject(e) })
      chrome.on('exit', () => { clearTimeout(to); reject(new Error('the browser exited before exposing devtools')) })
    })

    ws = new WebSocket(wsUrl)
    await new Promise<void>((res, rej) => { ws!.onopen = () => res(); ws!.onerror = () => rej(new Error('devtools socket failed')) })

    let seq = 0
    const pending = new Map<number, (m: any) => void>()
    let lastException = ''
    // If the socket dies (Chrome crashed, or the watchdog killed it), settle every in-flight
    // send so no `await send(...)` hangs forever - a hung capture would otherwise wedge the
    // whole serialized queue (every later shot waits behind it for the rest of the session).
    const failPending = (why: string) => { for (const [id, cb] of pending) { pending.delete(id); cb({ error: { message: why } }) } }
    ws.onclose = () => failPending('devtools socket closed')
    ws.onerror = () => failPending('devtools socket error')
    ws.onmessage = (e) => {
      let m: any
      try { m = JSON.parse(String(e.data)) } catch { return }   // CDP is always JSON; ignore anything else
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails
        lastException = String(d?.exception?.description ?? d?.text ?? '').split('\n')[0]
      }
    }
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<any>((res, rej) => {
        const id = ++seq
        pending.set(id, (m) => m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))
        try { ws!.send(JSON.stringify({ id, method, params, sessionId })) } catch (e) { pending.delete(id); rej(e as Error) }
      })

    // Overall watchdog: kill Chrome past a hard deadline, which closes the socket and rejects
    // any pending send. Covers the CDP calls that have no timeout of their own (setup, the
    // final captureScreenshot) - the readiness loop below bounds itself, these do not.
    watchdog = setTimeout(() => { try { chrome.kill('SIGKILL') } catch { /* already gone */ } }, timeoutMs + 15_000)

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId)
    await send('Page.enable', {}, sessionId)
    await send('Runtime.enable', {}, sessionId)
    // A failed navigation (connection refused, DNS, cert) returns errorText AND still paints
    // Chrome's own error page - which has DOM, so the readiness check below would call it a
    // successful shot. Catch it here so "the site can't be reached" never masquerades as a frame.
    const nav = await send('Page.navigate', { url }, sessionId)
    if (nav?.errorText && nav.errorText !== 'net::ERR_ABORTED') {
      return { ok: false, error: `could not load the frame (${nav.errorText}) - is the dev server reachable at ${new URL(url).origin}?` }
    }

    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < timeoutMs) {
      const r = await send('Runtime.evaluate', {
        expression: `(() => { const el = document.getElementById('root') ?? document.body; return !!el && el.childElementCount > 0 && document.readyState !== 'loading' })()`,
        returnByValue: true,
      }, sessionId).catch(() => null)
      if (r?.result?.value) { ready = true; break }
      await new Promise((r2) => setTimeout(r2, 150))
    }
    if (!ready) return { ok: false, error: `the frame never rendered${lastException ? ` - the page threw: ${lastException}` : ' (no exception surfaced - is the dev server reachable from this machine?)'}` }

    await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true, returnByValue: true }, sessionId).catch(() => null)
    await new Promise((r2) => setTimeout(r2, 250))   // paint settle (images decoded after fonts)

    // A frame that THREW renders the frame-host's error card - which has DOM, so readiness
    // above passed. The host stamps the crash on window.__mvFrameError; surface it so an agent
    // reading only the JSON result (not the PNG) still learns the frame broke.
    const errEval = await send('Runtime.evaluate', { expression: 'window.__mvFrameError || ""', returnByValue: true }, sessionId).catch(() => null)
    const frameError = typeof errEval?.result?.value === 'string' ? errEval.result.value : ''
    if (frameError) return { ok: false, error: `the frame rendered an error - ${frameError}` }

    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
    writeFileSync(out, Buffer.from(String(shot.data), 'base64'))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    if (watchdog) clearTimeout(watchdog)
    try { ws?.close() } catch { /* already gone */ }
    chrome.kill('SIGKILL')
    // rm after the process actually exits - Chrome flushes its profile on the way down
    chrome.once('exit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp cleanup only */ } })
  }
}
