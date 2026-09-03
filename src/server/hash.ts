import { createHash } from 'node:crypto'

/** sha256 hex of a string - the CAS token for board files, the registry, the manifest. */
export const hash = (s: string) => createHash('sha256').update(s).digest('hex')
