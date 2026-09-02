import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { CONTENT_WIDTH, PKG } from '../client/const.ts'

export interface FrameMeta { title?: string; viewport?: string; theme?: string; of?: string; variant?: string; intent?: string; slide?: boolean }
export interface FrameEntry {
  id: string
  file: string
  kind: 'tsx' | 'html'
  scene: string
  title?: string
  viewport?: string
  theme?: string
  /** A deck slide (v1.5): 1280×720 intrinsic (over any authored viewport;
   *  board nodes stay resizable), the slideshow badge, and the slides-mode
   *  motion affordances. Literal-only. */
  slide?: boolean
  /** Variant group id: inferred from 2+ letter-prefixed siblings in one
   *  directory, or declared via meta.of. Present only on grouped frames. */
  variantGroup?: string
  /** This frame's variant key within the group ("a", "b", ...). */
  variant?: string
  /** Content-frame purpose: declared meta.intent wins; a usage-count
   *  heuristic fills the gap. Present ONLY on content frames - absence means UI. */
  intent?: string
  /** Content-frame natural width from Doc layout (document 760 / wide 1280). */
  contentWidth?: number
}
export interface Manifest {
  frames: FrameEntry[]
  scenes: { name: string; frames: number }[]
}

const FRAME_EXT = /\.(tsx|jsx|html)$/
const RESERVED_SCENES = new Set(['components', 'screens'])

/** Extract `export const meta = {...}` with literal string values only. Anything else is silently omitted. */
export function extractMeta(src: string): FrameMeta {
  const m = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\}/.exec(src)
  if (!m) return {}
  const body = m[1]
  const pick = (key: string) => {
    // boundary required: `covariant:` must not match `variant:` (property suffixes)
    const r = new RegExp(`(?:^|[{,])\\s*${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`).exec(body)
    return r ? r[2] : undefined
  }
  // literal booleans, same boundary discipline as the string picker
  const pickBool = (key: string) => {
    const r = new RegExp(`(?:^|[{,])\\s*${key}\\s*:\\s*(true|false)\\b`).exec(body)
    return r ? r[1] === 'true' : undefined
  }
  const out: FrameMeta = {}
  const title = pick('title'); if (title) out.title = title
  const viewport = pick('viewport'); if (viewport) out.viewport = viewport
  const theme = pick('theme'); if (theme) out.theme = theme
  const of = pick('of'); if (of) out.of = of
  const variant = pick('variant'); if (variant) out.variant = variant
  const intent = pick('intent'); if (intent) out.intent = intent
  const slide = pickBool('slide'); if (slide !== undefined) out.slide = slide
  return out
}

/** Content-frame detection: LEXICAL by convention - the frame file
 *  itself imports PKG/content (an import specifier scan, so "<Diagram" inside a
 *  string in a UI frame can never misbadge it; barrels/re-exports are not
 *  detected - meta.intent is the taught path and always works). Returns the
 *  inferred intent + natural width, or null for UI frames. */
