// Electron main script for scripts/icon.mjs: renders an SVG into a macOS iconset at exact pixel sizes.
// argv: <svg> <iconset dir> <temporary profile dir>. Runs on its own profile, shows no window, quits when done.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [svgPath, outDir, profile] = process.argv.slice(-3)
app.setPath('userData', profile)
if (process.platform === 'darwin') app.dock?.hide()

// iconutil's names: icon_<n>x<n>.png and icon_<n>x<n>@2x.png for n in 16, 32, 128, 256, 512
const SIZES = [16, 32, 128, 256, 512].flatMap((n) => [[`icon_${n}x${n}.png`, n], [`icon_${n}x${n}@2x.png`, n * 2]])

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(outDir, { recursive: true })
    const svg = fs.readFileSync(svgPath)
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } })
    await win.loadURL('data:text/html,<!doctype html><title>icon</title>')
    for (const [name, px] of SIZES) {
      const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = ${px}; c.height = ${px}
          const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'
          g.drawImage(img, 0, 0, ${px}, ${px}); resolve(c.toDataURL('image/png'))
        }
        img.onerror = () => reject(new Error('the SVG did not load'))
        img.src = 'data:image/svg+xml;base64,${svg.toString('base64')}'
      })`)
      fs.writeFileSync(path.join(outDir, name), Buffer.from(dataUrl.split(',')[1], 'base64'))
    }
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
