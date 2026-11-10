/**
 * Spec 32 H2.5 / G4b: the compact-tab proof, on the page harness's proof route (test/pw/proof-compact.test.ts shoots
 * it at 1280 and 720 wide, light and dark, 1x and 2x). Twelve tabs in three strips: a canvas tab active with another
 * hovered (its ⌘N showing), Home on with a tab hovered, and a hover on the "99+" badge. The widths are A3's and A4's
 * arithmetic, worked once per render with no fit() (the strip page's is W1's); `.compact` exactly under 104 px. The
 * logos go through dom.ts's real `logo()` options form (E4's trim) and the marks through the strip's `markSlot`.
 */
import type { TabView } from '../../src/shared/channels.ts'
import { h, icon, logo, setLook, shown, trimLogo } from '../../src/pages/dom.ts'
import { frame } from '../../src/pages/menu.ts'
import { markSlot } from '../../pages/strip/needs.ts'

const GAP = 4, MIN = 84, COMPACT = 104, SHARE_MAX = 176, ACTIVE_MAX = 260

type Tab = { name: string; needs?: number; unseen?: number; key?: number; logo?: string; hue?: number }

/** A PNG data URL drawn on a canvas (the proof's synthetic logos: no third-party mark is committed). */
function png(w: number, hgt: number, draw: (g: CanvasRenderingContext2D) => void): string {
  const c = document.createElement('canvas')
  c.width = w; c.height = hgt
  draw(c.getContext('2d')!)
  return c.toDataURL('image/png')
}

/** The app mark as a data URL (a full-bleed app icon), drawn from pages/shared/app-mark.png. */
async function appIcon(): Promise<string> {
  const img = new Image()
  img.src = 'app-mark.png'
  await img.decode()
  return png(256, 256, (g) => g.drawImage(img, 0, 0))
}