const CONTENT_IMPORT = new RegExp(`from\\s+['"]${PKG}/content['"]`)
const WIDE_DOC = /<Doc\b[^>]*\blayout\s*=\s*["']wide["']/
export const contentWidthOf = (src: string): number => (WIDE_DOC.test(src) ? CONTENT_WIDTH.wide : CONTENT_WIDTH.document)
export function contentScan(src: string): { intent: string; width: number } | null {
  if (!CONTENT_IMPORT.test(src)) return null
  const count = (re: RegExp) => (src.match(re) ?? []).length
  const diagrams = count(/<Diagram[\s>/]/g)
  const imgs = count(/<Img[\s>/]/g)
  const mds = count(/<Md[\s>/]/g)
  const intent = diagrams > 0 ? 'diagram' : imgs > mds ? 'moodboard' : 'spec'
  return { intent, width: contentWidthOf(src) }
}

/** id = path relative to design/, extension dropped, `scenes/` prefix dropped. Always `/`-separated. */
export function toFrameId(designRelPath: string): string {
  const posix = designRelPath.split(sep).join('/')
  const noExt = posix.replace(FRAME_EXT, '')
  return noExt.startsWith('scenes/') ? noExt.slice('scenes/'.length) : noExt
}

/**
 * A7: which frames does a changed `design/**` file affect? Manifest + directory conventions,
 * NOT a module-graph walk (deterministic, cheap, may over-reload but never misses a
 * conventionally-affected frame). Returns:
 *   null  -> uncontrolled: leave to default Vite HMR (src/** deps, theme.css, config, assets)
 *   []    -> controlled but affects no current frame (e.g. a layout in an empty dir)
 *   [ids] -> controlled: the shell drives a rev-stamped reload of these frames
 */
export function affectedFrameIds(absFile: string, root: string, manifest: Manifest): string[] | null {
  const design = join(root, 'design')
  if (absFile !== design && !absFile.startsWith(design + sep)) return null
  const rel = relative(design, absFile).split(sep).join('/')     // e.g. scenes/foo/bar.tsx, providers.tsx, theme.css
  const name = rel.split('/').pop() ?? rel
  const designRel = `design/${rel}`
  const tsxFrames = manifest.frames.filter((f) => f.kind === 'tsx')

  if (name === 'theme.css') return null                          // CSS HMR owns this
  // providers.{tsx,jsx}: every TSX frame wraps in it
  if (rel === 'providers.tsx' || rel === 'providers.jsx') return tsxFrames.map((f) => f.id)
  // _layout / _fixtures: fan out to TSX frames in the same directory subtree
  const dirFanout = /(^|\/)(_layout\.(tsx|jsx)|_fixtures\.(ts|tsx|js|jsx|json))$/.test(rel)
  if (dirFanout) {
    const prefix = `design/${rel.slice(0, rel.length - name.length)}`   // 'design/scenes/foo/' or 'design/'
    return tsxFrames.filter((f) => f.file.startsWith(prefix)).map((f) => f.id)
  }
  // a direct frame file (tsx/jsx/html) present in the manifest
  const direct = manifest.frames.find((f) => f.file === designRel)
  if (direct) return [direct.id]
  // an underscore/helper file we don't recognise, or a non-frame under design/: uncontrolled
  return null
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

export function scanFrames(root: string): Manifest {
  const design = join(root, 'design')
  const frames: FrameEntry[] = []
  for (const base of ['scenes', 'components']) {
    for (const abs of walk(join(design, base))) {
      const name = abs.split(sep).pop()!
      if (name.startsWith('_') || !FRAME_EXT.test(name)) continue
      const rel = relative(design, abs).split(sep).join('/')
      const id = toFrameId(rel)
      const scene = id.includes('/') ? id.split('/')[0] : ''
      if (base === 'scenes' && RESERVED_SCENES.has(scene)) {
        console.error(`[marver] scene "${scene}" is a reserved name - "${rel}" skipped. Rename the scene.`)
        continue
      }
      const kind = name.endsWith('.html') ? 'html' as const : 'tsx' as const
      const entry: FrameEntry = { id, file: `design/${rel}`, kind, scene }
      if (kind === 'tsx') {
        const src = readFileSync(abs, 'utf8')
        const meta = extractMeta(src)
        if (meta.title) entry.title = meta.title
        if (meta.viewport) entry.viewport = meta.viewport
        if (meta.theme) entry.theme = meta.theme
        if (meta.of) entry.variantGroup = meta.of         // declared membership
        if (meta.variant) entry.variant = meta.variant
        if (meta.slide) entry.slide = true
        const content = contentScan(src)
        // declared meta.intent DECLARES a content frame even when the primitives
        // arrive through a barrel the lexical scan can't see - the taught path
        // must always work
        if (content || meta.intent) {
          entry.intent = meta.intent ?? content!.intent   // declared purpose wins
          entry.contentWidth = content?.width ?? contentWidthOf(src)
        }
      }
      frames.push(entry)
    }
  }
  // sort: id, then extension rank matching frame-host resolution (tsx > jsx > html),
  // then path - so the dedup winner below is fully deterministic and loadable
  const extRank = (file: string) => (file.endsWith('.tsx') ? 0 : file.endsWith('.jsx') ? 1 : 2)
  frames.sort((a, b) => a.id.localeCompare(b.id) || extRank(a.file) - extRank(b.file) || a.file.localeCompare(b.file))
  // duplicate ids (e.g. foo.tsx + foo.html): keep the first (deterministic after sort),
  // drop the rest - duplicate React keys downstream are worse than a hidden file
  const seen = new Map<string, string>()
  const deduped = frames.filter((f) => {
    const prev = seen.get(f.id)
    if (prev) {
      console.error(`[marver] duplicate frame id "${f.id}" (${prev} vs ${f.file}) - keeping ${prev}.`)
      return false
    }
    seen.set(f.id, f.file)
    return true
  })
  frames.length = 0
  frames.push(...deduped)

  inferVariantGroups(frames)

  const sceneCounts = new Map<string, number>()
  for (const f of frames) sceneCounts.set(f.scene, (sceneCounts.get(f.scene) ?? 0) + 1)
  const scenes = [...sceneCounts.entries()].map(([name, n]) => ({ name, frames: n })).sort((a, b) => a.name.localeCompare(b.name))

  return { frames, scenes }
}

/** Variant groups. A group = 2+ frames in one DIRECTORY whose basenames
 *  are letter-prefixed (`a-terminal`), or frames declaring `meta.of`. Group id = the
 *  directory's id prefix (or meta.of); variant key = the letter (or meta.variant).
 *  Nested directories scope alternatives inside a busy scene (checkout/payment/a-card).
 *  States (empty.tsx, error.tsx) never letter-prefix, so they never misgroup.
 *  Mutates entries in place: only frames whose group materializes keep the fields. */
function inferVariantGroups(frames: FrameEntry[]) {
  const dirOf = (id: string) => { const i = id.lastIndexOf('/'); return i >= 0 ? id.slice(0, i) : '' }
  const candidates = new Map<string, FrameEntry[]>()
  for (const f of frames) {
    if (f.kind !== 'tsx') {                           // play switching is tsx-only; a group
      delete f.variantGroup; delete f.variant         // the stage can't switch must not form
      continue
    }
    let group = f.variantGroup                        // meta.of, already copied
    let key = f.variant
    if (!group) {
      const base = f.id.slice(f.id.lastIndexOf('/') + 1)
      const m = /^([a-z])-.+$/.exec(base)
      if (!m) continue
      group = dirOf(f.id)
      if (!group) continue                            // root-level frames don't group
      key = key ?? m[1]
    } else if (!key) {
      // meta.of without a derivable key: take the letter prefix if present, else refuse -
      // an invented key would collide with the next member that also invented one
      const m = /^([a-z])-.+$/.exec(f.id.slice(f.id.lastIndexOf('/') + 1))
      if (!m) { console.warn(`[marver] ${f.file} declares of:"${group}" but no variant key (add meta.variant or a letter prefix) - not grouped.`); delete f.variantGroup; delete f.variant; continue }
      key = m[1]
    }
    f.variantGroup = group
    f.variant = key
    candidates.set(group, [...(candidates.get(group) ?? []), f])
  }
  for (const [group, members] of candidates) {
    // variants are LOCAL comparisons: one directory per group, no cross-scene lanes
    if (new Set(members.map((m) => dirOf(m.id))).size > 1) {
      console.warn(`[marver] group "${group}" spans directories - variants must be siblings; not grouped.`)
      for (const m of members) { delete m.variantGroup; delete m.variant }
      continue
    }
    const seen = new Set<string>()
    const kept: FrameEntry[] = []
    for (const m of members.sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''))) {
      if (seen.has(m.variant!)) {
        console.warn(`[marver] duplicate variant "${m.variant}" in group "${group}" (${m.file}) - not grouped.`)
        delete m.variantGroup; delete m.variant
        continue
      }
      seen.add(m.variant!)
      kept.push(m)
    }
    if (kept.length < 2) for (const m of kept) { delete m.variantGroup; delete m.variant }
  }
  // a stray meta.variant with no materialized group is noise, not data
  for (const f of frames) if (f.variant && !f.variantGroup) delete f.variant
}

/** Write design/manifest.json only when content changed. Returns the manifest either way. */
export function writeManifest(root: string, manifest: Manifest): boolean {
  const file = join(root, 'design', 'manifest.json')
  const next = JSON.stringify(manifest, null, 2) + '\n'
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (hash(prev) === hash(next)) return false
  mkdirSync(join(root, 'design'), { recursive: true })
  writeFileSync(file, next)
  return true
}

export const hash = (s: string) => createHash('sha256').update(s).digest('hex')
