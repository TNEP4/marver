// Loaded into the dev build's main process with NODE_OPTIONS=--require (test/prod/quit.test.ts): an uncaught
// exception or rejection in main is written to MVAPP_UNCAUGHT instead of Electron's modal error box, which would
// block main on the screen. Says it loaded, so a case knows it is not blind.
const fs = require('node:fs')
const out = process.env.MVAPP_UNCAUGHT
const say = (s) => { try { if (out) fs.appendFileSync(out, s + '\n') } catch { /* nowhere to say it */ } }
say(`loaded ${process.type}`)
process.on('uncaughtException', (e) => say(`uncaught: ${(e && e.stack) || e}`))
process.on('unhandledRejection', (e) => say(`rejection: ${(e && e.stack) || e}`))
