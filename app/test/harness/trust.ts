/**
 * Helpers for the trust stream's cases (spec 28 A2.10): the test tabs of src/main/testing/trust.ts, read back.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AppRun } from './app.ts'

export interface NavEventRow { t: number; trusted: boolean; e: { kind: string; gen: number; url?: string; attributed?: boolean; instance?: string; why?: string; code?: number; outcome?: { kind: string; why?: string } } }
export interface Reports { safety: 'unknown' | 'fresh' | 'stale'; hello?: { version: string; board: string | null; page: string }; theme?: { dark: boolean }; busy?: { busy: boolean; unsaved: boolean; why: string[] }; menu?: { id: string }[] }
export interface TabState {
  id: string
  wc: number
  trusted: boolean
  url: string
  origin: string
  commits: number
  committed?: { gen: number; url: string; attributed: boolean; instance?: string; lost: boolean }
  gen: number
  entry: { instance: string; origin: string | null; port: number; state: string; ws: string }
  events: NavEventRow[]
  reports: { t: number; doc: string; r: Reports }[]
  current?: Reports
}
export interface JournalLine { topic: string; turn: number; t: string; data: Record<string, unknown> }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls `f` until it answers truthy; its last answer in the error otherwise. */
export async function until<T>(what: string, f: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  for (;;) {
    try { last = await f() } catch (err) { last = err }
    if (last && !(last instanceof Error)) return last as T
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 600)}`)
    await sleep(40)
  }
}

export const tabState = (run: AppRun, id: string) => run.call<TabState>('trust:tab', { id })
export const evalIn = <T = unknown>(run: AppRun, id: string, js: string, gesture = false) => run.call<T>('trust:eval', { id, js, gesture })
export async function open(run: AppRun, port: number, path?: string, load = true): Promise<string> {
  const { id } = await run.call<{ id: string }>('trust:open', { port, path, load })
  return id
}
/** Waits for the tab's current document to be trusted (and admitted). */
export const trusted = (run: AppRun, id: string, ms = 5000) => until(`tab ${id} trusted`, async () => { const s = await tabState(run, id); return s.trusted && s.committed?.attributed ? s : null }, ms)
export const journal = (run: AppRun, topic?: string) => run.call<JournalLine[]>('log').then((l) => (topic ? l.filter((x) => x.topic === topic) : l))
/** The registry holds an entry on that port, in that state (or any). */
export const inRegistry = (run: AppRun, port: number, state?: string) => until(`port ${port} in the registry`, async () => {
  const es = await run.call<{ port: number; state: string; instance: string }[]>('trust:reread')
  return es.find((e) => e.port === port && (!state || e.state === state)) ?? null
})

/** A plain HTTP server - an impostor or another origin - on 127.0.0.1. */
export async function plainServer(port = 0, handler?: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number; origin: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    if (handler) return handler(req, res)
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Directory listing</title><h1>Directory listing for /</h1>')
  })
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => ok()) })
  const p = (server.address() as AddressInfo).port
  return { server, port: p, origin: `http://127.0.0.1:${p}`, hits, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)) } }
}
