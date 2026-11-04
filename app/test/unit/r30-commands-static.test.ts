/**
 * The app's static coverage gate (spec 30 R16's R12 item): a new button, menu item, dialog, channel or dispatcher branch
 * that records nothing fails the build. The walk reads the TypeScript syntax tree of `app/pages/**` and
 * `app/src/main/{menu,views,keys,notify,window,main,updater,mover}.ts`, in three steps:
 *
 * - **Input sites.** The pages' DOM `onclick`, `oncontextmenu` and `onchange`, assigned or passed as a prop, and every
 *   `addEventListener` for `keydown`, `keyup`, `pointerdown`, `click`, `contextmenu`; every Electron menu item with a
 *   `click` or built by a `cmd()` helper; every `dialog.showMessageBox*` answer; every `pages.handle(CH.*)` and `SENDERS`
 *   channel; each `case` of `runCommand` and `tabAct`.
 * - **Each reaches a recording**: `appCmd()` in its own body or through a same-file function, a few levels deep (a
 *   dialog's helper counts its callers too), or a forwarding call declared in `APP_RELAYS`, whose owner must exist and
 *   record. A dispatcher's branch must end the command its function started, branch by branch.
 * - **Or it is declared**, in `not-commands.json` under an exact key - file, enclosing function, prop, label - with its
 *   reason. No wildcards; an entry that matches nothing fails as stale. A handler that only calls `stopPropagation()` or
 *   `preventDefault()` is a guard, one that only passes `e.target.value` to a setter is typing: both by their shape.
 *
 * The negative fixtures (fixtures/commands-static/) show the walk failing on what it must.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { APP_COMMANDS, APP_RELAYS, PAGE_CHANNELS, pageCommand, TAB_ACTIONS, type AppRelay } from '../../src/main/commands.ts'
import { ACCELERATORS } from '../../src/main/keys.ts'
import { SENDERS } from '../../src/shared/channels.ts'

const APP = join(import.meta.dirname, '..', '..')
const MAIN_FILES = ['menu', 'views', 'keys', 'notify', 'window', 'main', 'updater', 'mover'].map((f) => `src/main/${f}.ts`)
const pageFiles = (): string[] => {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(join(APP, d))) {
      const p = join(d, n)
      if (statSync(join(APP, p)).isDirectory()) walk(p)
      else if (p.endsWith('.ts')) out.push(p)
    }
  }
  walk('pages')
  return out
}

const INPUT_PROPS = new Set(['onclick', 'oncontextmenu', 'onchange'])
const INPUT_EVENTS = new Set(['keydown', 'keyup', 'pointerdown', 'click', 'contextmenu'])
const DEPTH = 5

interface Site { file: string; fn: string; prop: string; label: string; why: string }
interface Parsed { file: string; sf: ts.SourceFile; fns: Map<string, ts.Node[]> }

const parse = (file: string, text = readFileSync(join(APP, file), 'utf8')): Parsed => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const fns = new Map<string, ts.Node[]>()
  const add = (name: string, n: ts.Node) => { fns.set(name, [...(fns.get(name) ?? []), n]) }
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text, n)
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) add(n.name.text, n.initializer)
    else if (ts.isMethodDeclaration(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) add(n.name.text, n)
    else if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) add(n.name.text, n.initializer)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { file, sf, fns }
}

/** `api?.pill.act(x)`'s callee as `api.pill.act`; anything that is not a plain chain, undefined. */
const calleeOf = (e: ts.Expression): string | undefined => {
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) { const l = calleeOf(e.expression); return l ? `${l}.${e.name.text}` : undefined }
  if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) return calleeOf(e.expression)
  return undefined
}

