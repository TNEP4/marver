import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { COMMANDS, RELAYS, type CmdName } from '../src/client/shell/commands.ts'

/**
 * Spec 30 R16's static gate for the canvas (R12, the "two gates": the app's twin is
 * app/test/unit/r30-commands-static.test.ts). It walks the TypeScript syntax tree of src/client/shell, src/client/stage
 * and src/client/frame-host, in three steps:
 *  - **Input sites**: every JSX onClick, onDoubleClick, onContextMenu, onPointerDown, onMouseDown, onKeyDown, onBlur and
 *    onChange; every `on*` prop given to a component; every object literal's onClick (a context-menu item); every
 *    addEventListener for keydown, keyup, pointerdown, click, contextmenu, popstate, hashchange.
 *  - **Dispatcher branches, one by one**: each e.key/e.code test of App.tsx's and Play.tsx's key handlers, and each
 *    input-carrying data.type branch of their message handlers, reaches `cmd()` itself - never one recording call
 *    somewhere else in the handler.
 *  - **Forwarding paths have declared owners** (`RELAYS`): a frame's or the stage's post is covered only when the shell
 *    branch that takes it exists and records; `it.onClick` in ContextMenu.tsx forwards to items checked on their own;
 *    `runMenuItem` must run the relayed key through `relayed()`.
 * What is covered by shape needs no entry: a guard (only stopPropagation/preventDefault), typing (only a setter with
 * e.target.value), a context-menu opener (its items are sites). Everything else records or has an exact entry in
 * test/not-commands.json - file, enclosing function, prop, label - with a reason; an entry that matches nothing fails.
 */

const ROOT = join(import.meta.dirname, '..')
const DIRS = ['src/client/shell', 'src/client/stage', 'src/client/frame-host']
const FIXTURES = join(ROOT, 'test', 'fixtures', 'commands-static')

const EVENT_PROPS = new Set(['onClick', 'onDoubleClick', 'onContextMenu', 'onPointerDown', 'onMouseDown', 'onKeyDown', 'onBlur', 'onChange'])
/** Component callbacks that are no input: a lifecycle, a measure, or rzpp's camera (gesture records, the R12 list). */
const NOT_INPUT_PROPS = new Set(['onLoad', 'onError', 'onResize', 'onScroll', 'onRender', 'onSize', 'onInit', 'onTransformed', 'onPanningStart', 'onPanningStop', 'onZoomStart', 'onZoomStop'])
const EVENTS = new Set(['keydown', 'keyup', 'pointerdown', 'click', 'contextmenu', 'popstate', 'hashchange'])
/** What a document posts when it forwards input, and the shell branch that must record it (#51, RELAYS). */
const FORWARDED = new Set(['sh:key', 'sh:go', 'sh:picked', 'sh:laser-copy', 'sh:exit-interact', 'sh:frame-down', 'sh:stage-key', 'sh:stage-at'])
/** The shell's and Play's input-carrying message branches (R16). */
const MESSAGE_BRANCHES: Record<string, string[]> = {
  'src/client/shell/App.tsx': ['sh:key', 'sh:go', 'sh:picked', 'sh:laser-copy', 'sh:exit-interact', 'sh:frame-down'],
  'src/client/shell/Play.tsx': ['sh:key', 'sh:stage-key', 'sh:stage-at', 'sh:picked', 'sh:laser-copy', 'sh:frame-down'],
}
/** The key dispatchers, checked branch by branch: the handler's own name. */
const DISPATCHERS: Record<string, string[]> = {
  'src/client/shell/App.tsx': ['onKey'],
  'src/client/shell/Play.tsx': ['handleKey', 'onKey'],
  'test/fixtures/commands-static/unrecorded-branch.tsx': ['onKey'],
  'test/fixtures/commands-static/recorded.tsx': ['onKey'],
}

interface Parsed { rel: string; sf: ts.SourceFile; fns: Map<string, ts.Node[]> }
interface Entry { file: string; fn: string; prop: string; label: string; reason?: string }
interface Site extends Entry { line: number; covered: boolean }

