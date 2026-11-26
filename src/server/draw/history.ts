import { createHash } from 'node:crypto'
export const drawHash = (text: string) => createHash('sha1').update(text).digest('hex')
export const drawLogKey = (id: string) => drawHash(id).slice(0, 12) + '-' + id.replace(/[^\w-]+/g, '_').slice(-40)
