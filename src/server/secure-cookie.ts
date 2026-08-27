/**
 * Is this deployment https, for the purpose of setting `Secure` on a cookie?
 *
 * The obvious answer - read `X-Forwarded-Proto` - is wrong in exactly the case
 * that matters, and it is the same trap that made `MARVER_PUBLIC_ORIGIN`
 * mandatory for identity mode: nginx's own documented `proxy_pass
 * http://localhost:PORT` sets no `X-Forwarded-*` at all. A canvas served over
 * https behind that config sees no header, decides "not secure", and issues a
 * thirty-day session cookie the browser will happily send over plain http.
 *
 * So the pinned origin wins whenever it is set. It is a deliberate statement by
 * whoever deployed the canvas, rather than a guess about a proxy that may not be
 * speaking. The header remains the fallback for a canvas with no pinned origin,
 * where a guess is all there is - and http on loopback is the ordinary
 * development case, where `Secure` would break the cookie entirely.
 */
export function isSecureDeployment(req: { headers: Record<string, unknown> }): boolean {
  const pinned = (process.env.MARVER_PUBLIC_ORIGIN ?? '').trim()
  if (pinned) return pinned.toLowerCase().startsWith('https://')
  return req.headers['x-forwarded-proto'] === 'https'
}

/** `; Secure`, or nothing - the suffix a Set-Cookie line wants. */
export const secureSuffix = (req: { headers: Record<string, unknown> }): string =>
  isSecureDeployment(req) ? '; Secure' : ''
