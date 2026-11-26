import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Writable } from 'node:stream'

/** Exercise real request handlers without opening a TCP port (works in restricted worktrees). */
export async function commentRequest(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => unknown,
  path: string, body?: unknown, headers: Record<string, string> = {},
): Promise<Response> {
  const req = new IncomingMessage(new Socket())
  req.method = body === undefined ? 'GET' : 'POST'
  req.url = `/__mv/api/${path}`
  req.headers = headers
  const chunks: Buffer[] = [], responseHeaders = new Headers()
  const res = Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done() } }), {
    statusCode: 200,
    setHeader(name: string, value: string | string[]) {
      responseHeaders.delete(name)
      for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(name, v)
    },
    getHeader(name: string) { return responseHeaders.get(name) },
  })
  const finished = new Promise<Response>((resolve, reject) => {
    res.once('finish', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders })))
    res.once('error', reject)
  })
  const run = Promise.resolve(handler(req, res as unknown as ServerResponse, new URL(req.url, 'http://canvas.test')))
  if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)))
  req.push(null)
  await run
  return finished
}
