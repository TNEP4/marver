/**
 * A fake 0.27.2 shell for the one ground's journal cases (spec 28 A3.8 #26, #27, #31; A2.10's (A3) cases): a fake
 * canvas `script` that speaks the inset and presentation contract through the real canvas preload, as the package's
 * `inset.ts` and `app-bridge.ts` do - the inset taken only with the whole contract, hello first with it, then theme
 * and busy; each `mv:present` answered once the viewport has the asked size (500 ms at most), after `frames`
 * animation frames, a newer request cancelling an older wait. What it does is set per document load through
 * `sessionStorage['mv-ground']` (a reload keeps it), so a case reloads into a mode:
 *   inset: 0 | 44      say this inset whatever the app answered (a shell that applied none says 0)
 *   hello: 'never' | 'late'   (lateMs, default 2000)
 *   present: 'normal' | 'never' | 'wrong-size' | 'answer-old' (hold each reply until the next request, send it first)
 *            | 'delay' (delayMs before answering)
 * It records in `window.__ground` what main asked and what it answered. The capture matrix's painted tags (A3.8 #34)
 * are the native stream's `ground` option; this paints nothing.
 */

/** The page script (fake-canvas.ts `script`); `say(what)` is the fake page's own. */
export const GROUND_SHELL = `
  var A = window.marverApp;
  var cfg = {};
  try { cfg = JSON.parse(sessionStorage.getItem('mv-ground') || '{}') || {} } catch (e) { cfg = {} }
  var G = window.__ground = { cfg: cfg, asks: [], answers: [], applied: null, topInset: A ? A.topInset : null };
  if (A) {
    var whole = A.topInset === 44 && typeof A.onPresent === 'function' && typeof A.presented === 'function';
    var inset = cfg.inset === 0 || cfg.inset === 44 ? cfg.inset : (whole ? 44 : 0);
    G.applied = inset;
    var page = 'PAGE_' + Math.random().toString(36).slice(2, 12) + '000000';
    var hello = function () {
      A.hello({ version: '0.27.2-fake', board: null, page: page, inset: inset });
      A.theme({ dark: false });
      A.busy({ busy: false, unsaved: false, why: [] });
      G.helloAt = Date.now();
      say('hello');
    };
    if (cfg.hello === 'late') setTimeout(hello, cfg.lateMs || 2000);
    else if (cfg.hello !== 'never') hello();
    var want = -1, held = null;
    var reply = function (p) { G.answers.push(p); A.presented(p) };
    if (typeof A.onPresent === 'function') A.onPresent(function (r) {
      G.asks.push(r);
      var mode = (window.__ground.cfg.present) || 'normal';
      if (mode === 'never') return;
      if (mode === 'answer-old' && held) { var old = held; held = null; reply(old) }
      want = r.epoch;
      var since = performance.now();
      var frames = Math.min(8, Math.max(1, r.frames | 0));
      var step = function (left) { requestAnimationFrame(function () {
        if (want !== r.epoch) return;
        var fits = Math.abs(innerWidth - r.w) <= 1 && Math.abs(innerHeight - r.h) <= 1;
        if (!fits && performance.now() - since < 500) return step(left);
        if (fits && left > 1) return step(left - 1);
        var p = { epoch: r.epoch, w: innerWidth + (mode === 'wrong-size' ? 10 : 0), h: innerHeight };
        if (mode === 'answer-old') { held = p; return }
        if (mode === 'delay') { setTimeout(function () { if (want === r.epoch) reply(p) }, window.__ground.cfg.delayMs || 300); return }
        reply(p);
      }) };
      step(frames);
    });
  }
  say('script');`
