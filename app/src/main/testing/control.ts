/**
 * The control socket of the production-switch harness (spec 28 A2.14 #27): a Unix socket, mode 600, at
 * `MARVER_APP_CONTROL` (a path in the test's own temp folder - under 104 bytes, macOS's limit for a socket
 * path, so not in a deep scratch folder). Newline-delimited JSON:
 *   request  { id, call, args }
 *   answer   { id, ok: true, value } | { id, ok: false, error }
 * Dev builds in test mode only (testing/index.ts gates the call). A socket that cannot be served ends the
 * run with exit code 2 and a line on stderr: a harness waiting on it would otherwise hang.
 */
import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { app } from 'electron'

/** macOS's sun_path is 104 bytes, its terminating NUL included. */
export const SOCKET_PATH_MAX = 103

export function serveControl(path: string, call: (name: string, args: unknown) => Promise<unknown>): void {
  if (!__MV_TEST__) return
  const die = (why: string) => { process.stderr.write(`marver-app: control socket ${path}: ${why}\n`); app.exit(2) }
  if (Buffer.byteLength(path) > SOCKET_PATH_MAX) return die(`longer than ${SOCKET_PATH_MAX} bytes`)
  try { rmSync(path, { force: true }) } catch { /* a leftover from a killed run */ }
  const server = createServer((sock: Socket) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      buf += chunk
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) void answer(sock, line, call)
      }
    })
    sock.on('error', () => { /* the harness went away */ })
  })
  server.on('error', (err) => die(err.message))
  const old = process.umask(0o177)
  try { server.listen(path, () => { try { chmodSync(path, 0o600) } catch { /* made 600 by the umask already */ } }) }
  finally { process.umask(old) }
  server.unref()
}

async function answer(sock: Socket, line: string, call: (name: string, args: unknown) => Promise<unknown>) {
  let id: unknown = null
  try {
    const req = JSON.parse(line) as { id?: unknown; call?: unknown; args?: unknown }
    id = req.id ?? null
    if (typeof req.call !== 'string') throw new Error('no call')
    const value = await call(req.call, req.args)
    sock.write(JSON.stringify({ id, ok: true, value: value ?? null }) + '\n')
  } catch (err) {
    sock.write(JSON.stringify({ id, ok: false, error: (err as Error).message }) + '\n')
  }
}
