import { writeFileSync } from 'node:fs'
import { Browser } from '../../test/browser.ts'
const [origin = 'http://localhost:5250', board = 'shipper-high-fi', q = 'awake=1', css = '', tag = 'x'] = process.argv.slice(2)
const b = (await Browser.launch())!
const s = await b.tab()
await b.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, s)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
await b.go(s, `${origin}/?${q}#/b/${board}`)
await b.until(s, `(() => { const st = window.__mvStore?.getState(); return !!st && st.nodes.length > 0 && st.nodes.every((n) => n.status === 'ready') })()`, 90_000)
await wait(3500)
if (css.startsWith('js:')) await b.eval(s, css.slice(3))
else if (css) await b.eval(s, `(() => { const st = document.createElement('style'); st.textContent = ${JSON.stringify(css)}; document.head.appendChild(st); return 1 })()`)
const shot = async (name: string) => { const d = Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' }, s)).data, 'base64'); writeFileSync(`research/hifi/out/settle-${tag}-${name}.png`, d); console.log(name, d.length) }
await shot('fit')
for (let i = 0; i < 40; i++) { await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 620, y: 470, deltaX: 0, deltaY: -60, modifiers: 2 }, s); await wait(25) }
const t0 = Date.now()
for (const ms of [2500, 6000, 12000]) { await wait(ms - (Date.now() - t0) > 0 ? ms - (Date.now() - t0) : 0); await shot(`z40-${ms}`) }
console.log(await b.eval(s, `getComputedStyle(document.querySelector('.sh-canvas'), '::before').getPropertyValue('--sh-s')`))
b.close()