const isFn = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)

function parse(abs: string): Parsed {
  const text = readFileSync(abs, 'utf8')
  const kind = abs.endsWith('.tsx') ? ts.ScriptKind.TSX : abs.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2022, true, kind)
  const fns = new Map<string, ts.Node[]>()
  const add = (name: string, n: ts.Node) => fns.set(name, [...(fns.get(name) ?? []), n])
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text, n)
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFn(n.initializer)) add(n.name.text, n.initializer)
    else if (ts.isMethodDeclaration(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) add(n.name.text, n)
    else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && isFn(n.initializer)) add(n.name.text, n.initializer)
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && isFn(n.right)) add(n.left.name.text, n.right)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { rel: relative(ROOT, abs), sf, fns }
}

const calleeName = (e: ts.Expression): string | undefined =>
  ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined

/** Does this code reach `cmd()` - itself, through a same-file function it calls or names, or through another file's
 *  exported recording function (`recording`)? */
function reaches(node: ts.Node, f: Parsed, recording: Set<string>, seen = new Set<ts.Node>()): boolean {
  let hit = false
  const follow = (name: string | undefined) => {
    if (!name || hit) return
    if (name === 'cmd' || recording.has(name)) { hit = true; return }
    for (const body of f.fns.get(name) ?? []) {
      if (seen.has(body)) continue
      seen.add(body)
      if (reaches(body, f, recording, seen)) { hit = true; return }
    }
  }
  const visit = (n: ts.Node) => {
    if (hit) return
    if (ts.isCallExpression(n)) follow(calleeName(n.expression))
    else if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) { if (f.fns.has(n.text)) follow(n.text) }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return hit
}

/** Does this code post a forwarded input (RELAYS), itself or through a same-file function? */
function forwards(node: ts.Node, f: Parsed, seen = new Set<ts.Node>()): boolean {
  let hit = false
  const visit = (n: ts.Node) => {
    if (hit) return
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression)
      const a = n.arguments[0]
      if ((name === 'post' || name === 'postMessage') && a && ts.isObjectLiteralExpression(a)) {
        for (const p of a.properties) if (ts.isPropertyAssignment(p) && p.name.getText() === 'type' && ts.isStringLiteralLike(p.initializer) && FORWARDED.has(p.initializer.text)) hit = true
      }
      for (const body of (name ? f.fns.get(name) : undefined) ?? []) {
        if (seen.has(body)) continue
        seen.add(body)
        if (forwards(body, f, seen)) hit = true
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return hit
}

/** The nearest named function around a node: `(top)` at the module's level. */
function enclosing(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isPropertyAssignment(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text
    if (ts.isClassDeclaration(p) && p.name) return p.name.text
  }
  return '(top)'
}

const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 60)

/** What names an element in `not-commands.json`: its aria-label, a data-* attribute, its title, or its visible text. */
function labelOf(open: ts.JsxOpeningLikeElement): string {
  let aria = '', data = '', title = ''
  const value = (a: ts.JsxAttribute) => {
    const i = a.initializer
    if (!i) return ''
    if (ts.isStringLiteral(i)) return i.text
    return ts.isJsxExpression(i) && i.expression ? short(i.expression.getText()) : ''
  }
  for (const a of open.attributes.properties) {
    if (!ts.isJsxAttribute(a)) continue
    const n = a.name.getText()
    if (n === 'aria-label') aria = value(a)
    else if (n.startsWith('data-') && !data) data = `${n}=${value(a)}`
    else if (n === 'title') title = value(a)
  }
  if (aria || data || title) return aria || data || title
  if (ts.isJsxOpeningElement(open) && ts.isJsxElement(open.parent)) {
    // the visible text, its nested elements' too
    const words: string[] = []
    const visit = (c: ts.Node) => { if (ts.isJsxText(c) && c.text.trim()) words.push(c.text.trim()); ts.forEachChild(c, visit) }
    open.parent.children.forEach(visit)
    if (words.length) return short(words.join(' '))
  }
  return ''
}

