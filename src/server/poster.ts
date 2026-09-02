/**
 * Video posters, generated: a local clip without an authored poster gets one rendered
 * from its own first moments - the same headless Chrome the shot renderer drives, no
 * ffmpeg. The convention is `<clip>.poster.png` beside the clip in design/assets/, and
 * the Video primitive reaches for that name whenever `poster` is omitted, so the dev
 * server (on demand, when the frame first asks) and `marver build` (before assets are
 * copied - a published canvas never ships a poster-less video) produce one file both
 * agree on. An authored poster always wins: this only runs when the file is missing.
 *
 * The frame is taken at min(0.5s, half the duration) - the first frame of most clips is
 * black or a fade. The page is a file:// document holding the clip as a file:// <video>,
 * so nothing has to be served; readiness is the video element appearing in #root once
 * the seek lands, which is the shot renderer's own readiness rule.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { capture, findChrome } from './shot.ts'

/** The conventional poster path for a local clip reference (relative to design/assets/). */
export const posterNameFor = (src: string): string => `${src}.poster.png`

/** Is this a video reference the generator handles (a local design-asset clip)? */
export const isLocalClip = (src: string): boolean => !/^https?:\/\//.test(src) && /\.(mp4|webm|mov|m4v|ogv)$/i.test(src)

const PAGE = (video: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#000}#root video{display:block}
</style></head><body><div id="root"></div><script>
(function(){
  var v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = ${JSON.stringify(video)};
  var done = false;
  function show(){ if (done) return; done = true;
    var w = Math.min(1920, v.videoWidth || 1280), h = Math.round(w * ((v.videoHeight || 720) / (v.videoWidth || 1280)));
    v.width = w; v.height = h; v.style.width = w + 'px'; v.style.height = h + 'px';
    document.getElementById('root').appendChild(v) }
  v.addEventListener('loadedmetadata', function(){
    var t = Math.min(0.5, (isFinite(v.duration) ? v.duration : 1) / 2);
    v.addEventListener('seeked', show, { once: true });
    v.currentTime = t; });
  v.addEventListener('error', function(){ window.__mvFrameError = 'the clip could not be decoded by this browser (' + (v.error && v.error.code) + ')' ; document.getElementById('root').appendChild(document.createElement('i')) });
  setTimeout(function(){ if (!done && v.readyState >= 2) show() }, 4000);
})();
</script></body></html>`

/** Render `<clip>.poster.png` for a clip under design/assets/. Idempotent: an existing
 *  poster (authored or generated) is left alone. */
export async function ensurePoster(assetsDir: string, src: string): Promise<{ ok: true; path: string; width: number; height: number; generated: boolean } | { ok: false; error: string }> {
  if (!isLocalClip(src)) return { ok: false, error: `not a local clip: ${src}` }
  const clip = join(assetsDir, src)
  const out = join(assetsDir, posterNameFor(src))
  if (existsSync(out)) return { ok: true, path: out, width: 0, height: 0, generated: false }
  if (!existsSync(clip)) return { ok: false, error: `design/assets/${src} does not exist` }
  if (!findChrome()) return { ok: false, error: `no Chrome/Chromium found to render a poster for ${src} - add poster="..." on the <Video>, or install Chrome` }
  const dir = mkdtempSync(join(tmpdir(), 'mv-poster-'))
  const page = join(dir, 'poster.html')
  writeFileSync(page, PAGE(pathToFileURL(clip).href))
  mkdirSync(dirname(out), { recursive: true })
  try {
    const r = await capture({ url: pathToFileURL(page).href, width: 1920, height: 1080, scale: 1, out, fullHeight: false, clip: '#root video', timeoutMs: 20_000 })
    if (!r.ok) return { ok: false, error: `could not render a poster for ${basename(src)} - ${r.error}` }
    return { ok: true, path: out, width: r.width, height: r.height, generated: true }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