/** Whether `node` calls something `test` accepts, in its own body or through a same-file function, a few levels deep. */
function reaches(p: Parsed, node: ts.Node, test: (callee: string) => boolean, depth = DEPTH, seen = new Set<ts.Node>()): boolean {
  if (depth < 0 || seen.has(node)) return false
  seen.add(node)
  let hit = false
  const walk = (n: ts.Node): void => {
    if (hit) return
    if (ts.isCallExpression(n)) {
      const c = calleeOf(n.expression)
      if (c) {
        if (test(c)) { hit = true; return }
        for (const f of p.fns.get(c.split('.').at(-1)!) ?? []) if (reaches(p, f, test, depth - 1, seen)) { hit = true; return }
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
  return hit
}

/** The enclosing function's name, or `<top>`: what an entry's `fn` is. */
function enclosing(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text
    if (ts.isMethodDeclaration(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent) {
      const q = p.parent
      if (ts.isVariableDeclaration(q) && ts.isIdentifier(q.name)) return q.name.text
      if (ts.isPropertyAssignment(q) && (ts.isIdentifier(q.name) || ts.isStringLiteral(q.name))) return q.name.text
    }
  }
  return '<top>'
}

/** What a site is called: an element's `aria-label`, `data-*`, `id`, its menu `label`, a listener's target. */
function labelOf(props: ts.ObjectLiteralExpression | undefined, fallback: string): string {
  const named = (k: string) => props?.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && (ts.isIdentifier(x.name) || ts.isStringLiteral(x.name)) && x.name.text === k)?.initializer
  for (const k of ['aria-label', 'id', 'label', 'data-key', 'class']) {
    const v = named(k)
    if (v) return ts.isStringLiteralLike(v) ? v.text : v.getText()
  }
  return fallback
}

/** A guard, by its shape: it only stops the event. */
function isGuard(handler: ts.Node): boolean {
  let calls = 0, other = false
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = calleeOf(n.expression)
      if (c?.endsWith('.stopPropagation') || c?.endsWith('.preventDefault')) calls += 1
      else other = true
    }
    ts.forEachChild(n, walk)
  }
  walk(handler)
  return calls > 0 && !other
}
/** Typing, by its shape: one setter handed `e.target.value`, or `.checked`, and nothing else. */
function isTyping(handler: ts.Node): boolean {
  let setters = 0, other = false
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const args = n.arguments.map((a) => a.getText())
      if (args.length === 1 && /\.target(\s+as\s+\w+)?\)?\.(value|checked)$/.test(args[0]!)) setters += 1
      else other = true
    }
    ts.forEachChild(n, walk)
  }
  walk(handler)
  return setters > 0 && !other
}

const isRecording = (relays: readonly AppRelay[]) => (c: string): boolean =>
  c === 'appCmd' || relays.some((r) => r.calls.some((x) => (x.endsWith('.') ? c.startsWith(x) : c === x)))

