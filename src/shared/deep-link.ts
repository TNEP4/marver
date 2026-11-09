/**
 * Spec 31 Part D: the one contract for showing the human a place on a canvas - pure, no DOM, no Node, so the CLI,
 * the dev server, the shell and the Mac app read it with one rule.
 *
 * - **A show target** (`ShowTarget`) is the hash's own targets on one board: `n` node keys, `f` frame ids, `s` scenes,
 *   `c` one comment thread. Node keys stay node keys (selecting one copy of a frame never selects every copy), and
 *   every value is checked against the hash grammar's characters - never a raw hash, never a URL, never script.
 * - **The link hash** a target travels as: `#/b/<board>` and only the `f`, `s`, `n`, `c` query keys, each once, each
 *   value of the allowed characters (`targetFromHash` refuses anything else whole; `hashOfTarget` writes it back).
 * - **A deep link** into the Mac app: `marver://open?ws=<folder>&to=<hash>[&port=<p>]`, both values written with
 *   `URLSearchParams` (so the hash's own `#`, `?` and `&` are percent-encoded inside `to`), 2 KB at most. `ws` is the
 *   canvas's folder (the app realpaths it and binds it to a running canvas); `port` is a hint the app uses only when
 *   that port's canvas has the same folder; a `to` that is not the grammar is dropped (the canvas opens on its default
 *   board), never the link.
 */

export const DEEP_LINK_SCHEME = 'marver'
/** The longest deep link either side takes. */
export const DEEP_LINK_MAX = 2048
/** The most values one key carries. */
export const TARGET_LIST_MAX = 64

export interface ShowTarget {
  board: string
  /** node keys: exactly those nodes */
  n?: string[]
  /** frame ids: every node showing them */
  f?: string[]
  /** scenes: every frame of them */
  s?: string[]
  /** one comment thread, opened */
  c?: string
}

/** The board-name grammar (shared/board-tree.ts BOARD_NAME, bounded) and the Not on a board view. */
const BOARD = /^[a-z0-9][a-z0-9-]{0,63}$/
export const UNPLACED_BOARD = '~unplaced'
const FRAME = /^[\w./-]{1,200}$/
const SCENE = /^[\w.-]{1,120}$/
/** a node key is the shell's: `<frame id>@<width>`, or a board file's own (`n-one`) */
const NODE = /^[\w./@:-]{1,200}$/
const THREAD = /^[\w-]{1,128}$/

const okBoard = (b: unknown): b is string => typeof b === 'string' && (BOARD.test(b) || b === UNPLACED_BOARD)
const okIn = (re: RegExp) => (v: unknown): v is string => typeof v === 'string' && re.test(v) && !v.includes('..')
const okFrame = okIn(FRAME), okScene = okIn(SCENE), okNode = okIn(NODE), okThread = okIn(THREAD)
const KEYS = { n: okNode, f: okFrame, s: okScene } as const

/**
 * A show target off the wire (pure): `board` a board name, `n`/`f`/`s` arrays of their grammar's values (at most
 * `TARGET_LIST_MAX`, de-duplicated, empty ones left out), `c` a thread id. Unknown fields are stripped; a known one of
 * the wrong type or any value off its grammar refuses the whole (null).
 */
export function checkShowTarget(v: unknown): ShowTarget | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (!okBoard(r.board)) return null
  const out: ShowTarget = { board: r.board }
  for (const k of ['n', 'f', 's'] as const) {
    if (r[k] === undefined) continue
    const list = r[k]
    if (!Array.isArray(list) || list.length > TARGET_LIST_MAX || !list.every(KEYS[k])) return null
    const uniq = [...new Set(list as string[])]
    if (uniq.length) out[k] = uniq
  }
  if (r.c !== undefined) {
    if (!okThread(r.c)) return null
    out.c = r.c
  }
  return out
}

/**
 * The link hash's target (pure): `#/b/<board>` with only `f`, `s`, `n`, `c`, each at most once, every value of its
 * grammar; anything else - another route, another key, a repeated key, a bad value, more than 2 KB - is null.
 */
export function targetFromHash(hash: unknown): ShowTarget | null {
  if (typeof hash !== 'string' || hash.length > DEEP_LINK_MAX) return null
  const m = /^#\/b\/([^?#/]+)(?:\?([^#]*))?$/.exec(hash)
  if (!m) return null
  let board: string
  try { board = decodeURIComponent(m[1]!) } catch { return null }
  if (!okBoard(board)) return null
  const raw: Record<string, unknown> = { board }
  if (m[2] !== undefined && m[2] !== '') {
    let params: URLSearchParams
    try { params = new URLSearchParams(m[2]) } catch { return null }
    const seen = new Set<string>()
    for (const [k, v] of params) {
      if (seen.has(k) || !['n', 'f', 's', 'c'].includes(k)) return null
      seen.add(k)
      if (k === 'c') raw.c = v
      else raw[k] = v.split(',').map((x) => x.trim()).filter(Boolean)
    }
  }
  return checkShowTarget(raw)
}

/** The target as the link hash (pure): the board, then `n`, `f`, `s`, `c` - every value already of URL-safe characters. */
export function hashOfTarget(t: ShowTarget): string {
  const q = [
    t.n?.length ? `n=${t.n.join(',')}` : '',
    t.f?.length ? `f=${t.f.join(',')}` : '',
    t.s?.length ? `s=${t.s.join(',')}` : '',
    t.c ? `c=${t.c}` : '',
  ].filter(Boolean).join('&')
  return `#/b/${t.board}${q ? `?${q}` : ''}`
}

