/** Synthetic glass pages for the compiler tests (bake.test.ts) - served from memory, 600x400. */
export const PILL = 'position:absolute;left:100px;top:100px;width:240px;height:60px;border-radius:30px;background:rgba(255,255,255,.35);border:1px solid rgba(255,255,255,.5);font:600 18px/58px system-ui;text-align:center;color:#123'
const page = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:600px;height:400px;overflow:hidden}
  body{background:linear-gradient(135deg,#ff7a59 0%,#7b61ff 45%,#19c2a0 100%)}
  .glass{backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
  ${head}</style></head><body><div id="root">${body}</div></body></html>`

export const PAGES: Record<string, string> = {
  plain: page(`<div id="box" style="${PILL}">no glass here</div>`),
  glass: page(`<div id="pill" class="glass" style="${PILL}">Past due</div>`),
  nested: page(`<div id="panel" class="glass" style="position:absolute;left:60px;top:60px;width:400px;height:260px;border-radius:16px;background:rgba(0,0,0,.25)">
    <div id="pill" style="${PILL};backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)">inside the panel</div></div>`),
  later: page(`<div id="a" class="glass" style="${PILL}">first</div><div id="b" class="glass" style="${PILL};left:220px;top:130px">painted later, over the first</div>`),
  opacity: page(`<div id="pill" class="glass" style="${PILL};opacity:.5 !important">half there</div>`),
  // a backdrop that never settles: the compiler must refuse rather than certify a moving target
  restless: page(`<div id="pill" class="glass" style="${PILL}">restless</div><script>let h=0;(function tick(){document.body.style.background='linear-gradient(135deg,hsl('+(h++%360)+' 90% 60%),#7b61ff)';requestAnimationFrame(tick)})()</script>`),
  // a blend mode composes the element with what is behind it: a texture underneath is not the same picture
  blend: page(`<div id="pill" class="glass" style="${PILL};mix-blend-mode:multiply;background:rgba(255,200,120,.7)">multiplied</div>`),
  // the override's own style element moves an UNRELATED box, far from the glass: pixels inside the
  // glass certify, the geometry guard must still reject everything
  moving: page(`<div id="pill" class="glass" style="${PILL}">a still pill</div><div id="other" style="position:absolute;left:400px;top:300px;width:60px;height:40px;background:#123">other</div>`, 'html:has(#mv-bake-style) #other{margin-left:7px}'),
  // a transparent border with the colour clipped to the padding box: the tint must stay off the border
  // the override changes paint OUTSIDE every glass box (a rule keyed on the compiler's own style
  // element carrying rules): the pill certifies, the frame does not, nothing ships
  outside: page(`<div id="pill" class="glass" style="${PILL}">a fine pill</div><div id="other" style="position:absolute;left:400px;top:300px;width:60px;height:40px;background:#123">other</div>`, 'head:has(#mv-bake-style:not(:empty)) + body #other{background:#f00 !important}'),
  // a looping animation under the glass (a spinner): it never finishes, so the compiler holds it
  // paused - as the live sleep does - and the frame certifies instead of failing forever (issue #23)
  spinner: page(`<div id="spin" style="position:absolute;left:150px;top:90px;width:80px;height:80px;border-radius:50%;border:10px solid #fff;border-top-color:#123;animation:spin .8s linear infinite"></div><div id="pill" class="glass" style="${PILL}">loading</div>`, '@keyframes spin{to{transform:rotate(360deg)}}'),
  clip: page(`<div id="pill" class="glass" style="${PILL};border:4px solid transparent;background-clip:padding-box">clipped tint</div>`),
}