/** A handler that only stops the event, or only sets state from a field's value: covered by its shape. */
function byShape(fn: ts.Node, prop: string): 'guard' | 'typing' | 'opener' | null {
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn))) return null
  const body = fn.body
  if (!body) return null
  const text = body.getText()
  if (/\b(cm\.open|onMenu)\(/.test(text)) return 'opener'
  const stmts: ts.Node[] = ts.isBlock(body) ? [...body.statements] : [body]
  const callsOf = (s: ts.Node) => (ts.isExpressionStatement(s) ? s.expression : s)
  const guard = (s: ts.Node) => { const c = callsOf(s); return ts.isCallExpression(c) && /^(stopPropagation|preventDefault|stopImmediatePropagation)$/.test(calleeName(c.expression) ?? '') }
  const setter = (s: ts.Node) => { const c = callsOf(s); return ts.isCallExpression(c) && /^set[A-Z]/.test(calleeName(c.expression) ?? '') }
  const typing = (s: ts.Node) => setter(s) && (callsOf(s) as ts.CallExpression).arguments.some((a) => /\.(target|currentTarget)\.(value|checked)\b/.test(a.getText()))
  if (stmts.length && stmts.every(guard)) return 'guard'
  if ((prop === 'onChange' || prop === 'onInput') && stmts.length && stmts.every((s) => guard(s) || setter(s)) && stmts.some(typing)) return 'typing'
  return null
}

/** The names a function's parameters bind. */
function boundBy(p: ts.Node): string[] {
  if (!isFn(p)) return []
  return p.parameters.flatMap((param) => (ts.isIdentifier(param.name) ? [param.name.text]
    : ts.isObjectBindingPattern(param.name) ? param.name.elements.flatMap((b) => (ts.isIdentifier(b.name) ? [b.name.text] : [])) : []))
}
/** Is `name` a parameter (or a destructured prop) of a function around `at`? */
function isParam(name: string, at: ts.Node): boolean {
  for (let p: ts.Node | undefined = at.parent; p; p = p.parent) if (boundBy(p).includes(name)) return true
  return false
}
/** The leftmost name of `a.b.c`. */
const rootOf = (e: ts.Expression): string | undefined => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? rootOf(e.expression) : undefined)

/** A handler that calls a prop of its component (`onSelect(name)`): its caller's prop is the site. */
function callsProp(fn: ts.Node, at: ts.Node, f: Parsed, seen = new Set<ts.Node>()): boolean {
  let hit = false
  const visit = (n: ts.Node) => {
    if (hit) return
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression), root = rootOf(n.expression)
      if (name && /^on[A-Z]/.test(name) && root && isParam(root, at)) hit = true
      for (const body of (name ? f.fns.get(name) : undefined) ?? []) {
        if (seen.has(body)) continue
        seen.add(body)
        if (callsProp(body, body, f, seen)) hit = true
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(fn)
  return hit
}
/** A function that takes the command its caller started, and ends it: the caller is the site, and it records. */
const takesHandle = (fn: ts.Node) => isFn(fn) && fn.parameters.some((p) => p.type?.getText() === 'CmdHandle' || (ts.isIdentifier(p.name) && p.name.text === 'h'))

/** Is this expression a prop of the component it is used in (its caller is the site)? */
function isForwardedProp(e: ts.Expression, at: ts.Node): boolean {
  const root = rootOf(e)
  return !!root && (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) && isParam(root, at)
}

/** Is a handler covered: it records, it forwards, or its shape says so. */
function covered(h: ts.Expression | undefined, at: ts.Node, f: Parsed, prop: string, recording: Set<string>): boolean {
  if (!h) return true
  if (h.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(h) && h.text === 'undefined') || h.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isParenthesizedExpression(h)) return covered(h.expression, at, f, prop, recording)
  if (ts.isConditionalExpression(h)) return covered(h.whenTrue, at, f, prop, recording) && covered(h.whenFalse, at, f, prop, recording)
  if (isForwardedProp(h, at)) return true
  if (ts.isIdentifier(h) || ts.isPropertyAccessExpression(h)) {
    const name = calleeName(h)!
    if (recording.has(name) || name === 'cmd') return true
    if (/^(cm\.open|onMenu)$/.test(h.getText())) return true
    // a setter given to a field's own change: typing
    if (prop === 'onChange' && /^set[A-Z]/.test(name)) return true
    const bodies = f.fns.get(name) ?? []
    return bodies.some((b) => byShape(b, prop) !== null || takesHandle(b) || callsProp(b, b, f) || reaches(b, f, recording) || forwards(b, f))
  }
  if (byShape(h, prop) || takesHandle(h) || callsProp(h, at, f)) return true
  return reaches(h, f, recording) || forwards(h, f)
}

