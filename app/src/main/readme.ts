/**
 * The app-owned files of `~/.marver/` (spec 28 A2.7, A2.12): `README.md`, for people and agents, and `schemas/`,
 * for editors' hints - both generated from the key table (src/shared/settings-keys.ts), so neither can drift from
 * the validator. Pure: config.ts writes them.
 *
 * Each carries the version that wrote it and a hash of the rest, so a file cut short repairs itself at the next
 * launch: `README.md` starts `<!-- marver-app <version> sha256:<hex of every byte after this line> -->`; each schema
 * has `"$comment": "marver-app <version> sha256:<hex of the schema without $comment, JSON 2-space>"`. A release build
 * rewrites any file that is not byte-equal to its own render; a Marver Dev build only one missing or not whole, so it
 * never downgrades the release's (A2.14 #23).
 */
import { createHash } from 'node:crypto'
import { defaultWords, KEYS, schemaOf, STAGE_VERSION, typeWords, type FileName, type KeySpec } from '../shared/settings-keys.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function keyTable(file: FileName): string {
  const rows = (Object.entries(KEYS[file]) as [string, KeySpec][]).map(([k, s]) =>
    `| \`${k}\` | ${typeWords(s)} | ${defaultWords(s)} | ${STAGE_VERSION[s.since]} | ${s.does} |`)
  return ['| Key | Value | Default | Used from app | What it does |', '|---|---|---|---|---|', ...rows].join('\n')
}

function body(): string {
  return `# ~/.marver - the Marver app's folder

The Marver Mac app keeps its settings and its state here, beside the files \`marver dev\` keeps. **The app writes this
README at every launch: edits here are lost.** \`MARVER_HOME\` moves the whole folder.

## Rules for agents

1. Change settings only in \`config.json\` and \`theme.json\`. Write nothing else in this folder.
2. Strict JSON: one object, no comments, no trailing commas. Every key is optional: an absent file, or an absent
   key, is the default. Keep the \`"$schema"\` line the app writes; it is the only key that is not a setting.
3. Write the whole file: write a temp file in this folder, then rename it over the old one.
4. After an edit, read \`state/status.json\` (\`state-dev/status.json\` for the development build): the edit applied
   when \`files["config.json"].sha256\` (or \`files["theme.json"]\`) is the sha256 of the bytes you wrote and its \`ok\`
   is \`true\`. Otherwise \`problems\` says why, and \`applied\` holds the values still in force.
5. A file with a wrong value or an unknown key does not apply at all: the app keeps the last good file, whole, and
   says so in its window. Fix the file; it applies the moment it is right.
6. Never write \`state/\`, \`state-dev/\`, \`running/\` or \`prefer/\`. Never read, print or copy \`canvases/\` (collaboration
   credentials) or a \`running/\` file's \`key\`.
7. List the running canvases with \`npx marver ls --json\`, never by reading \`running/\`.
8. No key can relax a security rule.

## Files

| Path | Whose | What it is |
|---|---|---|
| \`README.md\` | the app | This file. |
| \`config.json\` | yours | The app's settings (below). The app creates it with its \`$schema\` line on the first change from Settings. |
| \`theme.json\` | yours | The app's appearance (below). |
| \`schemas/\` | the app | JSON Schemas of \`config.json\` and \`theme.json\`, for editors. |
| \`state/\` | the app | \`status.json\` (what applied, what failed), \`tabs.json\`, \`window.json\`, \`recent.json\`, \`launched\`; a file that failed its check is kept as \`<name>.bad\`. |
| \`state-dev/\` | the app | The same, for the app's development build. |
| \`perf/\` | the app | Crash reports (\`perf/crashpad/\`); from app 0.2 the recorder's \`app.jsonl\` (the development build's: \`app-dev.jsonl\`; main's uncaught errors go there too, as \`main-error\` lines, whatever the recorder setting), the machine profiles (\`machine/\`) and the flashes' pictures (\`flashes/\`: the app's views, not the screen). Read them with \`npx marver perf --crashes\`, \`--flashes\`, \`--machine\`; kept \`keepPerfDays\` (a headless run's machine profile at least 14 days, as long as a repo's \`runs.jsonl\` may name it). |
| \`running/\`, \`prefer/\` | \`marver dev\` | The canvases running now, and the address each prefers. |
| \`canvases/\`, \`models/\` | \`marver\` | Collaboration credentials and local models. Never read, print or copy them. |

## config.json

${keyTable('config')}

## theme.json

${keyTable('theme')}

## Recipes

- A dark app: \`theme.json\` \`{ "mode": "dark" }\`. Canvases keep their own theme; frames that follow the system's
  colour scheme follow this.
- Start on Home at every launch: \`config.json\` \`{ "restoreTabs": false }\`.
- Keep hidden tabs loaded (from app 0.2): \`config.json\` \`{ "unloadUnderPressure": false }\`. An unloaded tab
  reopens on its board and camera; its page's undo, Back and Forward, and a selection its link does not name, do not
  come back.
- Start fresh: delete the file. Absent is the defaults.
`
}

export function renderReadme(version: string): string {
  const rest = body()
  return `<!-- marver-app ${version} sha256:${sha(rest)} -->\n${rest}`
}

const schemaText = (schema: Record<string, unknown>) => JSON.stringify(schema, null, 2)

/** `[path under the home, exact bytes]` for each schema. */
export function renderSchemas(version: string): [string, string][] {
  return (['config', 'theme'] as const).map((f) => {
    const s = schemaOf(f)
    const comment = `marver-app ${version} sha256:${sha(schemaText(s))}`
    return [`schemas/${f}.schema.json`, schemaText({ $comment: comment, ...s }) + '\n']
  })
}

/** Every app-owned file of the home: README.md, then the schemas. */
export function renderOwned(version: string): [string, string][] {
  return [['README.md', renderReadme(version)], ...renderSchemas(version)]
}

const README_HEAD = /^<!-- marver-app (\S+) sha256:([0-9a-f]{64}) -->\n/

/** The version a file says wrote it, when it is whole: its hash matches the rest. Else null. */
export function wholeVersion(name: string, text: string): string | null {
  if (name === 'README.md') {
    const m = README_HEAD.exec(text)
    return m && sha(text.slice(m[0].length)) === m[2] ? m[1] : null
  }
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    if (!o || typeof o !== 'object' || typeof o.$comment !== 'string') return null
    const m = /^marver-app (\S+) sha256:([0-9a-f]{64})$/.exec(o.$comment)
    if (!m) return null
    const { $comment: _, ...rest } = o
    return sha(schemaText(rest)) === m[2] ? m[1] : null
  } catch { return null }
}

export const isWhole = (name: string, text: string): boolean => wholeVersion(name, text) !== null
