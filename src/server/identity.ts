/**
 * One identity resolver (spec 31 G.1): what a canvas is called, and which logo it wears - here, and nowhere else.
 *
 * - local name (`marver dev`: the app's tab and Home card through the slot file, the sidebar, the manifest's project):
 *   config `name` > `share.name` > the folder's name - today's runtime rule, with `name` on top.
 * - published name (`marver build`'s meta.json: the gate's title, the sign-in screens): config `name` > `share.name` >
 *   package.json `name` > the folder's - today's build rule, with `name` on top.
 * - logo: config `logo` > `share.logo` > logo.ts's ladder (`findLogo`).
 *
 * `share.*` keeps working and nothing is rewritten: a canvas that sets neither `name` nor `logo` resolves exactly as it
 * did before.
 */
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ShConfig } from './config.ts'
import { findLogo, type OwnLogo } from './logo.ts'

export interface CanvasIdentity {
  /** the name `marver dev` shows */
  local: string
  /** the name a published canvas shows */
  published: string
  /** where the local name came from: the folder's is the one the boot line nudges about */
  nameFrom: 'name' | 'share.name' | 'folder'
  /** the logos the config names, in order, for `findLogo` / `publishLogo` / `logoRoute` */
  logos: OwnLogo[]
}

type IdentityConfig = Pick<ShConfig, 'name' | 'logo'> & { share: Pick<ShConfig['share'], 'name' | 'logo'> }

/** The host package.json's `name`, when it has one. */
function packageName(root: string): string | undefined {
  try {
    const n = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
    return typeof n === 'string' && n ? n : undefined
  } catch { return undefined }
}

export function canvasIdentity(root: string, config: IdentityConfig): CanvasIdentity {
  const own = config.name || config.share.name
  const folder = basename(root)
  const pkg = own ? undefined : packageName(root)
  return {
    local: own || folder,
    published: own || pkg || folder,
    nameFrom: config.name ? 'name' : config.share.name ? 'share.name' : 'folder',
    logos: [{ key: 'logo', path: config.logo }, { key: 'share.logo', path: config.share.logo }],
  }
}

/** `marver dev`'s boot-line note (spec 31 G.2): what still makes this canvas look like any other in the app - its
 *  folder's name, the Marver mark - and the one place each is set. Null when it has both a name and a logo. */
export function identityNudge(root: string, config: IdentityConfig): string | null {
  const id = canvasIdentity(root, config)
  const folder = id.nameFrom === 'folder'
  const mark = !findLogo(root, id.logos)
  if (!folder && !mark) return null
  const what = folder && mark ? `its folder's name ("${id.local}") and the Marver mark` : folder ? `its folder's name ("${id.local}")` : 'the Marver mark'
  const fix = [folder ? 'name: "Your Product" in design/config.ts' : '', mark ? "your product's logo at design/logo.svg" : ''].filter(Boolean).join(' and ')
  return `this canvas still shows ${what} - give it ${fix}`
}
