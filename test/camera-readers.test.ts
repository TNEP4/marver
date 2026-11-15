import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// In Chromium the camera's variables reach only the elements Canvas.tsx's CAMERA_READERS names (and their
// subtrees): a styles.css rule that reads one on an element outside that list would silently get its var() default
// and stop following the zoom. Every such rule must name one of the listed readers.

const ROOT = join(import.meta.dirname, '..')
const css = readFileSync(join(ROOT, 'src/client/shell/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const canvas = readFileSync(join(ROOT, 'src/client/shell/canvas/Canvas.tsx'), 'utf8')
const READS = /var\(--(sh-inv|sh-s|sh-tx|sh-ty|grid-size|grid-pos|grid-alpha)\b/

/** The selectors of every rule (inside @media and the like too) whose declarations read a camera variable. */
function readers(text: string): string[] {
  const out: string[] = []
  let at = 0
  for (;;) {
    const open = text.indexOf('{', at)
    if (open < 0) return out
    const sel = text.slice(text.lastIndexOf('}', open) + 1, open).trim()
    let depth = 1, end = open + 1
    while (depth) { if (text[end] === '{') depth++; else if (text[end] === '}') depth--; end++ }
    const body = text.slice(open + 1, end - 1)
    if (sel.startsWith('@')) out.push(...readers(body))
    else if (READS.test(body)) out.push(...sel.split(',').map((s) => s.trim().replace(/\s+/g, ' ')))
    at = end
  }
}

describe('camera readers', () => {
  const list = /const CAMERA_READERS = ([\s\S]*?)\nlet /.exec(canvas)?.[1]
  const named = [...(list ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]).join('')
    .replace(/#sh-world :is\(([^)]*)\)/, '$1').split(',').map((s) => s.trim())
  // a listed reader covers a selector that names it on any compound: `.sh-vbadge` covers `.sh-vbadge b`
  const covered = (sel: string) => named.some((r) => new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])').test(sel))

  it('finds the list and the readers', () => {
    expect(named).toContain('.sh-node.sel')
    expect(readers(css)).toContain('.sh-vbadge b')
  })
  it('names every element styles.css reads a camera variable on', () => {
    expect(readers(css).filter((s) => !covered(s))).toEqual([])
  })
})
