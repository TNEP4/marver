import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NAME } from './name.ts'
import { detectHost, readJson, type HostInfo } from '../server/detect.ts'
import { DEFAULTS } from '../server/config.ts'
import { scanFrames, writeManifest } from '../server/manifest.ts'

interface InitOpts { mode: 'studio' | 'embedded'; demo: boolean }

/** Package root = the nearest ancestor holding templates/ (one hop from dist/, two
 *  from src/cli/ - the walk serves both, and tests run init from source). */
const pkgDir = () => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'templates'))) return dir
    dir = dirname(dir)
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/** Idempotent scaffolder: never overwrites existing files; every host-repo touch prints a diff. */
export function init(root: string, opts: InitOpts) {
  const host = detectHost(root)
  const design = join(root, 'design')
  const templates = join(pkgDir(), 'templates')
  const created: string[] = []

  // Collision guard: a design/ that predates marver (assets, Figma exports, a design
  // system's own config.ts) must not be quietly merged into - files would interleave
  // and "uninstall = delete design/" would delete THEIR work. marver-shaped means OUR
  // anchor files by CONTENT, not by name (every generated config.ts and AGENTS.md
  // since 0.1 carries these strings, so re-init on existing workspaces stays fine).
  const fileHas = (rel: string, needle: string) => {
    try { return readFileSync(join(design, rel), 'utf8').includes(needle) } catch { return false }
  }
  const marverShaped = fileHas('config.ts', NAME) || fileHas('AGENTS.md', 'agent contract')
  if (existsSync(design) && !marverShaped && readdirSync(design).some((f) => !f.startsWith('.'))) {
    console.error(`
[${NAME}] design/ already exists in this repo and does not look like a ${NAME} workspace.
         Refusing to merge into it - your files and ${NAME}'s would interleave, and
         "uninstall = delete design/" would stop being safe.

         Move or rename the existing design/ folder, then re-run \`npx ${NAME} init\`.
         (If you need marver to live in a differently-named folder, say so at
         github.com/TNEP4/marver - a --dir flag is planned.)`)
    process.exit(1)
  }

  const write = (rel: string, content: string) => {
    const file = join(design, rel)
    if (existsSync(file)) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    created.push(`design/${rel}`)
  }

  // Managed files (AGENTS.md, instructions/). The marker records a HASH of the body
  // init generated, which makes three states distinguishable with no other stored state:
  //   pristine  (body matches the hash)      -> updates flow through on upgrade
  //   edited    (body differs from the hash) -> NEVER overwritten; when upstream also
  //              moved, the fresh version is staged at design/.local/latest/<rel> and
  //              one line tells the user/agent to merge - an agent merges semantically,
  //              which is why no merge machinery ships here
  //   detached  (marker line deleted)        -> never touched, never mentioned
  const writeManaged = (rel: string, body: string) => {
    const file = join(design, rel)
    const next = managedFile(body)
    const latest = join(design, '.local', 'latest', rel)
    if (!existsSync(file)) return write(rel, next)
    const current = readFileSync(file, 'utf8')
    if (current === next) { rmSync(latest, { force: true }); return }
    if (current.startsWith(MANAGED_PREFIX)) {
      const recorded = current.slice(MANAGED_PREFIX.length).split(' ')[0]
      const nl = current.indexOf('\n')
      const currentBody = nl >= 0 ? current.slice(nl + 1) : ''
      if (nl >= 0 && hashBody(currentBody) === recorded) {
        writeFileSync(file, next)                 // pristine -> take the update
        rmSync(latest, { force: true })
        created.push(`design/${rel} (updated)`)
      } else if (recorded !== hashBody(body)) {
        // edited AND upstream moved: preserve their body verbatim, stage ours for a
        // merge, and bump the marker's recorded base to the new upstream so this
        // note fires ONCE per release, not on every init forever. The bump is
        // ATOMIC (temp + rename) and skipped entirely for a malformed one-line
        // file - user bytes are never on the losing side of a partial write.
        mkdirSync(dirname(latest), { recursive: true })
        writeFileSync(latest, body)
        if (nl >= 0) {
          const tmp = file + '.tmp'
          writeFileSync(tmp, managedFile(body).split('\n')[0] + '\n' + currentBody)
          renameSync(tmp, file)
        }
        console.warn(`  ~ design/${rel}: you customized it and a newer version exists - your edits are untouched. Merge what you want from design/.local/latest/${rel}`)
      }
      // edited, upstream unchanged since their base: silence. A previously staged
      // copy stays put - it is the merge source the note pointed at, and it still
      // matches the current upstream.
    } else if (current.startsWith(LEGACY_PREFIX)) {
      // hashless 0.2.2-dev marker: edits are undetectable; take the update (these
      // files are hours old and ours) and move them onto hashed markers
      writeFileSync(file, next)
      rmSync(latest, { force: true })
      created.push(`design/${rel} (updated)`)
    } else if (current !== body) {
      // no marker: user-owned (fine) or a collision with foreign content that
      // AGENTS.md now declares binding - say so once per init, never touch it
      rmSync(latest, { force: true })              // a detached file keeps no stale stage
      console.warn(`  note: design/${rel} exists without a marver marker - left untouched. If you did not author it, delete it and re-run init to restore the managed version.`)
    }
  }

  // config (commented defaults + native-TS sharp edges). Theme is deliberately absent:
  // design/theme.css (the wrapper) is the source of truth and always wins over config.
  write('config.ts', configTemplate(opts.mode))

  // theme wrapper (spec §5.4) - the host CSS build stays byte-identical
  if (host.themeCss) {
    const relCss = relative(design, join(root, host.themeCss)).split('\\').join('/')
    write('theme.css', themeWrapper(relCss, host.tailwind === 4))
  } else {
    console.warn(`[${NAME}] no theme CSS detected - create design/theme.css importing your app's stylesheet when you have one (or set \`theme\` in design/config.ts).`)
  }

  // providers (mock contexts by detection)
  write('providers.tsx', providersTemplate(host.router, host.toaster, host.routerPkg))

  // agent contract - generated from what was DETECTED, never from wishful thinking:
  // an agent follows the contract it is given (friction log #1). Unlike every other
  // scaffolded file, a stale contract is actively harmful, so a marker-carrying
  // AGENTS.md regenerates when re-run detection disagrees with it ("set up the app,
  // then re-run init" has to actually work). Deleting the marker opts out for good.
  const agentsBody = readFileSync(join(templates, `AGENTS-${opts.mode}.md`), 'utf8')
    .replaceAll('{{UI_GUIDANCE}}', uiGuidance(host, noApp(host)))
    .replace(/\{\{NEXT_NOTES\}\}\n?/, host.router === 'next' ? NEXT_NOTES : '')
  writeManaged('AGENTS.md', agentsBody)
  // pre-marker contracts (0.2.0-era) look user-owned to writeManaged; when one still
  // carries our generated header but predates the method routing, it is stale, not
  // owned - say so instead of silently leaving an outdated contract in charge
  const agentsNow = readFileSync(join(design, 'AGENTS.md'), 'utf8')
  if (!agentsNow.startsWith(MANAGED_PREFIX) && !agentsNow.startsWith(LEGACY_PREFIX)
    && agentsNow.includes('# Design canvas - agent contract') && !agentsNow.includes('## The method (binding)'))
    console.warn(`  note: design/AGENTS.md predates managed regeneration - if you never edited it, delete it and re-run init to get the current contract (incl. the design/instructions routing).`)

  // The Method: short, strict, phase-scoped instruction files AGENTS.md routes into,
  // plus the reference/ shelf of deep guides pulled on demand (stuck, disappointed
  // human, review pass, brand-new work). Managed like the contract itself.
  const instrRoot = join(templates, 'instructions')
  for (const e of readdirSync(instrRoot, { withFileTypes: true })) {
    if (e.isDirectory()) {
      for (const f of readdirSync(join(instrRoot, e.name)))
        if (f.endsWith('.md')) writeManaged(`instructions/${e.name}/${f}`, readFileSync(join(instrRoot, e.name, f), 'utf8'))
    } else if (e.name.endsWith('.md')) {
      writeManaged(`instructions/${e.name}`, readFileSync(join(instrRoot, e.name), 'utf8'))
    }
  }

  // One-time setup state is a PRESENCE FILE, not contract tokens: setup.md exists
  // while the repo has no app, and init deletes it the moment detection finds one.
  // AGENTS.md carries only the one-line STOP pointer (uiGuidance).
  const setupPath = join(design, 'instructions', 'setup.md')
  // absent | ours-pristine | ours-edited | foreign. Marker-carrying files (0.2.4+)
  // are judged by their hash; markerless files with our anchors are 0.2.2/0.2.3-era,
  // pristine-by-construction (write-once and machinery nobody edits by design).
  const setupState = (): string => {
    if (!existsSync(setupPath)) return 'absent'
    const s = readFileSync(setupPath, 'utf8')
    if (s.startsWith(MANAGED_PREFIX)) {
      const recorded = s.slice(MANAGED_PREFIX.length).split(' ')[0]
      const nl = s.indexOf('\n')
      return nl >= 0 && hashBody(s.slice(nl + 1)) === recorded ? 'ours-pristine' : 'ours-edited'
    }
    return s.startsWith('# Setup required') && s.includes('marver init') ? 'ours-pristine' : 'foreign'
  }
  const setupWas = setupState()
  const appJustAppeared = !noApp(host) && (setupWas === 'ours-pristine' || setupWas === 'ours-edited')
  if (noApp(host)) {
    // managed lifecycle: creates it, refreshes a pristine one on upgrade, preserves
    // and stages around a human-edited one - user bytes never lose. Markerless
    // 0.2.2/0.2.3-era files would read as user-owned to writeManaged; they are
    // pristine machinery (setupState says so) - recreate them onto the marker.
    if (setupWas === 'ours-pristine' && !readFileSync(setupPath, 'utf8').startsWith(MANAGED_PREFIX)) rmSync(setupPath)
    if (setupWas !== 'foreign') writeManaged('instructions/setup.md', SETUP_MD)
  } else if (setupWas === 'ours-pristine') {   // delete only what we authored, unedited
    rmSync(setupPath)
    console.log(`  - design/instructions/setup.md removed (app detected - setup complete)`)
  } else if (setupWas === 'ours-edited') {
    console.log(`  - design/instructions/setup.md: app detected, but you customized the file - delete it yourself when setup is done`)
  }

  // design/tsconfig.json extends the root config only when one EXISTS (friction log #4).
  // Path aliases are RE-ROOTED into it: Vite resolves `@/` against the nearest tsconfig,
  // which is this one - inherited paths resolve relative to the declaring config, so
  // without an explicit copy every `@/components/ui` import 500s (scratch-test P0).
  const rootTsconfig = existsSync(join(root, 'tsconfig.json'))
  const tsconfigNow = () => rootTsconfig
    ? readFileSync(join(templates, 'design-tsconfig.json'), 'utf8').replace('{{PATHS}}', designPaths(root))
    : STANDALONE_TSCONFIG
  write('tsconfig.json', tsconfigNow())
  // The no-app run shaped providers.tsx and tsconfig.json blind (no router, no root
  // tsconfig to extend), and write() is write-once - so on the setup->app transition
  // those two would stay wrong forever (standalone tsconfig = every @/ alias 500s).
  // Refresh the ones the user never touched: byte-compare against the exact no-app
  // output, so an edited file is never on the losing side.
  if (appJustAppeared) {
    // candidate baselines, because the no-app run was not always identical: a toaster
    // dep can be detected with no app around it. A pre-existing root tsconfig with
    // since-changed paths stays stale by design - unknowable old output; configure.md's
    // checklist catches unresolvable aliases.
    const refresh = (rel: string, noAppPristine: string[], next: string) => {
      try {
        if (!noAppPristine.includes(next) && noAppPristine.includes(readFileSync(join(design, rel), 'utf8'))) {
          writeFileSync(join(design, rel), next)
          created.push(`design/${rel} (updated for the detected app)`)
        }
      } catch { /* absent - write() above already created the fresh version */ }
    }
    refresh('providers.tsx', [providersTemplate(null, null), providersTemplate(null, host.toaster, host.routerPkg)],
      providersTemplate(host.router, host.toaster, host.routerPkg))
    refresh('tsconfig.json', [STANDALONE_TSCONFIG], tsconfigNow())
  }
  write('.gitignore', '.local/\n.dist/\n')
  // comment logs are append-only + id-keyed: two branches both appending never
  // truly conflict, so git's built-in union driver auto-merges them (worst case a
  // duplicate line, which replay dedupes). Multiplayer comments merge themselves.
  write('.gitattributes', 'comments/*.jsonl merge=union\n')
  write('scenes/_layout.tsx', readFileSync(join(templates, 'root-layout.tsx'), 'utf8'))
  if (!existsSync(join(design, 'boards'))) { mkdirSync(join(design, 'boards'), { recursive: true }); writeFileSync(join(design, 'boards', '.gitkeep'), ''); created.push('design/boards/') }

  if (opts.demo && !existsSync(join(design, 'scenes', 'demo'))) {
    cpSync(join(templates, 'demo'), join(design, 'scenes', 'demo'), { recursive: true })
    created.push('design/scenes/demo/ (3 frames)')
  }

  // The one conditional host patch: tsconfig exclude (printed diff, reversible).
  if (host.tsconfigSweepsDesign) patchTsconfigExclude(root)

  // the first manifest, so AGENTS.md's "read design/manifest.json" is true before dev runs
  writeManifest(root, scanFrames(root))

  console.log(`\n${NAME} initialized (${opts.mode} mode). Created:`)
  for (const f of created) console.log(`  + ${f}`)
  if (host.router === 'next') console.log(`\n  note: Next.js support is partial - frames render outside Next, so next/font, next/image and Server Components do not exist inside them (details in design/AGENTS.md).`)
  if (noApp(host)) {
    console.warn(`
  ┌─ NO APP DETECTED ─────────────────────────────────────────────────────┐
  │ No framework, no theme CSS, no component library. ${NAME} builds      │
  │ frames from YOUR components - with none, designs get thrown away.     │
  │                                                                       │
  │ Setup instructions: design/instructions/setup.md. Your agent will     │
  │ ask what you are building, propose a stack, set it up with you, and   │
  │ re-run init - that file then removes itself. AGENTS.md points there   │
  │ so nothing gets designed against components that do not exist.        │
  └───────────────────────────────────────────────────────────────────────┘`)
  }
  console.log(`\n  commit design/ - only .local/ is ignored`)
  console.log(`  uninstall = delete design/, remove the ${NAME} dependency${host.tsconfigSweepsDesign ? ', revert the "design" line in tsconfig exclude' : ''}`)
  // idle-state completeness (instructions/configure.md item 3): the brand doc is the
  // one piece init cannot generate - it takes reading the app. Say so instead of
  // letting the first session discover the gap.
  if (!noApp(host) && !existsSync(join(design, 'DESIGN.md')))
    console.log(`\n  note: design/DESIGN.md (the brand doc) does not exist yet - have your agent create it from the app's tokens (instructions/brand.md, Path A) to reach the idle state.`)
  console.log(`\n  next: npx ${NAME} dev   (canvas on http://localhost:${DEFAULTS.port} by default)\n`)
  if (!noApp(host)) console.log(`  then, to your agent: "Read design/AGENTS.md. This is our first session - follow design/instructions/welcome.md."\n`)
}

