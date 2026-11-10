/**
 * The shared pieces' harness bundle (spec 32 G4; test/pw/shared-pieces.test.ts, on the harness's proof route): the
 * real dom.ts and menu.ts, as a page bundles them, on `window.kit`, with a log of every menu callback. The fixtures
 * are drawn here (a canvas makes the logo images), never by the test as markup.
 */
import { ago, appMark, h, icon, ICON_NAMES, logo, setLook, shown, trimKey, trimLogo } from '../../src/pages/dom.ts'
import { frame, MENU_INSET, normalRows, openMenu, type MenuHandle, type MenuOptions, type MenuRow } from '../../src/pages/menu.ts'

type Entry = { on: 'pick'; id: string; via: string; keys?: string } | { on: 'close'; why: string } | { on: 'secondary'; el: string }
const log: Entry[] = []
let m: MenuHandle | null = null
let keepIds = new Set<string>()

/** Opens a menu in #layer whose callbacks land in `kit.log`; `keep` names rows whose pick keeps it open. */
function menu(o: Omit<MenuOptions, 'onPick' | 'onClose' | 'onSecondary'> & { keep?: string[]; secondary?: boolean; openerSel?: string }): void {
  m?.close()
  keepIds = new Set(o.keep ?? [])
  const opener = o.openerSel ? document.querySelector(o.openerSel) : null
  m = openMenu(document.getElementById('layer')!, {
    ...o,
    opener,
    onPick: (id, how) => { log.push({ on: 'pick', id, via: how.via, keys: how.keys }); return keepIds.has(id) ? 'keep' : undefined },
    onClose: (why) => { log.push({ on: 'close', why }) },
    onSecondary: o.secondary ? (el) => { log.push({ on: 'secondary', el: (el as HTMLElement).dataset.id ?? el.id }) } : undefined,
  })
}

/** n rows: `item-0` .. `item-(n-1)`, every third one disabled when `dim` */
const rowsOf = (n: number, dim = false): MenuRow[] => Array.from({ length: n }, (_, i) => ({ kind: 'item', id: `item-${i}`, label: `Row ${i}`, enabled: !dim || i % 3 !== 1 }))

/** A PNG data URL drawn by `draw` on a w x h canvas (transparent ground). */
function png(w: number, hgt: number, draw: (g: CanvasRenderingContext2D) => void): string {
  const c = document.createElement('canvas')
  c.width = w; c.height = hgt
  draw(c.getContext('2d')!)
  return c.toDataURL('image/png')
}
const svg = (body: string, attrs = 'width="64" height="64"'): string => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`)}`

/** The logo fixtures of H1's A8/E4 row. */
function fixtures(): Record<string, string> {
  return {
    // a mark in the middle of a wide transparent margin
    margin: png(128, 128, (g) => { g.fillStyle = '#2b6cb0'; g.beginPath(); g.arc(64, 64, 22, 0, Math.PI * 2); g.fill() }),
    // a favicon's own white square, a small red mark on it
    whiteSquare: png(64, 64, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#c53030'; g.fillRect(24, 20, 16, 24) }),
    // an SVG with an intrinsic size: a green circle with a margin
    svg: svg('<circle cx="32" cy="32" r="18" fill="#2f855a"/>'),
    // an app icon: an opaque squircle filling its box (full bleed)
    appIcon: png(128, 128, (g) => { g.fillStyle = '#4c51bf'; g.beginPath(); g.roundRect(2, 2, 124, 124, 28); g.fill() }),
    // clearly non-square (3:1): a 3:1 ink band with a transparent margin round it
    wide: png(300, 100, (g) => { g.fillStyle = '#d69e2e'; g.fillRect(30, 10, 240, 80) }),
    // 3:1 on a white ground: a small dark round mark on white (the kit's (1, 1) would read the transparent letterbox,
    // count the white band as ink and call the image cover)
    wideWhite: png(300, 100, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 100); g.fillStyle = '#1a202c'; g.beginPath(); g.arc(150, 50, 22, 0, Math.PI * 2); g.fill() }),
    // an SVG that taints the canvas (foreignObject), and one with a viewBox only (no intrinsic size)
    tainting: svg('<foreignObject width="64" height="64"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>'),
    viewBoxOnly: svg('<rect x="8" y="8" width="48" height="48" fill="#805ad5"/>', 'viewBox="0 0 64 64"'),
  }
}

/** The ink bbox of an image (alpha > 24 and not near-white: a trim keeps a white ground inside its square), at its own size. */
function inkBox(src: string): Promise<{ w: number; h: number; x0: number; y0: number; x1: number; y1: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 0, c.width, c.height).data
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (ink(d, (y * c.width + x) * 4)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
      resolve({ w: x1 - x0 + 1, h: y1 - y0 + 1, x0, y0, x1, y1, width: c.width, height: c.height })
    }
    img.onerror = () => reject(new Error('no image'))
    img.src = src
  })
}

const ink = (d: Uint8ClampedArray, i: number): boolean => d[i + 3] > 24 && !(d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235)

const kit = {
  log, ago, appMark, h, icon, ICON_NAMES, logo, setLook, trimKey, trimLogo, frame, normalRows, MENU_INSET, rowsOf, fixtures, inkBox,
  menu,
  get m() { return m },
  /** draws a logo into #fixture and returns it */
  draw(v: { name: string; logo?: string; hue?: number }, size: number, o?: Parameters<typeof logo>[2]): HTMLElement {
    const el = logo(v, size, o as never)
    document.getElementById('fixture')!.append(el)
    return el
  },
}
;(window as unknown as { kit: typeof kit }).kit = kit
setLook(false)
shown()