export interface DeepLink {
  /** the canvas's folder, as the link wrote it (absolute; the app realpaths it) */
  ws: string
  /** the place, checked; null when the link named none or one off the grammar (the canvas's default board) */
  to: ShowTarget | null
  /** a hint: used only when that port's canvas has the same folder */
  port?: number
}

const CONTROL = /[\u0000-\u001f\u007f]/

/** `marver://open?ws=<folder>&to=<hash>[&port=<p>]`, written with URLSearchParams; null past 2 KB or with a bad folder. */
export function buildDeepLink(o: { ws: string; to?: string; port?: number }): string | null {
  if (!o.ws.startsWith('/') || CONTROL.test(o.ws)) return null
  const p = new URLSearchParams({ ws: o.ws })
  if (o.to) p.set('to', o.to)
  if (o.port !== undefined && Number.isInteger(o.port) && o.port > 0 && o.port < 65536) p.set('port', String(o.port))
  const link = `${DEEP_LINK_SCHEME}://open?${p}`
  return link.length <= DEEP_LINK_MAX ? link : null
}

/**
 * A deep link as the app hears it (pure): `marver://open` and nothing else on its path, at most 2 KB, only `ws`, `to`
 * and `port` (each once), `ws` an absolute path with no control character (1 KB at most). A `to` off the grammar is
 * dropped to null; a `port` that is not a port is ignored. Anything else is null: nothing opens.
 */
export function parseDeepLink(raw: unknown): DeepLink | null {
  if (typeof raw !== 'string' || raw.length > DEEP_LINK_MAX) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== `${DEEP_LINK_SCHEME}:` || u.host !== 'open' || (u.pathname !== '' && u.pathname !== '/') || u.username || u.password || u.hash) return null
  const seen = new Set<string>()
  for (const k of u.searchParams.keys()) {
    if (seen.has(k) || !['ws', 'to', 'port'].includes(k)) return null
    seen.add(k)
  }
  const ws = u.searchParams.get('ws')
  if (!ws || !ws.startsWith('/') || ws.length > 1024 || CONTROL.test(ws)) return null
  const to = u.searchParams.has('to') ? targetFromHash(u.searchParams.get('to')) : null
  const ps = u.searchParams.get('port')
  const port = ps !== null && /^\d{1,5}$/.test(ps) && Number(ps) > 0 && Number(ps) < 65536 ? Number(ps) : undefined
  return { ws, to, ...(port !== undefined ? { port } : {}) }
}

/** The first `marver://` argument of a command line (a second instance's argv), or null. */
export function deepLinkArg(argv: readonly unknown[]): string | null {
  for (const a of argv) if (typeof a === 'string' && a.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) return a
  return null
}

/** Strictly newer x.y.z (pure): anything not three numbers compares false. */
export function newerVersion(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const pa = /^(\d+)\.(\d+)\.(\d+)$/.exec(a), pb = /^(\d+)\.(\d+)\.(\d+)$/.exec(b)
  if (!pa || !pb) return false
  for (let i = 1; i <= 3; i++) {
    const x = Number(pa[i]), y = Number(pb[i])
    if (x !== y) return x > y
  }
  return false
}

// ---- app-live.json: knowing when the app is in use (Part D2) ---------------------------------------------------

/** `<MARVER_HOME>/state/app-live.json`: the Mac app's word that it runs, rewritten every `APP_LIVE_EVERY_MS`. */
export const APP_LIVE_FILE = 'app-live.json'
export const APP_LIVE_EVERY_MS = 30_000
/** Older than this, the file is stale: the app is not in use (it quit without removing it, it hangs). */
export const APP_LIVE_FRESH_MS = 90_000

export interface AppLiveFile {
  v: 1
  pid: number
  version: string
  /** 1 when this app takes `marver://` links (an app that registered the scheme); absent otherwise */
  scheme?: 1
  /** when it was written, ms */
  at: number
  /** the real folders of the canvases open in its tabs */
  workspaces: string[]
}

/** The file's shape (pure), or null. */
export function checkAppLive(v: unknown): AppLiveFile | null {
  const r = v as Partial<AppLiveFile> | null
  if (!r || typeof r !== 'object' || r.v !== 1) return null
  if (!Number.isInteger(r.pid) || (r.pid as number) < 1 || typeof r.version !== 'string' || r.version.length > 32) return null
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null
  if (!Array.isArray(r.workspaces) || r.workspaces.length > 256 || !r.workspaces.every((w) => typeof w === 'string' && w.startsWith('/') && w.length <= 4096)) return null
  return { v: 1, pid: r.pid as number, version: r.version, at: r.at, workspaces: [...r.workspaces], ...(r.scheme === 1 ? { scheme: 1 as const } : {}) }
}

/**
 * Whether `marver link` gives the app's link for the canvas in `root` (pure): the file names a pid that runs, was
 * written under 90 s ago (a stamp from the future is stale too), takes the scheme, and has this canvas's folder open.
 * Anything else - no file, an older app, a stale file, the canvas not open in a tab - is the localhost link.
 */
export function appTakesLink(file: AppLiveFile | null, root: string, now: number, alive: (pid: number) => boolean): boolean {
  if (!file || file.scheme !== 1) return false
  if (file.at > now + 5_000 || now - file.at > APP_LIVE_FRESH_MS) return false
  if (!file.workspaces.includes(root)) return false
  return alive(file.pid)
}