const MANAGED_PREFIX = '<!-- marver:managed '
const LEGACY_PREFIX = '<!-- generated by marver init'
const hashBody = (s: string) => createHash('sha256').update(s).digest('hex')
/** The marker carries a hash of the generated body: edits are DETECTED, not assumed.
 *  Edit freely - init preserves edits and stages upstream updates for merging.
 *  Deleting the marker line detaches the file from updates entirely. */
const managedFile = (body: string) =>
  `${MANAGED_PREFIX}${hashBody(body)} - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->\n${body}`

/** The host's path aliases, re-rooted one level down for design/tsconfig.json.
 *  "./src/*" becomes "../src/*" so `@/` imports resolve from inside design/. */
function designPaths(root: string): string {
  const hostPaths = readJson(join(root, 'tsconfig.json'))?.compilerOptions?.paths
  if (!hostPaths || typeof hostPaths !== 'object') return ''
  const rerooted: Record<string, string[]> = {}
  for (const [alias, targets] of Object.entries(hostPaths)) {
    if (!Array.isArray(targets)) continue
    rerooted[alias] = targets.map((t) =>
      typeof t === 'string' ? (t.startsWith('./') ? `../${t.slice(2)}` : `../${t}`) : t)
  }
  if (!Object.keys(rerooted).length) return ''
  return `,\n    // the host's aliases, re-rooted (inherited paths resolve against the WRONG dir)\n    "paths": ${JSON.stringify(rerooted)}`
}

