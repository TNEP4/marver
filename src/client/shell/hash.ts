/**
 * Deep links. Hash-based so any static host serves them and a URL copied
 * from dev works verbatim on a published site. The URL is a projection of state - the
 * shell writes it as board/selection/play change and parses it once on boot; camera
 * intent is always fit semantics (fit-all / fit-selection), never raw coordinates.
 *
 *   #/                     default board, fit all
 *   #/b/<board>            board, fit all
 *   #/b/<board>?n=k1,k2    board with nodes selected, camera fit to selection
 *   #/b/<board>?c=<id>     board with a comment thread open
 *   #/i/<token>            invite link - opens the claim dialog with the token
 *   #/p/<board>?at=<frame-id>&device=<viewport>&theme=<theme>   play mode
 */

export interface HashState {
  board?: string
  n?: string[]
  c?: string
  invite?: string
  play?: { at?: string; device?: string; theme?: string }
}

const BOARD_RE = /^[a-z0-9][a-z0-9-]*$/

export function parseHash(hash: string = location.hash): HashState {
  try {
    const raw = hash.replace(/^#/, '')
    if (!raw || raw === '/') return {}
    const q = raw.indexOf('?')
    const path = q === -1 ? raw : raw.slice(0, q)
    const params = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1))
    const mi = path.match(/^\/i\/([\w-]{8,128})$/)
    if (mi) return { invite: mi[1] }
    const m = path.match(/^\/(b|p)\/([^/?]+)$/)
    if (!m) return {}
    const board = decodeURIComponent(m[2])
    if (!BOARD_RE.test(board)) return {}
    if (m[1] === 'b') {
      const n = (params.get('n') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      const c = params.get('c') ?? undefined
      return { board, ...(n.length ? { n } : {}), ...(c && /^[\w-]+$/.test(c) ? { c } : {}) }
    }
    return {
      board,
      play: {
        at: params.get('at') ?? undefined,
        device: params.get('device') ?? undefined,
        theme: params.get('theme') ?? undefined,
      },
    }
  } catch { return {} }   // a malformed hash (#/b/%) is a default view, never a crash
}

export function buildHash(s: HashState): string {
  if (s.play?.at && s.board) {
    const p = new URLSearchParams({ at: s.play.at })
    if (s.play.device) p.set('device', s.play.device)
    if (s.play.theme) p.set('theme', s.play.theme)
    return `#/p/${s.board}?${p}`
  }
  if (!s.board || (s.board === 'all-scenes' && !s.n?.length && !s.c)) return '#/'
  const p = new URLSearchParams()
  if (s.n?.length) p.set('n', s.n.join(','))
  if (s.c) p.set('c', s.c)
  const q = p.toString()
  return `#/b/${s.board}${q ? `?${decodeURIComponent(q)}` : ''}`
}

/** Write the hash; identical URLs are skipped so restore paths never loop. */
export function writeHash(s: HashState, push = false) {
  const h = buildHash(s)
  if (h === location.hash || (h === '#/' && !location.hash)) return
  if (push) history.pushState(null, '', h)
  else history.replaceState(null, '', h)
}

/** The hash as it stood when the app loaded - boot intent, captured once. */
export const bootHash = parseHash()
