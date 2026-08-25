/**
 * Fetching somebody's picture, once, and keeping our own copy.
 *
 * A Marver ID assertion carries a `picture` URL - almost always Google's CDN.
 * The canvas could just render that URL and be done, and it must not. Hotlinking
 * would put a request to Google on every page view of a private canvas, which
 * hands a third party a log of who looks at what, and leaves the avatar to
 * vanish the day the URL rotates. So the picture is fetched ONCE, at sign-in,
 * and stored as a data URI beside the account like any other avatar.
 *
 * That decision buys a problem: the canvas server now makes an outbound request
 * to an address that arrived in a token. Everything below is about making that
 * safe and, failing that, making it harmless - the whole thing is best-effort,
 * and every failure path returns null so a sign-in never breaks over a picture.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Small enough to sit in a JSON store beside every account, without thinking. */
const MAX_BYTES = 64 * 1024
const TIMEOUT_MS = 5000

/** What a browser will actually render, and nothing that can carry script. */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Is this address one a self-hosted canvas can safely be asked to fetch?
 *
 * The canvas is somebody's own server, usually inside their own network, and it
 * is being handed a URL. Without this check "fetch my picture" is a request to
 * probe the metadata endpoint, or a database on the private subnet, or another
 * service on the same box - the classic shape of SSRF, and worth more to an
 * attacker on a self-hosted deployment than on a shared one.
 *
 * Stated honestly: this resolves the name and rejects private space, which does
 * not close DNS rebinding - the name can resolve differently between this check
 * and the connection Node actually makes. Pinning the address needs a custom
 * agent. What bounds the residual risk is everything around it: the URL is https
 * only, arrives inside a signature from a configured issuer, is never followed
 * through a redirect, times out in five seconds, and the response is discarded
 * unless it is a small image. The value of the remaining hole is one blind
 * request; it is defence in depth rather than a wall.
 */
function isPublicAddress(addr: string): boolean {
  if (isIP(addr) === 6) {
    const a = addr.toLowerCase()
    if (a === '::1' || a === '::') return false
    if (a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd')) return false
    // IPv4-mapped (::ffff:10.0.0.1) is an IPv4 address wearing a hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
    if (mapped) return isPublicAddress(mapped[1]!)
    return true
  }
  const p = addr.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = p as [number, number, number, number]
  if (a === 0 || a === 127) return false                       // this host, loopback
  if (a === 10) return false                                   // private
  if (a === 172 && b >= 16 && b <= 31) return false            // private
  if (a === 192 && b === 168) return false                     // private
  if (a === 169 && b === 254) return false                     // link-local, and cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return false           // carrier-grade NAT
  if (a >= 224) return false                                   // multicast and reserved
  return true
}

/**
 * Fetch a picture and return it as a data URI, or null.
 *
 * Null for every kind of failure, deliberately and without distinction: a
 * picture is decoration, and there is no failure here worth turning into a
 * refused sign-in or an error somebody has to read.
 */
export async function fetchAvatar(pictureUrl: string): Promise<string | null> {
  let url: URL
  try { url = new URL(pictureUrl) } catch { return null }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null

  try {
    const { address } = await lookup(url.hostname)
    if (!isPublicAddress(address)) return null
  } catch { return null }

  try {
    const res = await fetch(url, {
      // A redirect is how a checked address becomes an unchecked one.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: ALLOWED_ACCEPT },
    })
    return await avatarFromResponse(res)
  } catch { return null }
}

const ALLOWED_ACCEPT = [...ALLOWED].join(', ')

/**
 * Turn a response into a stored avatar, or refuse it.
 *
 * Separate from the fetch so the rules can be tested against real Responses
 * without needing real TLS - these are the checks that decide what ends up in
 * somebody's auth store, and they are worth more than a test that restates a
 * list of MIME types back to itself.
 *
 * SVG is deliberately absent from the allowed set. Browsers render it, which
 * makes it feel like an image, and it is a document that can carry script - an
 * avatar is one of the few things a canvas shows without the author having
 * written it, so it is exactly where that matters.
 */
export async function avatarFromResponse(res: {
  ok: boolean
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}): Promise<string | null> {
  if (!res.ok) return null

  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!ALLOWED.has(type)) return null

  // Check the header AND the body: Content-Length is a claim, and a body that
  // keeps going is how a 64KB cap becomes a memory problem.
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared && declared > MAX_BYTES) return null

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null

  return `data:${type};base64,${buf.toString('base64')}`
}

/** Exposed for tests - the address rule is the part worth pinning down. */
export const _isPublicAddress = isPublicAddress