/** No framework, no theme, no component alias = nothing to build frames FROM. */
const noApp = (host: HostInfo) =>
  !host.router && !host.tailwind && !host.shadcn && !host.themeCss

/** The UI line of AGENTS.md, matched to what detection actually found (friction log #1).
 *  The STOP branch fires only on the same condition that creates SETUP.md - an app
 *  without Tailwind (plain React + CSS) gets guidance, never a dead pointer. */
function uiGuidance(host: HostInfo, isNoApp: boolean): string {
  if (isNoApp)
    return `Setup required - this repo has no app yet: read design/instructions/setup.md and follow it before designing anything.`
  if (host.shadcn)
    return `Use the app's UI: import from ${host.shadcn.uiAlias}; style with the app's Tailwind classes.`
  if (host.tailwind)
    return `Style with the app's Tailwind classes and design tokens; there is no detected component library - extract shared pieces into design/components/.`
  return `Use the app's existing components and stylesheets (import them directly); there is no Tailwind or component library detected - extract shared pieces into design/components/.`
}

// The hosted onboarding canvas: handed to the human the moment the plan is
// agreed, explored while the agent builds. Standing this up (content + stable
// hosting) is a release blocker for any version that ships these templates.
const TOUR_URL = 'https://tour.marver.design'
const TOUR_PASSWORD = 'welcome'

