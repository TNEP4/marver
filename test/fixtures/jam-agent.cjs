// A fake jam agent for the queue tests: it reads the packet file the prompt names, answers every
// member the way MODE says (by card id or member id; default "ok"), and prints a claude-style
// envelope. OPTS: { delay, touch (a file to change), fail (exit 1), hang }.
const fs = require('fs'), path = require('path')
const file = process.argv[2]
const p = JSON.parse(fs.readFileSync(file, 'utf8'))
const mode = JSON.parse(process.env.MODE || '"ok"')
const opts = JSON.parse(process.env.OPTS || '{}')
fs.appendFileSync('packets-seen.jsonl', JSON.stringify(p) + '\n')
if (opts.touch) { fs.mkdirSync(path.dirname(opts.touch), { recursive: true }); fs.writeFileSync(opts.touch, 'x' + Date.now() + Math.random()) }
if (opts.fail) process.exit(1)
if (opts.hang) setInterval(() => {}, 1000)
const F = '```'
const out = p.members.map((m) => {
  const how = typeof mode === 'string' ? mode : (mode[m.card] || mode[m.id] || 'ok')
  if (how === 'missing') return ''
  if (how === 'shared') return F + 'marver-reply ' + m.id + ' shared design/scenes/demo/_kit.tsx\n' + F
  if (how === 'ask') return F + 'marver-reply ' + m.id + ' asks\nWhich one?\n' + F
  return F + 'marver-reply ' + m.id + '\nDone: ' + m.brief.asks.map((a) => a.body).join(' + ') + '\n' + F
}).join('\n')
if (!opts.hang) setTimeout(() => process.stdout.write(JSON.stringify({ result: out })), opts.delay || 0)