/** The walk over one parsed file: the sites that reach no recording, each with its key. */
function walkFile(p: Parsed, kind: 'page' | 'main', relays: readonly AppRelay[] = APP_RELAYS): Site[] {
  const out: Site[] = []
  const records = isRecording(relays)
  const site = (node: ts.Node, prop: string, label: string, why: string) => { out.push({ file: p.file, fn: enclosing(node), prop, label, why }) }
  /** A handler, or the same-file function it names. */
  const body = (v: ts.Expression): ts.Node[] => {
    if (ts.isArrowFunction(v) || ts.isFunctionExpression(v) || ts.isCallExpression(v)) return [v]
    const c = calleeOf(v)
    return c ? p.fns.get(c.split('.').at(-1)!) ?? [] : []
  }
  const check = (node: ts.Node, v: ts.Expression, prop: string, label: string) => {
    const bs = body(v)
    if (bs.some((b) => isGuard(b) || isTyping(b) || reaches(p, b, records))) return
    site(node, prop, label, 'reaches no recording')
  }
  const visit = (n: ts.Node): void => {
    if (kind === 'page' && ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && INPUT_PROPS.has(n.name.text) && ts.isObjectLiteralExpression(n.parent)) {
      check(n, n.initializer, n.name.text, labelOf(n.parent, '(an element)'))
    }
    if (kind === 'page' && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && INPUT_PROPS.has(n.left.name.text)) {
      check(n, n.right, n.left.name.text, n.left.expression.getText())
    }
    if (kind === 'page' && ts.isCallExpression(n) && calleeOf(n.expression)?.endsWith('.addEventListener') && n.arguments.length >= 2) {
      const ev = n.arguments[0]!
      if (ts.isStringLiteralLike(ev) && INPUT_EVENTS.has(ev.text)) check(n, n.arguments[1]!, `addEventListener:${ev.text}`, (n.expression as ts.PropertyAccessExpression).expression.getText())
    }
    // a menu item: an object literal with a `click`
    // (a journal line's `{ click: id }` is no item: no function there, and no label)
    if (kind === 'main' && ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'click' && ts.isObjectLiteralExpression(n.parent)
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer) || ts.isCallExpression(n.initializer) || n.parent.properties.some((x) => x.name?.getText() === 'label'))) {
      check(n, n.initializer, 'click', labelOf(n.parent, '(an item)'))
    }
    // ... or one a cmd() helper builds, whose click the helper holds
    if (kind === 'main' && ts.isCallExpression(n) && calleeOf(n.expression) === 'cmd' && p.fns.has('cmd')) {
      const words = n.arguments[1]
      if (!p.fns.get('cmd')!.some((f) => reaches(p, f, records))) site(n, 'cmd()', words && ts.isStringLiteralLike(words) ? words.text : '(an item)', 'its helper reaches no recording')
    }
    // a dialog's answer: its own function, or a same-file caller of it, records; or a port a relay declares
    if (kind === 'main' && ts.isCallExpression(n) && /(^|\.)dialog\.showMessageBox(Sync)?$/.test(calleeOf(n.expression) ?? '')) {
      const fn = enclosing(n)
      const declared = relays.some((r) => r.calls.includes(fn) && r.fromFile === p.file)
      const own = (p.fns.get(fn) ?? []).some((f) => reaches(p, f, records))
      if (!declared && !own && !callersReach(p, fn, records)) site(n, 'dialog', fn, 'its answer reaches no recording')
    }
    // a dispatcher's branches, one by one
    if (kind === 'main' && ts.isFunctionDeclaration(n) && (n.name?.text === 'runCommand' || n.name?.text === 'tabAct')) {
      const handle = handleOf(n)
      const visitCase = (c: ts.Node): void => {
        if (ts.isCaseClause(c)) {
          // an empty clause falls through to the next: covered by it
          if (c.statements.length && !mentions(c, handle) && !reaches(p, c, records)) {
            site(c, n.name!.text, c.expression.getText(), `the case never ends the command (${handle ?? 'no handle'})`)
          }
        }
        ts.forEachChild(c, visitCase)
      }
      visitCase(n)
    }
    ts.forEachChild(n, visit)
  }
  visit(p.sf)
  return out
}

/** The variable a dispatcher holds its `appCmd()` in. */
function handleOf(fn: ts.Node): string | undefined {
  let name: string | undefined
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) && calleeOf(n.initializer.expression) === 'appCmd') name = n.name.text
    ts.forEachChild(n, walk)
  }
  walk(fn)
  return name
}
/** The clause uses the handle: it ends it, or hands it to what will. */
function mentions(n: ts.Node, handle: string | undefined): boolean {
  if (!handle) return false
  let hit = false
  const walk = (x: ts.Node): void => { if (ts.isIdentifier(x) && x.text === handle) hit = true; ts.forEachChild(x, walk) }
  walk(n)
  return hit
}
/** A same-file function that calls `fn` and records (a dialog's helper: the caller reads its answer). */
function callersReach(p: Parsed, fn: string, records: (c: string) => boolean): boolean {
  for (const fs of p.fns.values()) {
    for (const f of fs) {
      if (enclosingIsFn(f, fn)) continue
      if (reaches(p, f, (c) => c === fn, 0) && reaches(p, f, records)) return true
    }
  }
  return false
}
const enclosingIsFn = (f: ts.Node, fn: string): boolean => ts.isFunctionDeclaration(f) && f.name?.text === fn

// ---- the tree as it is ---------------------------------------------------------------------------------------------

interface Entry { file: string; fn: string; prop: string; label: string; reason: string }
const entries = JSON.parse(readFileSync(join(import.meta.dirname, 'not-commands.json'), 'utf8')) as Entry[]
const keyOf = (s: Pick<Site, 'file' | 'fn' | 'prop' | 'label'>): string => `${s.file} | ${s.fn} | ${s.prop} | ${s.label}`
const declared = new Set(entries.filter((e) => !e.prop.startsWith('channel')).map(keyOf))

