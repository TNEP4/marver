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
 * verified can never hand it a logo.
 */
import { createHmac } from 'node:crypto'

export interface DocProof { instance: string; key: Buffer; port: number }

/** 16-64 base64url characters - anything else is not a nonce, and is ignored. */
export const NONCE = /^[A-Za-z0-9_-]{16,64}$/

const sign = (key: Buffer, msg: string): string => createHmac('sha256', key).update(msg, 'utf8').digest('base64url')
export const docProof = (key: Buffer, nonce: string, port: number): string => sign(key, `doc|${nonce}|${port}`)
export const appProof = (key: Buffer, port: number): string => sign(key, `app|${port}`)
export const logoProof = (key: Buffer, nonce: string, port: number): string => sign(key, `logo|${nonce}|${port}`)

/** The two headers for a request carrying a well-formed `x-mv-nonce`, else null: over the shell's document
 *  (`doc`), or over the logo (`logo`). */
export function proofHeaders(p: DocProof | undefined, nonce: unknown, kind: 'doc' | 'logo' = 'doc'): Record<string, string> | null {
  if (!p || typeof nonce !== 'string' || !NONCE.test(nonce)) return null
  return { 'x-mv-instance': p.instance, 'x-mv-proof': (kind === 'logo' ? logoProof : docProof)(p.key, nonce, p.port) }
}
