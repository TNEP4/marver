# White-flash A/B harness

`zoom-ab-tpl.html` is a self-contained zoom-stress page: 16 real artifacts rendered two ways
(iframe vs Shadow DOM), with a blur-chrome toggle and a stress-zoom fps meter. Isolates the
white-flash variables without touching marver.

Regenerate with a running server's real artifacts (replaces the `__DATA__` marker):
```bash
# with `node ~/marver/dist/cli.mjs dev --port 5362` running on a heavy board:
python3 - <<'PY'
import re, json, urllib.request
BASE='http://localhost:5362'
man=json.load(urllib.request.urlopen(BASE+'/__mv/api/artifacts'))['frames']
frames=[]
for fid,fa in man.items():
    v=fa['variants'].get('light@1280') or next(iter(fa['variants'].values()))
    if v['status']!='ready': continue
    raw=urllib.request.urlopen(BASE+v['href']).read().decode()
    theme=(re.search(r'data-theme="([^"]+)"',raw) or [None,'light'])[1]
    css='\n'.join(re.findall(r'<style[^>]*>([\s\S]*?)</style>',raw))
    body=re.search(r'<body[^>]*>([\s\S]*?)</body>',raw); body=body.group(1) if body else ''
    scss=re.sub(r'(^|[{},;])\s*:root\b',r'\1:host',css)
    scss=re.sub(r'(^|[{},;>~+])\s*html\b',r'\1:host',scss); scss=re.sub(r'(^|[{},;>~+])\s*body\b',r'\1:host',scss)
    frames.append({'id':fid,'theme':theme,'raw':raw,'css':scss,'body':body})
TPL=open('harness/zoom-ab-tpl.html').read()
open('harness/zoom-ab.html','w').write(TPL.replace('__DATA__', json.dumps(frames)))
print('wrote harness/zoom-ab.html with',len(frames),'frames')
PY
```
Then open `harness/zoom-ab.html` in Chrome. See ../WHITE-FLASH-ARCHIVE.md for the full story.