async function tabs(): Promise<Tab[]> {
  const mark = png(128, 128, (g) => { g.fillStyle = '#2b6cb0'; g.beginPath(); g.arc(64, 64, 26, 0, Math.PI * 2); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(64, 64, 10, 0, Math.PI * 2); g.fill() })
  const favicon = png(64, 64, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#c53030'; g.beginPath(); g.moveTo(32, 10); g.lineTo(54, 52); g.lineTo(10, 52); g.closePath(); g.fill() })
  const wide = png(300, 100, (g) => { g.fillStyle = '#2f855a'; g.font = 'bold 80px -apple-system, sans-serif'; g.fillText('wide', 40, 82) })
  return [
    { name: 'Marver Platform', needs: 120, key: 1, logo: await appIcon() },
    { name: 'TMS broker', unseen: 3, key: 2, hue: 4 },
    { name: 'Tidewell launch deck review', needs: 3, key: 3, logo: mark },
    { name: 'Hertz dealer', key: 4, hue: 7 },
    { name: 'Gen lab', unseen: 1, key: 5, logo: favicon },
    { name: 'Asteria notes', key: 6, hue: 1 },
    { name: 'Field study', needs: 6, key: 7, logo: wide },
    { name: 'Pricing page', key: 8, hue: 9 },
    { name: 'Onboarding flow', unseen: 2, hue: 3 },
    { name: 'Brand refresh', hue: 11 },
    { name: 'Weekly review', needs: 12, hue: 5 },
    { name: 'Studio site', key: 9, hue: 2 },
  ]
}

type Row = { label: string; active: number | null; hov: number }
const ROWS: Row[] = [
  { label: 'A canvas tab active (its name fits up to 260 px); another hovered shows its key', active: 2, hov: 4 },
  { label: 'Home on: no marks, until a hover brings the key back', active: null, hov: 1 },
  { label: 'A hover on the 99+ badge: the badge gives way to ⌘1', active: 2, hov: 0 },
]

function tabEl(t: Tab, i: number, row: Row): HTMLElement {
  const view = { name: t.name, logo: t.logo, hue: t.hue }
  const m = markSlot(t.needs || t.unseen ? { needs: t.needs ?? 0, unseen: t.unseen ?? 0 } as TabView['marks'] : undefined)
  const end = h('span', { class: 'end' },
    m ? h('span', { class: m.cls }, 'text' in m ? m.text : '') : null,
    t.key ? h('kbd', { class: 'key' }, `⌘${t.key}`) : null)
  const face = h('span', { class: 'face' }, h('span', { class: 'slot' }, logo(view, 24, { round: true, plate: 0.91 })), h('span', { class: 'name' }, t.name), end)
  return h('div', { class: `tab${row.active === i ? ' on' : ''}${row.hov === i ? ' hov' : ''}`, role: 'tab', 'data-i': String(i) }, face)
}

/** A3 and A4 over one strip: which tabs stay, `--tw`, `--aw` and `.compact`. */
function lay(strip: HTMLElement, list: HTMLElement[], row: Row): void {
  const tabsEl = strip.querySelector<HTMLElement>('.tabs')!
  const home = tabsEl.querySelector<HTMLElement>('.home')!
  const more = strip.querySelector<HTMLElement>('.more')!
  const n = list.length
  let W = tabsEl.clientWidth
  let shownList = list
  if (n * MIN + (n - 1) * GAP > W - home.offsetWidth - 10) {
    more.hidden = false
    W = tabsEl.clientWidth
    const room = W - (home.offsetWidth + 10)
    const m = Math.max(1, Math.floor((room + GAP) / (MIN + GAP)))
    if (row.active === null) shownList = list.slice(0, m)
    else {
      const others = list.filter((_, i) => i !== row.active).slice(0, m - 1)
      shownList = list.filter((el, i) => i === row.active || others.includes(el))
    }
    for (const el of list) el.hidden = !shownList.includes(el)
    fill(more, shownList.length, n)
  }
  const k = shownList.length
  const room = W - (home.offsetWidth + 10) - GAP * (k - 1)
  const share = Math.min(SHARE_MAX, Math.max(MIN, room / k))
  const on = row.active === null ? null : list[row.active]
  let aw = share
  if (on) {
    on.classList.remove('compact')
    const was = on.style.width
    on.style.width = 'max-content'
    const natural = Math.ceil(on.getBoundingClientRect().width) + 1
    on.style.width = was
    void on.offsetWidth
    if (natural > share) aw = Math.min(ACTIVE_MAX, natural, room - (k - 1) * MIN)
  }
  const tw = k > 1 ? Math.min(SHARE_MAX, Math.max(MIN, (room - aw) / (k - 1))) : share
  tabsEl.style.setProperty('--tw', `${tw}px`)
  tabsEl.style.setProperty('--aw', `${Math.max(aw, tw)}px`)
  for (const el of shownList) el.classList.toggle('compact', el === on ? Math.max(aw, tw) < COMPACT : tw < COMPACT)
}

function fill(more: HTMLElement, shownCount: number, n: number): void {
  const hidden = n - shownCount
  more.replaceChildren('»', h('small', {}, String(hidden)))
  more.setAttribute('aria-label', `${hidden} more canvases`)
}

let data: Tab[] = []

/** Draws the three strips for the window's width; resolves once every logo's trim has landed. */
async function render(): Promise<void> {
  const rows = document.getElementById('rows')!
  rows.replaceChildren()
  for (const row of ROWS) {
    const list = data.map((t, i) => tabEl(t, i, row))
    const home = h('button', { class: `home${row.active === null ? ' on' : ''}`, type: 'button', title: 'Home ⌘T' }, icon('house', 15))
    const strip = h('div', { class: `strip${row.active === null ? ' home-on' : ''}` },
      h('div', { class: 'lights' }, h('i'), h('i'), h('i')),
      h('div', { class: 'tabs', role: 'tablist' }, home, ...list),
      h('button', { class: 'more', type: 'button', hidden: true, 'aria-haspopup': 'menu' }))
    rows.append(h('div', { class: 'label' }, row.label), strip)
    lay(strip, list, row)
  }
  await Promise.all(data.filter((t) => t.logo).map((t) => trimLogo(t.logo!)))
  await frame()
  await frame()
}

/** What the test checks: each shown tab's width, compactness and its children's places inside its face. */
function geometry() {
  return [...document.querySelectorAll<HTMLElement>('.strip')].map((strip) => ({
    more: strip.querySelector<HTMLElement>('.more')!.hidden ? null : strip.querySelector('.more small')!.textContent,
    tabs: [...strip.querySelectorAll<HTMLElement>('.tab:not([hidden])')].map((t) => {
      const face = t.querySelector<HTMLElement>('.face')!
      const f = face.getBoundingClientRect()
      const cs = getComputedStyle(face)
      const box = { left: f.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), right: f.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) }
      const kids = [...face.querySelectorAll<HTMLElement>('.slot, .name, .end, .end > *')].filter((k) => getComputedStyle(k).display !== 'none' && k.getBoundingClientRect().width > 0)
      const slot = t.querySelector('.slot')!.getBoundingClientRect()
      const badge = t.querySelector<HTMLElement>('.end .mk.ask')
      return {
        i: Number(t.dataset.i), on: t.classList.contains('on'), width: t.getBoundingClientRect().width, compact: t.classList.contains('compact'),
        nameShown: getComputedStyle(t.querySelector('.name')!).display !== 'none',
        logoLeft: slot.left - f.left,
        badgeRight: badge && getComputedStyle(badge).display !== 'none' && getComputedStyle(badge).opacity !== '0' && getComputedStyle(t.querySelector('.end')!).display !== 'none' ? f.right - badge.getBoundingClientRect().right : null,
        inside: kids.every((k) => { const r = k.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 }),
      }
    }),
  }))
}

;(window as unknown as { proof: unknown }).proof = {
  render, geometry,
  look: async (dark: boolean) => { setLook(dark); await frame(); await frame() },
}
void (async () => {
  data = await tabs()
  setLook(false)
  await render()
  shown()
  document.body.dataset.ready = '1'
})()
