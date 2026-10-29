/**
 * The document proof (spec 28 A1.4). The Mac app puts a fresh nonce on every main-frame request to a
 * local canvas (`x-mv-nonce`) and checks the answer before the document commits; only the canvas
 * holding the slot file's key can sign it, so the privileges the app grants belong to that exact
 * document. The proof rides the very response the app commits - the check and the load can never
 * reach different listeners.
 *
 * Pinned exactly, so the app (A2.3 `proof.ts`) computes the same: the key is the slot file's 32 bytes
 * (base64url there), HMAC-SHA256 over UTF-8 `doc|<nonce>|<port>` (port in decimal), base64url without
 * padding. Requests from the app itself carry `app|<port>` the same way, and the logo the app fetches
 * (`GET /__mv/logo`, spec 28 A2.4) `logo|<nonce>|<port>`: a listener that took the port after the tab was
 * verified can never hand it a logo. The live stream (`GET /__mv/app/live`, A4.6 #6) is proved both ways: the
 * request carries `x-mv-app` (`appProof`, checked by `appProofOk`), the answer `live|<nonce>|<port>` - a
 * listener that took the port after a canvas stopped can never put words into a notice.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface DocProof { instance: string; key: Buffer; port: number }

/** 16-64 base64url characters - anything else is not a nonce, and is ignored. */
export const NONCE = /^[A-Za-z0-9_-]{16,64}$/

const sign = (key: Buffer, msg: string): string => createHmac('sha256', key).update(msg, 'utf8').digest('base64url')
export const docProof = (key: Buffer, nonce: string, port: number): string => sign(key, `doc|${nonce}|${port}`)
export const appProof = (key: Buffer, port: number): string => sign(key, `app|${port}`)
export const logoProof = (key: Buffer, nonce: string, port: number): string => sign(key, `logo|${nonce}|${port}`)
export const liveProof = (key: Buffer, nonce: string, port: number): string => sign(key, `live|${nonce}|${port}`)

const PROOFS = { doc: docProof, logo: logoProof, live: liveProof } as const
export type ProofKind = keyof typeof PROOFS

/** The two headers for a request carrying a well-formed `x-mv-nonce`, else null: over the shell's document
 *  (`doc`), the logo (`logo`) or the live stream (`live`). */
export function proofHeaders(p: DocProof | undefined, nonce: unknown, kind: ProofKind = 'doc'): Record<string, string> | null {
  if (!p || typeof nonce !== 'string' || !NONCE.test(nonce)) return null
  return { 'x-mv-instance': p.instance, 'x-mv-proof': PROOFS[kind](p.key, nonce, p.port) }
}

/** Is this `x-mv-app` header the app's own, `appProof(key, port)`? Compared in constant time over equal lengths;
 *  anything but one string is no. The HMAC is never relaxed: no cookie, no token stands in for it (A4.6 #6). */
export function appProofOk(p: DocProof, header: unknown): boolean {
  if (typeof header !== 'string') return false
  const got = Buffer.from(header)
  const want = Buffer.from(appProof(p.key, p.port))
  return got.length === want.length && timingSafeEqual(got, want)
}