const SETUP_MD = `# Setup required - this repo has no app yet

> This file exists because \`${NAME} init\` ran in a repo with no framework, no theme
> CSS, and no component library. It disappears automatically: set up the app, re-run
> \`npx ${NAME} init\`, and init deletes this file and regenerates AGENTS.md against
> the real stack. While this file exists, DO NOT design.

${NAME} builds frames from YOUR components and YOUR theme. With none, frames become
hand-rolled CSS that shares nothing with the future app - throwaway work. So the
first session sets up the stack - TOGETHER with the human. The stack is their
decision; your job is a good recommendation and a smooth setup. Narrate every step
in one plain line as you go - and tell the story, not the machinery: this file is
stage directions, never read it aloud to the human ("setup.md says...", "step 2
requires..."). Voice rules and the structured-question guidance live in
instructions/welcome.md - read that section before you say anything.

## 1. Greet and explain

Tell the human the repo is empty and that this is a perfect starting point. Then
the pitch, ~4 sentences in your own words (source: instructions/welcome.md): we design
in real code; the theme, components, and screens made while designing ARE the
app's building blocks; by the time the design is agreed most of the UI work
exists, and building the product means plugging functionality in; the goal is
alignment on look and feel across themes and devices first.

## 2. Ask what they are building - STOP

Two questions, one message (use the harness's structured question tool if it
has one):

1. "In a sentence or two - what are we building?"
2. "Any intuition for the look? Colors, mood, UI style - a sentence like
   'minimalist, glass UI, witty copy' steers everything. 'Surprise me' is a
   fine answer."

Then STOP: no further tool calls, end your turn, resume only after the human
replies. (The one exception: the human explicitly asked for unattended
execution - then assume something reasonable, mark it UNCONFIRMED, surface it
first.)

## 3. Propose the stack - STOP

From their answer, recommend a framework with one line of reasoning each:

- Marketing site, content, SEO -> latest Next.js.
- App-like, interactive, client-heavy -> latest React Router.
- Their answer points somewhere else? Recommend that instead, and say why.

If you can search the web, verify current major versions first - one or two
searches, then propose. Recommend shadcn/ui + latest Tailwind as the default
component layer (take their current defaults) - but they are a recommendation,
not a requirement: if the human prefers another component library, plain CSS,
or their own design system, that wins. Any React + a real stylesheet works;
${NAME} adapts to what detection finds.

Ask the FORK in the same message - it decides everything after the scaffold,
so it belongs here, before any tunnel. Two questions through the harness's
structured question tool when it has one (short labels, one-line trade-offs):

1. The stack - closing with "aligned, or tell me what you'd rather use".
2. How do you want to start?
   - **Think it through together first** - we co-develop the idea, the
     workflow, the specs, and the mood/inspiration on the canvas before any
     pixels. What goes on each screen, what stays out, what the intent is.
   - **Build me something to react to** - I go heads-down and come back with
     a first draft of ~4 screens you can play with, and we iterate from there.

Works for any kind of product - a marketing site co-thinks its story and
inspiration the same way an app co-thinks its workflow. Then STOP: no further
tool calls, end your turn, wait for both answers.

## 4. Hand them the tour, then scaffold

The setup and first draft take real minutes; the human should spend them
learning the canvas, not watching a terminal. The moment the stack is agreed,
send them to the ${NAME} tour - a published canvas we host, built to be
explored: ${TOUR_URL} - password \`${TOUR_PASSWORD}\`. Tell them it teaches
selection, devices, themes, variants, and play mode from inside the canvas,
and that it ends by sending them back to check on you. (Unreachable from this
machine? Say so and skip it - never stall on it.) Then get to work.

NOTE: scaffolders refuse non-empty directories (this repo already holds design/
and a package.json - the one you likely created with \`npm init -y\` to install
${NAME} into), so scaffold into a temp dir and merge. The Next.js lane - adapt
the same shape to whatever stack was agreed:

\`\`\`bash
npx create-next-app@latest app-scaffold --ts --tailwind --app --src-dir --yes
# move everything from app-scaffold/ up to the repo root EXCEPT its package.json;
# merge app-scaffold/package.json's dependencies+scripts into the existing one,
# then: rm -rf app-scaffold && npm install
npx shadcn@latest init
\`\`\`

Scaffolder flags drift between versions (create-next-app and shadcn both) - if
a flag errors or a prompt appears despite --yes, accept the tool's defaults.

Known scaffold bug if shadcn was agreed (hit on every create-next-app + shadcn
run so far): shadcn's
init rewrites the theme CSS's \`@theme inline\` block and leaves
\`--font-sans: var(--font-sans)\` - self-referential, resolves to nothing, and
the app silently renders in the browser's default font. After shadcn init,
open the theme CSS and bind every font token to a variable that actually
exists (e.g. \`--font-sans: var(--font-geist-sans)\` under Next); check
--font-heading and friends for the same circularity.

Then START the dev server and
confirm the starter page renders before moving on. Unsure about the stack's
conventions? Fetch its docs.

## 5. Re-run init

\`\`\`bash
npx ${NAME} init
\`\`\`

init is idempotent: it detects the real stack, deletes this file, and
regenerates AGENTS.md against reality. Verify the wiring (instructions/
configure.md): frames render styled, one app component imports cleanly.
DESIGN.md comes next, as part of the first draft.


## 6. The path they chose at the fork

**Chose "think it together"?** No tunnel - the canvas becomes the shared
thinking surface (instructions/shape.md is the guide). Start
\`npx ${NAME} dev\`, then seed a feature-story board from what step 2 taught
you: an intent content frame with their answer restated as problem/goal/
non-goals, a first-guess workflow diagram (mermaid - your draft of THEIR flow,
made to be corrected), and a mood frame - fetch real inspiration and brand
references when you can search (craft.md "Real assets"). Reveal it EARLY with
the board deep link and iterate together: what belongs on each screen, what
stays out, what the intent of each step is. Wireframes and the hi-fi draft
come after the story is agreed - and by then the brief writes itself. Delete
the generic demo scene once your frames are in.

**Chose "build me something"?** The impressive first draft, below.

## The first draft - make it impressive, then tour

This is the human's first impression of the canvas AND the first draft of their
product - it sets the direction. Take the time to do it well:

- If you can search the web, spend a few minutes understanding the domain from
  step 2's answer; write design/DESIGN.md. The human's look intuition from
  step 2 is the north star - honor it literally. If they said "surprise me",
  commit to a direction and name it in one sentence at the reveal.
- Build ~4 frames of THEIR product - not lorem, not filler. Hold them to the
  craft bar: instructions/craft.md and instructions/reference/slop.md are
  binding here. Responsive, working in BOTH themes, linked with data-goto so
  play mode flows.
- UNDERWHELMING IS THE FAILURE MODE. A restrained concept executed thinly
  reads as a wireframe, however careful the type. Every frame needs presence -
  scale, contrast, color, one real visual moment - and the human should feel
  the direction before they read a word. Write the copy like it ships:
  specific, confident, witty where the brand allows, never placeholder. This
  first draft is the product's first impression AND ${NAME}'s - go above and
  beyond.
- Delete the generic demo scene (design/scenes/demo/) once your frames are in -
  it exists to show YOU the file shapes, not to impress anyone.
- Create a curated board for them (instructions/boards.md) containing every
  frame the flow visits.
- Offer a divergence: "want a variant of <frame> exploring a different
  direction?" - one a-/b- pair teaches the variant workflow better than any
  explanation.

This first draft skips the written-brief ceremony (the human just told you what
they are building) but never the quality bar. Then THE REVEAL: start
\`npx ${NAME} dev\` and give the guided tour from instructions/welcome.md -
by now the human has played with the hosted tour, so keep it short and let
their own product carry it. End with the deep link using the PRINTED port -
\`http://localhost:<port>/#/b/<board>\`, never the bare root URL.
`

