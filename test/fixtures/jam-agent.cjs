// A fake jam agent for the queue tests: it reads the packet file the prompt names, answers every
// member the way MODE says (by card id or member id; default "ok"), and prints a claude-style
// envelope. OPTS: { delay, touch (a file to change), fail (exit 1), hang }.
const fs = require('fs'), path = require('path')
const file = process.argv[2]
const p = JSON.parse(fs.readFileSync(file, 'utf8'))
const mode = JSON.parse(process.env.MODE || '"ok"')
const opts = JSON.parse(process.env.OPTS || '{}')
fs.appendFileSync('packets-seen.jsonl', JSON.stringify(p) + '\n')
// the orphan was killed before this run started; the system may take a moment to clear it (a killed child of the test
// process stays a zombie until reaped): alive only if it is still there, and not a zombie, a second on
if (opts.orphan) {
  const there = () => { try { process.kill(opts.orphan, 0) } catch { return false } try { const st = require('child_process').execFileSync('ps', ['-o', 'stat=', '-p', String(opts.orphan)]).toString().trim(); return !!st && !st.startsWith('Z') } catch { return false } }
  const until = Date.now() + 1000
  let alive = there()
  while (alive && Date.now() < until) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); alive = there() }
  fs.writeFileSync('orphan.txt', alive ? 'alive' : 'dead')
}
for (const t of [].concat(opts.touch || [])) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, 'x' + Date.now() + Math.random()) }
if (opts.fail) process.exit(1)
if (opts.hang) setInterval(() => {}, 1000)
// a session record: the agent writes it where the content says, and nothing else
for (const m of p.members) if (m.brief.wrapup) {
  const c = m.brief.wrapup.content
  fs.mkdirSync(path.dirname(c.file), { recursive: true })
  fs.writeFileSync(c.file, '# Session record\n\n' + c.instructions + '\n\n' + c.captures.map((x) => '- ' + x.title + ' (' + x.state + ')').join('\n') + (c.more ? '\n\nMore: ' + c.more : '') + '\n')
}
const F = '```'
const out = p.members.map((m) => {
  const how = typeof mode === 'string' ? mode : (mode[m.card] || mode[m.id] || 'ok')
  if (how === 'missing') return ''
  if (how === 'shared') return F + 'marver-reply ' + m.id + ' shared design/scenes/demo/_kit.tsx\n' + F
  if (how === 'ask') return F + 'marver-reply ' + m.id + ' asks\nWhich one?\n' + F
  if (how === 'offer') return F + 'marver-reply ' + m.id + '\nDone - the header is blue. Want me to do the footer too?\n' + F
  return F + 'marver-reply ' + m.id + '\nDone: ' + m.brief.asks.map((a) => a.body).join(' + ') + '\n' + F
}).join('\n')
if (!opts.hang) setTimeout(() => process.stdout.write(JSON.stringify({ result: out })), opts.delay || 0)