/** The ContextMenu dispatcher (RELAYS' first row): it forwards to each MenuItem's onClick, a site of its own. */
const isItemDispatch = (h: ts.Expression | undefined) => !!h && /\bit\.onClick\b/.test(h.getText())

function sitesOf(f: Parsed, recording: Set<string>): Site[] {
  const out: Site[] = []
  const line = (n: ts.Node) => f.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
  const push = (n: ts.Node, prop: string, label: string, ok: boolean) => out.push({ file: f.rel, fn: enclosing(n), prop, label, line: line(n), covered: ok })
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n)) {
      const prop = n.name.getText()
      const open = n.parent.parent as ts.JsxOpeningLikeElement
      const tag = open.tagName.getText()
      const intrinsic = /^[a-z]/.test(tag)
      const isSite = intrinsic ? EVENT_PROPS.has(prop) : /^on[A-Z]/.test(prop) && !NOT_INPUT_PROPS.has(prop)
      if (isSite && n.initializer && ts.isJsxExpression(n.initializer)) {
        const h = n.initializer.expression
        push(n, prop, labelOf(open), isItemDispatch(h) || covered(h, n, f, prop, recording))
      }
    } else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'onClick' && ts.isObjectLiteralExpression(n.parent)) {
      const lab = n.parent.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'label') as ts.PropertyAssignment | undefined
      push(n, 'item:onClick', lab ? short(lab.initializer.getText().replace(/^['"`]|['"`]$/g, '')) : '', covered(n.initializer, n, f, 'onClick', recording))
    } else if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression)
      // `on(document, 'pointerdown', fn)`: inspect.js's listener helper
      const [ev, fn] = name === 'addEventListener' ? [n.arguments[0], n.arguments[1]] : name === 'on' ? [n.arguments[1], n.arguments[2]] : [undefined, undefined]
      if (ev && ts.isStringLiteralLike(ev) && EVENTS.has(ev.text)) push(n, `addEventListener:${ev.text}`, '', covered(fn, n, f, ev.text, recording))
    }
    ts.forEachChild(n, visit)
  }
  visit(f.sf)
  return out
}

/** Each key test of a dispatcher (a key compare in an `if`), its `then` reaching `cmd()`. */
function branchesOf(f: Parsed, names: string[], recording: Set<string>): Site[] {
  const out: Site[] = []
  const KEY_TEST = /\b(?:e\.key|e\.code|key|code)\s*===|\.test\((?:e\.)?(?:code|key)\)/
  const seen = new Set<ts.Node>()
  for (const name of names) {
    for (const body of f.fns.get(name) ?? []) {
      const visit = (n: ts.Node) => {
        if (ts.isIfStatement(n) && !seen.has(n)) {
          seen.add(n)
          const test = n.expression.getText()
          if (KEY_TEST.test(test)) {
            out.push({
              file: f.rel, fn: name, prop: 'branch', label: short(test),
              line: f.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
              covered: reaches(n.thenStatement, f, recording),
            })
          }
        }
        ts.forEachChild(n, visit)
      }
      visit(body)
    }
  }
  return out
}

