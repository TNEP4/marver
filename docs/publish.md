# Publishing a Marver canvas

A published canvas is a static site: `marver build` bundles the shell, the prototype
stage, and your frames with all data inlined - it fetches nothing, saves nothing, and
runs on any static host. `marver serve` hosts it with an optional password gate.

```bash
npx marver build                      # everything → design/.dist
npx marver build --boards checkout    # only these boards - the frame filter is applied
                                      # at BUILD time; excluded frames never enter the bundle
MARVER_PASSWORD=secret npx marver serve
```

Deep links work verbatim: any `#/b/...` or `#/p/...` URL copied from your dev canvas
opens the same view on the published site.

**What ships**: the boards you list, the frames they reference, and the host `public/`
directory in full (the `--boards` filter covers frames, not public assets). A flow you
publish must have all its `data-goto` targets on a published board.

**The gate**: with `MARVER_PASSWORD` set, every unauthenticated request gets the gate
page - the bundle is never sent pre-auth. Auth is an HMAC-signed 30-day cookie with a
per-boot secret (a server restart re-prompts). Each password attempt pays an scrypt
cost. The gate footer ("Powered by Marver.design") is the honor system, not
enforcement: Marver is free, the gate is fully personalized to your app, and that one
line is how the tool spreads - we'd love it if you keep it. It's yours to remove, no
strings: `share: { branding: false }` in `design/config.ts` (this also strips every
Marver mention from the page metadata).

## Railway (the one-pager)

1. Push your repo to GitHub and create a Railway service from it.
2. Build command: `npm ci && npx marver build`
3. Start command: `npx marver serve`  (Railway's `$PORT` is picked up automatically)
4. Variables: `MARVER_PASSWORD=<your password>`

Deploy. The repo itself is the deployable - nothing to export, nothing to sync.

## Docker (everywhere else)

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci && npx marver build
ENV PORT=8080
EXPOSE 8080
CMD ["npx", "marver", "serve"]
```

## Cloudflare Pages + Access (email/domain allowlists)

For teams that want per-email policies instead of one password: build in CI
(`npx marver build`, output directory `design/.dist`), deploy to Pages, then put
Cloudflare Access in front with your email or domain rules. Google login and audit
logs come free; Marver ships no auth code at all in this setup.