const parsed = [...pageFiles().map((f) => [parse(f), 'page'] as const), ...MAIN_FILES.map((f) => [parse(f), 'main'] as const)]
const found = parsed.flatMap(([p, k]) => walkFile(p, k))
/** Channels no entry and no funnel answers for. */
const channelEntries = new Set(entries.filter((e) => e.prop === 'channel').map((e) => e.label))

describe('the walk over the real tree', () => {
  it('every input site reaches a recording, or is declared with its reason', () => {
    expect(found.filter((s) => !declared.has(keyOf(s))).map((s) => `${keyOf(s)}: ${s.why}`)).toEqual([])
  })
  it('no entry is stale, none is a wildcard, each says why', () => {
    const sites = new Set(found.map(keyOf))
    for (const e of entries) {
      expect(e.reason, keyOf(e)).toMatch(/\w{3}/)
      expect(`${e.file}${e.fn}${e.prop}${e.label}`, keyOf(e)).not.toMatch(/[*?]/)
      if (e.prop === 'channel') expect(Object.keys(SENDERS), `${e.label} is no channel`).toContain(e.label)
      else expect(sites.has(keyOf(e)), `stale: ${keyOf(e)}`).toBe(true)
    }
  })
  it('every SENDERS channel the funnel records, or is declared no input', () => {
    for (const ch of Object.keys(SENDERS)) {
      if (channelEntries.has(ch)) {
        expect(PAGE_CHANNELS, ch).not.toContain(ch)
        expect(pageCommand(ch, { kind: 'settings' }, {}), ch).toBe(null)
      } else {
        expect(PAGE_CHANNELS, `${ch} is neither recorded by the funnel nor in not-commands.json`).toContain(ch)
      }
    }
    for (const ch of PAGE_CHANNELS) expect(Object.keys(SENDERS), ch).toContain(ch)
  })
  it('the funnel names a command for each channel it records, a name of the table', () => {
    const payload: Record<string, unknown> = {
      'tab:activate': { id: 't1' }, 'tab:close': { id: 't1' }, 'tab:menu': { id: 't1', x: 1, y: 1 }, 'tabs:more': { ids: [], x: 1, y: 1 }, 'link:open': { url: 'x' },
      'pill:action': { rev: 1, act: 'button' }, 'tabpage:action': { rev: 1, action: 'retry' }, 'home:action': { action: 'show-files' }, 'settings:set': { file: 'config', key: 'k', value: 1 },
    }
    for (const ch of PAGE_CHANNELS) {
      const c = pageCommand(ch, { kind: SENDERS[ch]![0]! }, payload[ch] ?? {})
      expect(c, ch).not.toBe(null)
      expect(Object.keys(APP_COMMANDS), `${ch}: ${c!.name}`).toContain(c!.name)
    }
  })
  it('every page.handle(CH.*) and bridge.handle(CH.*) in main\'s walked files is a channel the funnel or an entry answers for', () => {
    for (const [p] of parsed) {
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && /(^|\.)(pages|bridge)\.handle$/.test(calleeOf(n.expression) ?? '')) {
          const arg = n.arguments[0]!.getText()
          // (a port's pass-through, `bridge.handle(ch, ...)`, is no channel of its own)
          if (arg.startsWith('CH.')) expect([...PAGE_CHANNELS, ...channelEntries], `${p.file}: ${arg}`).toContain(CHANNEL_NAMES[arg.slice(3)])
        }
        ts.forEachChild(n, walk)
      }
      walk(p.sf)
    }
  })
  it('runCommand covers every key, tabAct every tab action, mark-all-seen being a relay', () => {
    const cases = (fn: string): string[] => {
      const views = parsed.find(([p]) => p.file === 'src/main/views.ts')![0]
      const out: string[] = []
      const walk = (n: ts.Node): void => { if (ts.isCaseClause(n)) out.push(n.expression.getText().replace(/'/g, '')); ts.forEachChild(n, walk) }
      for (const f of views.fns.get(fn)!) walk(f)
      return out
    }
    const run = new Set(cases('runCommand'))
    for (const c of Object.keys(ACCELERATORS).concat(['focus-strip', 'focus-strip-back'])) {
      if (/^tab-(\d|last)$/.test(c)) continue                       // the digit branch above the switch
      expect(run, c).toContain(c)
    }
    expect(cases('tabAct').sort()).toEqual([...TAB_ACTIONS].sort())
  })
})

describe('the table holds every code the dispatch points write (#52)', () => {
  it('each literal `noop`, `fail` and `unobserved` code in main\'s dispatch points is in APP_COMMANDS, or is a signal\'s own', () => {
    const table = new Set(Object.values(APP_COMMANDS).flatMap((s) => [...(s.noop ?? []), ...(s.failed ?? [])]))
    const SIGNALS = new Set(['deadline', 'hidden', 'threw', 'wait', 'dropped'])   // commands.ts writes these itself, whichever the name
    const seen: string[] = []
    for (const f of [...MAIN_FILES, 'src/main/commands.ts', 'src/main/bridge.ts']) {
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && /\.(noop|fail)$/.test(calleeOf(n.expression) ?? '') && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) seen.push(n.arguments[0].text)
        ts.forEachChild(n, walk)
      }
      walk(parse(f).sf)
    }
    expect(seen.length).toBeGreaterThan(5)
    expect([...new Set(seen)].filter((c) => !table.has(c) && !SIGNALS.has(c))).toEqual([])
  })
})