/** Each input-carrying `data.type` branch: it exists, and it records. */
function messageBranchesOf(f: Parsed, types: string[], recording: Set<string>): Site[] {
  const found = new Map<string, boolean>()
  const visit = (n: ts.Node) => {
    if (ts.isIfStatement(n)) {
      const m = /^data\.type === '(sh:[a-z-]+)'/.exec(n.expression.getText())
      if (m && types.includes(m[1])) found.set(m[1], reaches(n.thenStatement, f, recording))
    }
    ts.forEachChild(n, visit)
  }
  visit(f.sf)
  return types.map((t) => ({ file: f.rel, fn: 'message handler', prop: 'branch', label: t, line: 0, covered: found.get(t) === true }))
}

const walkDir = (dir: string): string[] => readdirSync(dir).flatMap((e) => {
  const p = join(dir, e)
  return statSync(p).isDirectory() ? walkDir(p) : /\.(tsx?|js)$/.test(e) && !/\.d\.ts$/.test(e) ? [p] : []
})

/** The functions of the scanned files that record, by name, for calls from another file: exported functions, and the
 *  store's methods (`copyFrameImage`). */
function recordingFunctions(parsed: Parsed[]): Set<string> {
  const recording = new Set<string>()
  const exported = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
  for (let changed = true; changed;) {
    changed = false
    for (const f of parsed) {
      if (f.rel.endsWith('shell/commands.ts')) continue   // the engine's own helpers record nothing by themselves
      const add = (name: string, node: ts.Node) => { if (!recording.has(name) && reaches(node, f, recording)) { recording.add(name); changed = true } }
      for (const s of f.sf.statements) {
        if (ts.isFunctionDeclaration(s) && s.name && exported(s)) add(s.name.text, s)
        else if (ts.isVariableStatement(s) && exported(s)) {
          for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && isFn(d.initializer)) add(d.name.text, d.initializer)
        }
      }
      if (f.rel.endsWith('shell/store.ts')) {
        const visit = (n: ts.Node) => { if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) add(n.name.text, n); ts.forEachChild(n, visit) }
        visit(f.sf)
      }
    }
  }
  return recording
}

/** The walk: what is uncovered, and which allowlist entries match nothing. */
function walk(parsed: Parsed[], allow: Entry[], recording = recordingFunctions(parsed)): { gaps: Site[]; stale: Entry[]; sites: Site[] } {
  const sites = parsed.flatMap((f) => [
    ...sitesOf(f, recording),
    ...branchesOf(f, DISPATCHERS[f.rel] ?? [], recording),
    ...messageBranchesOf(f, MESSAGE_BRANCHES[f.rel] ?? [], recording),
  ])
  const key = (e: Entry) => `${e.file}|${e.fn}|${e.prop}|${e.label}`
  const uncovered = sites.filter((s) => !s.covered)
  const listed = new Set(allow.map(key))
  const gaps = uncovered.filter((s) => !listed.has(key(s)))
  const hit = new Set(uncovered.map(key))
  return { gaps, stale: allow.filter((e) => !hit.has(key(e))), sites }
}

const say = (s: Site[]) => s.map((x) => `${x.file}:${x.line} ${x.fn} ${x.prop} "${x.label}"`).join('\n')
const shellFiles = () => DIRS.flatMap((d) => walkDir(join(ROOT, d))).map(parse)
const notCommands = (): Entry[] => JSON.parse(readFileSync(join(ROOT, 'test', 'not-commands.json'), 'utf8'))
const fixture = (name: string) => parse(join(FIXTURES, name))