/** Next.js frames render OUTSIDE Next - say concretely what that means (friction log #10/#11). */
const NEXT_NOTES = `- Next.js caveats (frames render in Vite, outside Next):
  next/font does not exist here - CSS variables it injects (e.g. --font-geist-sans) are
  undefined in frames, so give every font token a real fallback chain in the app's CSS:
  --font-sans: var(--font-geist-sans, ui-sans-serif, system-ui, sans-serif).
  next/image and next/link render as plain img/a via shims at best - prefer <img> and
  data-goto in frames. Server Components and server actions cannot run: frames are
  client components importing client components.
`

const STANDALONE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["."]
}
`

function patchTsconfigExclude(root: string) {
  const file = join(root, 'tsconfig.json')
  if (!existsSync(file)) return
  const raw = readFileSync(file, 'utf8')
  try {
    // Surgical string edit to preserve host formatting/comments as much as possible.
    let next: string
    if (/"exclude"\s*:/.test(raw)) {
      next = raw.replace(/("exclude"\s*:\s*\[)/, '$1"design", ')
    } else {
      const at = firstJsonBrace(raw)   // never a brace inside a leading comment
      if (at < 0) throw new Error('no object brace found')
      next = raw.slice(0, at + 1) + '\n  "exclude": ["design"],' + raw.slice(at + 1)
    }
    if (next === raw) throw new Error('no anchor matched')
    writeFileSync(file, next)
    console.log(`\n  patched tsconfig.json (the only host file touched):`)
    console.log(`    + "design" added to "exclude"  (revert this line to fully uninstall)`)
  } catch {
    console.warn(`  could not patch tsconfig.json - add "design" to its "exclude" yourself.`)
  }
}

/** Index of the first `{` outside //, /* *\/ comments and strings (tsconfig is JSONC). */
function firstJsonBrace(src: string): number {
  let inLine = false, inBlock = false, inStr = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (inLine) { if (c === '\n') inLine = false; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++ }; continue }
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue }
    if (c === '/' && n === '/') { inLine = true; i++; continue }
    if (c === '/' && n === '*') { inBlock = true; i++; continue }
    if (c === '"') { inStr = true; continue }
    if (c === '{') return i
  }
  return -1
}

const configTemplate = (mode: string) => `// ${NAME} config - OPTIONAL. Delete this file and everything still works on defaults.
// Theme lives in design/theme.css (it imports your app's real stylesheet) - not here.
// Sharp edges (native Node TS import): erasable syntax only (no enums/namespaces),
// relative imports need extensions, tsconfig paths are ignored here.
export default {
  mode: ${JSON.stringify(mode)},
  // Device widths for frames and the Devices view. Rename, retune, or uncomment tv.
  viewports: {
    mobile: { width: 390, height: 844 },
    tablet: { width: 768, height: 1024 },
    laptop: { width: 1280, height: 800 },
    monitor: { width: 1920, height: 1080 },
    // tv: { width: 3840, height: 2160 },
  },
  themes: ["light", "dark"],
  port: ${DEFAULTS.port},
  // Canvas zoom feel: 1 = default, 1.2 = 20% faster, 0.8 = 20% slower.
  // zoomSpeed: 1,
  // Publishing (\`${NAME} build\` + \`${NAME} serve\`): gate identity + branding footer.
  // name/logo default to the host package.json name and design/logo.svg (then public/).
  // branding is the small "Powered by Marver.design" line under the gate. Marver is
  // free, and that line is how it spreads - we'd love it if you leave it on, but it
  // is yours to remove, no strings: share: { branding: false }.
  // share: { name: "My App", logo: "design/logo.svg", branding: true },
}
`

const themeWrapper = (relCss: string, v4: boolean) => `/* ${NAME} theme wrapper - imports the app's real theme; the app's own build never sees design/. */
@import "${relCss}";
${v4 ? `@source "./";\n` : ''}`

function providersTemplate(router: string | null, toaster: string | null, routerPkg = 'react-router-dom'): string {
  const imports: string[] = [`import type { ReactNode } from 'react'`]
  let open = '', close = ''
  if (router === 'react-router') {
    imports.push(`import { MemoryRouter } from '${routerPkg}'`)
    open += '<MemoryRouter>'; close = '</MemoryRouter>' + close
  }
  let toasterEl = ''
  if (toaster === 'sonner') { imports.push(`import { Toaster } from 'sonner'`); toasterEl = '<Toaster />' }
  if (toaster === 'react-hot-toast') { imports.push(`import { Toaster } from 'react-hot-toast'`); toasterEl = '<Toaster />' }
  return `// Mock contexts wrapped around every frame. Scaffolded by ${NAME} init from what it detected - yours to edit.
${imports.join('\n')}

export default function Providers({ children }: { children: ReactNode }) {
  return (
    ${open || '<>'}
      {children}
      ${toasterEl}
    ${close || '</>'}
  )
}
`
}