describe('the relays (each owner exists and records)', () => {
  for (const r of APP_RELAYS) {
    it(`${r.from} → ${r.owner}`, () => {
      const path = join(APP, r.ownerFile)
      expect(existsSync(path), r.ownerFile).toBe(true)
      const p = parse(relative(APP, path))
      const fns = p.fns.get(r.ownerFn) ?? []
      expect(fns.length, `${r.ownerFile} has no ${r.ownerFn}`).toBeGreaterThan(0)
      // the shell's own gate checks that runMenuItem records (test/commands-static.test.ts); the handoff's writer is writeMoveCmd
      if (r.ownerFile.startsWith('../')) return
      const records = (c: string) => c === 'appCmd' || c === 'writeMoveCmd'
      expect(fns.some((f) => reaches(p, f, records)), `${r.ownerFn} records nothing`).toBe(true)
    })
  }
  it('each relay names at least one forwarding call', () => { for (const r of APP_RELAYS) expect(r.calls.length, r.from).toBeGreaterThan(0) })
})

describe('the negative fixtures: the walk fails on what it must', () => {
  const fixture = (name: string, kind: 'page' | 'main') => walkFile(parse(`test/unit/fixtures/commands-static/${name}.ts`), kind)
  it('an app menu item with a bare click', () => {
    expect(fixture('menu-bare-click', 'main')).toEqual([expect.objectContaining({ prop: 'click', label: 'Unrecorded Item', fn: '<top>' })])
  })
  it('an unrecorded page button', () => {
    expect(fixture('page-button', 'page')).toEqual([expect.objectContaining({ prop: 'onclick', label: 'Unrecorded', fn: '<top>' })])
  })
  it('a dispatcher branch that never ends its command, and no other', () => {
    const sites = fixture('run-branch', 'main')
    expect(sites).toEqual([expect.objectContaining({ fn: 'runCommand', label: "'uncovered'" })])
  })
  it('a dialog whose answer records nothing', () => {
    expect(fixture('dialog-bare', 'main')).toEqual([expect.objectContaining({ prop: 'dialog', label: 'askNobody' })])
  })
  it('a guard, typing and a page\'s relay are classified by their shape: nothing to report', () => {
    expect(fixture('page-shapes', 'page')).toEqual([])
  })
  it('a not-commands entry for a site that is not there would be stale: the check above reads the same set', () => {
    expect(found.map(keyOf)).not.toContain('nowhere | nothing | onclick | none')
  })
})

/** `CH`'s names, read from the source: this file needs no import of what the walk reads. */
const CHANNEL_NAMES = (() => {
  const sf = ts.createSourceFile('channels.ts', readFileSync(join(APP, 'src/shared/channels.ts'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: Record<string, string> = {}
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.name.getText() === 'CH' && n.initializer) {
      const lit = ts.isAsExpression(n.initializer) ? n.initializer.expression : n.initializer
      if (ts.isObjectLiteralExpression(lit)) for (const x of lit.properties) if (ts.isPropertyAssignment(x) && ts.isStringLiteralLike(x.initializer)) out[x.name.getText()] = x.initializer.text
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return out
})()