describe('the static gate (R16): every input reaches cmd(), or says why not', () => {
  it('every input site and dispatcher branch of the shell records, or has an exact entry with its reason', () => {
    const { gaps, stale, sites } = walk(shellFiles(), notCommands())
    expect(sites.length).toBeGreaterThan(200)   // the walk really walked
    expect(say(gaps), 'input sites with no command and no not-commands.json entry').toBe('')
    expect(stale, 'not-commands.json entries that match nothing').toEqual([])
  })

  it('each entry gives its reason', () => {
    for (const e of notCommands()) expect(e.reason, `${e.file} ${e.fn} ${e.prop} ${e.label}`).toBeTruthy()
  })

  it('every name in the vocabulary is recorded by a cmd() call somewhere', () => {
    const called = new Set<string>()
    const literalsOf = (e: ts.Node) => { const v = (n: ts.Node) => { if (ts.isStringLiteralLike(n)) called.add(n.text); ts.forEachChild(n, v) }; v(e) }
    for (const f of shellFiles()) {
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && calleeName(n.expression) === 'cmd' && n.arguments[0]) {
          literalsOf(n.arguments[0])
          // `cmd(name, ...)`, its name from the file's own table or props: each name it may be, a literal in that file
          if (ts.isIdentifier(n.arguments[0])) literalsOf(f.sf)
        }
        ts.forEachChild(n, visit)
      }
      visit(f.sf)
    }
    const missing = (Object.keys(COMMANDS) as CmdName[]).filter((n) => !called.has(n))
    expect(missing, 'vocabulary rows no dispatch point records').toEqual([])
  })

  it('a relayed menu item runs through relayed(), and its owner is the key handler (RELAYS)', () => {
    const f = parse(join(ROOT, 'src/client/shell/app-bridge.ts'))
    const run = f.fns.get('runMenuItem')?.[0]
    expect(run, 'runMenuItem exists').toBeTruthy()
    expect(run!.getText()).toMatch(/\brelayed\(/)
    expect(run!.getText()).toMatch(/\bmarkSeenFrom\(/)
    expect(RELAYS.length).toBeGreaterThan(0)
    for (const r of RELAYS) expect(r.owner && r.why, r.from).toBeTruthy()
  })

  it('a frame\'s and the stage\'s forwarded inputs each have a recording owner', () => {
    for (const rel of Object.keys(MESSAGE_BRANCHES)) {
      const f = parse(join(ROOT, rel))
      const parsed = shellFiles()
      const bad = messageBranchesOf(f, MESSAGE_BRANCHES[rel], recordingFunctions(parsed)).filter((s) => !s.covered)
      expect(say(bad)).toBe('')
    }
  })
})

describe('the walk itself: negative fixtures must fail it (R16)', () => {
  const gapsOf = (name: string) => walk([fixture(name)], []).gaps
  it('an unrecorded button', () => {
    expect(gapsOf('unrecorded-button.tsx').map((g) => [g.prop, g.label])).toEqual([['onClick', 'Do the thing']])
  })
  it('an unrecorded context-menu item', () => {
    expect(gapsOf('unrecorded-menu-item.tsx').map((g) => [g.prop, g.label])).toEqual([['item:onClick', 'Delete']])
  })
  it('an unrecorded branch in a dispatcher, though another branch records', () => {
    expect(gapsOf('unrecorded-branch.tsx').map((g) => g.label)).toEqual(["e.key === 'z'"])
  })
  it('an unrecorded keydown listener', () => {
    expect(gapsOf('unrecorded-listener.tsx').map((g) => g.prop)).toEqual(['addEventListener:keydown'])
  })
  it('what is covered - a record, a named function, a prop, a guard, typing, an opener and its item - needs no entry', () => {
    expect(say(gapsOf('recorded.tsx'))).toBe('')
  })
  it('an exact entry covers its site; without its site it is stale; a near miss covers nothing', () => {
    const rel = 'test/fixtures/commands-static/allowlisted.tsx'
    const entry: Entry = { file: rel, fn: 'Menu', prop: 'onClick', label: 'Open the menu', reason: 'a menu' }
    const f = fixture('allowlisted.tsx')
    expect(walk([f], [entry])).toMatchObject({ gaps: [], stale: [] })
    expect(walk([f], [{ ...entry, label: 'Open the' }]).gaps).toHaveLength(1)
    expect(walk([f], [{ ...entry, label: 'Open the' }]).stale).toHaveLength(1)
    expect(walk([fixture('recorded.tsx')], [entry]).stale).toEqual([entry])
  })
})
