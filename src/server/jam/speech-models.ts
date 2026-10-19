/**
 * The speech model, on this Mac (spec 27, Part 4): Parakeet TDT 0.6B v3 (int8) transcribes, Silero VAD
 * cuts phrases. Downloaded once - only after you say yes - to `~/.marver/models/`, and every file is
 * checked against the hash it was published with before it is used. Nothing here runs a model; the
 * worker does (speech-worker.ts).
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'
export const ARCHIVE = { name: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2', sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf', bytes: 487_170_055 }
export const PARAKEET_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
/** The files the recognizer reads, in the archive's folder - each checked before use. */
export const PARAKEET_FILES: Record<'encoder' | 'decoder' | 'joiner' | 'tokens', { file: string; sha256: string }> = {
  encoder: { file: 'encoder.int8.onnx', sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
  decoder: { file: 'decoder.int8.onnx', sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
  joiner: { file: 'joiner.int8.onnx', sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
  tokens: { file: 'tokens.txt', sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
}
export const VAD = { name: 'silero_vad.onnx', sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6', bytes: 643_854 }
/** About what the download weighs, for the question ("490 MB, once"). */
export const DOWNLOAD_MB = Math.round((ARCHIVE.bytes + VAD.bytes) / 1_000_000)

/** Where the models live: `~/.marver/models/` (MARVER_MODELS points elsewhere - the tests). */
export const modelsDir = (): string => process.env.MARVER_MODELS || join(homedir(), '.marver', 'models')

export interface ModelPaths { encoder: string; decoder: string; joiner: string; tokens: string; vad: string }
export const modelPaths = (dir = modelsDir()): ModelPaths => ({
  encoder: join(dir, PARAKEET_DIR, PARAKEET_FILES.encoder.file),
  decoder: join(dir, PARAKEET_DIR, PARAKEET_FILES.decoder.file),
  joiner: join(dir, PARAKEET_DIR, PARAKEET_FILES.joiner.file),
  tokens: join(dir, PARAKEET_DIR, PARAKEET_FILES.tokens.file),
  vad: join(dir, VAD.name),
})

export const sha256File = async (path: string): Promise<string> => {
  const h = createHash('sha256')
  await pipeline(createReadStream(path), h)
  return h.digest('hex')
}

/** A hash checked once per file per process (by its size and mtime): the 650 MB encoder is hashed once. */
const checked = new Map<string, string>()
async function fileOk(path: string, sha256: string): Promise<boolean> {
  let st: ReturnType<typeof statSync>
  try { st = statSync(path) } catch { return false }
  const key = `${path}|${st.size}|${st.mtimeMs}`
  if (checked.get(key) === sha256) return true
  const ok = (await sha256File(path)) === sha256
  if (ok) checked.set(key, sha256)
  return ok
}

/** Are the model files there, each the one published? */
export async function modelsReady(dir = modelsDir()): Promise<boolean> {
  const p = modelPaths(dir)
  const all = [...(Object.keys(PARAKEET_FILES) as (keyof typeof PARAKEET_FILES)[]).map((k) => [p[k], PARAKEET_FILES[k].sha256] as const), [p.vad, VAD.sha256] as const]
  for (const [path, sha] of all) if (!(await fileOk(path, sha))) return false
  return true
}

/** Is anything there at all (a download half done, or files that do not match)? */
export const modelsPresent = (dir = modelsDir()): boolean => existsSync(join(dir, PARAKEET_DIR)) || existsSync(join(dir, VAD.name))

export interface DownloadState { state: 'idle' | 'downloading' | 'checking' | 'done' | 'failed'; received: number; total: number; error?: string }
let download: DownloadState = { state: 'idle', received: 0, total: ARCHIVE.bytes + VAD.bytes }
let running: Promise<void> | null = null
export const downloadState = (): DownloadState => ({ ...download })

/** Fetch one file to `dest` through a temporary name, counting bytes; refuse it unless its hash matches. */
async function fetchChecked(url: string, dest: string, sha256: string, onBytes: (n: number) => void, fetchImpl: typeof fetch): Promise<void> {
  const tmp = `${dest}.part`
  const res = await fetchImpl(url)
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) - ${url}`)
  const h = createHash('sha256')
  const body = Readable.fromWeb(res.body as any)
  body.on('data', (c: Buffer) => { h.update(c); onBytes(c.length) })
  await pipeline(body, createWriteStream(tmp))
  if (h.digest('hex') !== sha256) { rmSync(tmp, { force: true }); throw new Error(`${dest.split('/').pop()} did not match its published hash - nothing was kept`) }
  renameSync(tmp, dest)
}

const untar = (archive: string, into: string) => new Promise<void>((resolve, reject) => {
  // the system tar (macOS and Linux have one; Windows 10+ ships bsdtar as tar)
  const p = spawn('tar', ['-xjf', archive, '-C', into], { stdio: 'ignore' })
  p.on('error', reject)
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
})

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

/** Download the models (once - a second call joins the first; another dev server downloading them is
 *  waited for, through a lock file). Everything lands in a staging folder of this process first, is
 *  checked there, and only then moves into place; a failure leaves nothing behind. */
export function downloadModels(dir = modelsDir(), fetchImpl: typeof fetch = fetch): Promise<void> {
  if (running) return running
  download = { state: 'downloading', received: 0, total: ARCHIVE.bytes + VAD.bytes }
  running = (async () => {
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, '.download.lock')
    // another process downloading: wait for it, then see what it left
    for (;;) {
      try { writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); break }
      catch {
        let pid = 0
        try { pid = Number(JSON.parse(readFileSync(lock, 'utf8')).pid) || 0 } catch { /* half written */ }
        if (pid && !alive(pid)) { rmSync(lock, { force: true }); continue }
        await new Promise((r) => setTimeout(r, 1_000))
        if (!existsSync(lock)) { if (await modelsReady(dir)) { download = { ...download, state: 'done', received: download.total }; return } }
      }
    }
    const stage = join(dir, `.staging-${process.pid}-${randomBytes(4).toString('hex')}`)
    try {
      mkdirSync(stage, { recursive: true })
      const count = (n: number) => { download.received += n }
      const p = modelPaths(dir)
      if (!(await fileOk(p.vad, VAD.sha256))) await fetchChecked(RELEASE + VAD.name, join(stage, VAD.name), VAD.sha256, count, fetchImpl)
      else download.received += VAD.bytes
      const parakeetOk = await (async () => { for (const k of Object.keys(PARAKEET_FILES) as (keyof typeof PARAKEET_FILES)[]) if (!(await fileOk(p[k], PARAKEET_FILES[k].sha256))) return false; return true })()
      if (!parakeetOk) {
        const archive = join(stage, ARCHIVE.name)
        await fetchChecked(RELEASE + ARCHIVE.name, archive, ARCHIVE.sha256, count, fetchImpl)
        download.state = 'checking'
        await untar(archive, stage)
        rmSync(archive, { force: true })
        // (the archive's hash was checked before it was opened; tar refuses absolute and `..` paths by default)
        if (!(await parakeetIn(stage))) throw new Error('the unpacked model did not match its published hashes')
      } else download.received += ARCHIVE.bytes
      download.state = 'checking'
      // into place, checked: the folder whole, then the VAD
      if (!parakeetOk) { rmSync(join(dir, PARAKEET_DIR), { recursive: true, force: true }); renameSync(join(stage, PARAKEET_DIR), join(dir, PARAKEET_DIR)) }
      if (existsSync(join(stage, VAD.name))) renameSync(join(stage, VAD.name), p.vad)
      if (!(await modelsReady(dir))) throw new Error('the model did not match its published hashes once in place')
      download.state = 'done'
    } catch (err) {
      download = { ...download, state: 'failed', error: (err as Error).message }
    } finally {
      rmSync(stage, { recursive: true, force: true })
      rmSync(lock, { force: true })
    }
  })().finally(() => { running = null })
  return running
}

/** The recognizer's files, checked, in a folder (the staging one: the VAD may already be in place). */
async function parakeetIn(dir: string): Promise<boolean> {
  const p = modelPaths(dir)
  for (const k of Object.keys(PARAKEET_FILES) as (keyof typeof PARAKEET_FILES)[]) if (!(await fileOk(p[k], PARAKEET_FILES[k].sha256))) return false
  return true
}
