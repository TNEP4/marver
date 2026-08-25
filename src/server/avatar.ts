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
/**
 * Every hextet of an IPv6 address, or null if it is not one.
 *
 * Prefix matching on the printed form is what let the first version through:
 * `fe80:` is a string test, and link-local is fe80::/10 - so fe90:: and febf::
 * sailed past. Likewise `::ffff:` was only recognised in its dotted form, and
 * `::ffff:a00:1` is the same 10.0.0.1 written in hex. Comparing numbers instead
 * of text removes the whole class.
 */
function v6Parts(addr: string): number[] | null {
  let s = addr.toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)

  // A trailing dotted quad (::ffff:10.0.0.1) is two hextets in disguise.
  const tail4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (tail4) {
    const b = [Number(tail4[2]), Number(tail4[3]), Number(tail4[4]), Number(tail4[5])]
    if (b.some((n) => n > 255)) return null
    s = `${tail4[1]}${(((b[0]! << 8) | b[1]!) >>> 0).toString(16)}:${(((b[2]! << 8) | b[3]!) >>> 0).toString(16)}`
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0]!.split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(':') : []
  const gap = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (gap < 0 || (halves.length === 1 && head.length !== 8)) return null

  const parts = [...head, ...Array<string>(gap).fill('0'), ...tail]
  if (parts.length !== 8) return null
  const nums = parts.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN))
  return nums.some((n) => !Number.isInteger(n)) ? null : nums
}

function isPublicAddress(addr: string): boolean {
  if (isIP(addr) === 6) {
    const p = v6Parts(addr)
    if (!p) return false

    // ::ffff:x is an IPv4 address wearing a hat - judge what it reaches.
    if (p.slice(0, 5).every((x) => x === 0) && p[5] === 0xffff) {
      return isPublicAddress(`${p[6]! >> 8}.${p[6]! & 255}.${p[7]! >> 8}.${p[7]! & 255}`)
    }

    /**
     * Everything else must be global unicast, and then survive three exceptions.
     *
     * This is an ALLOWLIST, and the earlier blocklist is why. Naming the ranges
     * to refuse means the default is "allowed", and IPv6 has far too much
     * special-purpose space for that default to be safe: reserved blocks,
     * documentation space, and several prefixes that carry an IPv4 address
     * inside them and route to it. Every one I had not thought of was a hole,
     * and the list of things I have not thought of is not something I can
     * enumerate. Requiring 2000::/3 inverts it - the default becomes "refused",
     * and the exceptions below are the small, auditable part.
     *
     * The three exceptions are all inside global unicast and none are reachable
     * the way an avatar host is:
     *   2001::/23    IETF protocol assignments - Teredo, benchmarking, ORCHID.
     *                Teredo in particular tunnels IPv4 inside the address.
     *   2001:db8::/32 documentation. Never routed, and a favourite in examples.
     *   2002::/16    6to4, which embeds an IPv4 address and routes to it.
     *
     * NAT64 (64:ff9b::/96) is refused simply by being outside 2000::/3, and
     * that is the right outcome: it is a live route to whatever IPv4 address it
     * carries, including the metadata endpoint. An IPv6-only canvas loses
     * nothing real, because an avatar host that matters has a AAAA record.
     */
    if ((p[0]! & 0xe000) !== 0x2000) return false
    if (p[0] === 0x2001 && p[1]! < 0x0200) return false
    if (p[0] === 0x2001 && p[1] === 0x0db8) return false
    if (p[0] === 0x2002) return false
    return true
  }

  const q = addr.split('.').map(Number)
  if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = q as [number, number, number, number]
  if (a === 0 || a === 127) return false                       // this host, loopback
  if (a === 10) return false                                   // private
  if (a === 172 && b >= 16 && b <= 31) return false            // private
  if (a === 192 && b === 168) return false                     // private
  if (a === 169 && b === 254) return false                     // link-local, and cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return false           // carrier-grade NAT
  if (a === 192 && b === 0) return false                       // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false         // benchmarking
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

  // Content-Length is a claim, so it is worth checking and worth nothing.
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared && declared > MAX_BYTES) return null

  const buf = await readCapped(res)
  if (!buf || buf.byteLength === 0) return null

  return `data:${type};base64,${buf.toString('base64')}`
}

/**
 * Read a body, and stop reading the moment it is too big.
 *
 * The cap used to be applied to the result of arrayBuffer(), which is a check
 * performed after the thing it was checking has already been allocated. A
 * chunked response, or one whose Content-Length simply lies, could stream
 * hundreds of megabytes into the canvas process inside the five second window,
 * and a handful of concurrent sign-ins would be enough to end it. Counting as
 * the chunks arrive and cancelling at the limit is the difference between a
 * bound and a wish.
 */
async function readCapped(res: { body?: unknown; arrayBuffer(): Promise<ArrayBuffer> }): Promise<Buffer | null> {
  const body = res.body as ReadableStream<Uint8Array> | null | undefined
  if (!body || typeof body.getReader !== 'function') {
    // No stream to read incrementally - fall back, still bounded by the check.
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.byteLength > MAX_BYTES ? null : buf
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  return Buffer.concat(chunks)
}

/** Exposed for tests - the address rule is the part worth pinning down. */
export const _isPublicAddress = isPublicAddress
