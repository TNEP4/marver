# Publishing a Marver canvas

A published canvas is a static site: `marver build` bundles the shell, the prototype
stage, and your frames with all data inlined - it fetches nothing, saves nothing, and
runs on any static host. `marver serve` hosts it, optionally behind a gate - a shared
password, or Marver Sign In (see [Who can open your canvas](#who-can-open-your-canvas)).
Give it a persistent volume (`MARVER_DATA_DIR`) and comments + viewer accounts persist
across deploys (`MARVER_OWNER_EMAIL` bootstraps the first owner account).

Publishing is default-closed: `design/publish.json` names the boards that ship and
their rights (`"read"` or `"comment"`) - no policy and no explicit flag means no build.

```bash
npx marver build                      # boards named in design/publish.json → design/.dist
npx marver build --boards checkout    # only these boards - the frame filter is applied
                                      # at BUILD time; excluded frames never enter the bundle
MARVER_PASSWORD=secret npx marver serve            # a shared password, or:
MARVER_ID_ISSUER=https://id.marver.design \
  MARVER_PUBLIC_ORIGIN=https://your.canvas \
  MARVER_DATA_DIR=/data npx marver serve           # accounts, one sign-in across canvases
```

Deep links work verbatim: any `#/b/...` or `#/p/...` URL copied from your dev canvas
opens the same view on the published site.

**What ships**: the boards you list, the frames they reference, and the host `public/`
directory in full (the `--boards` filter covers frames, not public assets). A flow you
publish must have all its `data-goto` targets on a published board.

## Who can open your canvas

Three choices, and the canvas is public until you make one.

| | **Open** | **Password** | **Marver Sign In** |
|---|---|---|---|
| Set | nothing | `MARVER_PASSWORD` | `MARVER_ID_ISSUER` |
| People prove | nothing | they know a secret | who they are |
| Accounts | none | on your disk | on your disk |
| Who decides entry | - | you | you |
| Outbound requests | none | none | public keys only |
| Best for | a public canvas | one link to a small group | a team, across canvases |

They are alternatives, not layers. Setting both `MARVER_PASSWORD` and
`MARVER_ID_ISSUER` would weaken your invite list to "an account OR whoever has the
password", so the identity gate replaces the password gate rather than sitting
beside it.

**Whichever you choose, the guest list stays yours.** This is the part worth
reading twice: with Marver Sign In, the identity service proves *who somebody is*
and has no say in *where they may go*. Your canvas decides that, from a list it
holds, and the identity service is never told the answer. Somebody with a
perfectly valid Marver account who is not on your list gets nothing.

### Sovereign accounts (`MARVER_PASSWORD`)

Everything stays here. Accounts live in `MARVER_DATA_DIR` as scrypt hashes, invites
are minted by you, and the canvas makes no outbound request of any kind - there is
no service to depend on and nothing to phone home to. If you want a canvas that
still works in ten years on a disconnected network, this is it.

Auth is an HMAC-signed 30-day cookie with a per-boot secret (a server restart
re-prompts), and each password attempt pays an scrypt cost. Invite people with
`marver comments invite <email>`; they claim it in the browser and choose a
password.

The costs are the ordinary costs of passwords. It is one secret shared by
everybody, so removing one person means rotating it for all of them; there is no
password reset; and a person with five canvases keeps five passwords.

### Marver Sign In (`MARVER_ID_ISSUER`) - recommended for teams

```bash
MARVER_ID_ISSUER=https://id.marver.design \
MARVER_PUBLIC_ORIGIN=https://your.canvas \
MARVER_DATA_DIR=/data \
npx marver serve
```

The gate asks people who they are instead of asking for a shared secret. They sign
in once - with Google, or a code emailed to them - and every canvas you gate this
way opens without another password. Nobody types a canvas password, so there is
none to leak, rotate, or forget, and revoking one person revokes them.

This is the better default for a team, and it is the one we run ourselves. What it
costs you is honest to state:

- **A dependency.** If the identity service is unreachable, sign-in fails closed:
  existing sessions keep working, new ones are refused, nothing falls back to open.
- **The service learns when somebody signs in**, and to which canvas origin. It
  does not learn whether you let them in, what is on the canvas, or anything else.
- **It is a hosted service**, so it is the one part of a self-hosted canvas that is
  not self-hosted. The protocol is ordinary ES256 + JWKS and the verifying half
  lives in this repo (`src/server/marver-id.ts`), so a different issuer is a
  configuration change, not a fork.

A canvas with no `MARVER_ID_ISSUER` set makes no outbound request at all. Opting
out is the default, and this section is the only reason to opt in.

#### Configuration

`MARVER_PUBLIC_ORIGIN` is **required** - always, including in development - and the
canvas refuses to start without it. Every assertion is bound to this exact origin
(scheme, host and port), so one minted for one canvas is inert at another.

It is configuration rather than inference on purpose, and the reason is worth
knowing if you deploy behind a proxy. The canvas used to work this out for itself
when the connection looked local, which is wrong in the most ordinary setup there
is: nginx's documented `proxy_pass http://localhost:PORT` rewrites `Host` to the
upstream and adds no `X-Forwarded-*` headers at all, so a request from the open
internet arrives looking exactly like one from your own machine. There is no signal
here a proxy cannot erase, so the canvas asks instead of guessing.

It must be a bare origin - https anywhere, or http on loopback - with no path or
query. Cookie security follows it, not any forwarded header:

```bash
MARVER_PUBLIC_ORIGIN=https://canvas.example.com   # deployed
MARVER_PUBLIC_ORIGIN=http://localhost:4199        # development
```

#### Who gets in

An address may enter if it already has an account on this canvas, holds an
unexpired invite, or is `MARVER_OWNER_EMAIL` on a canvas with no accounts yet. You
invite people exactly as before; Marver Sign In only removes the password step from
claiming it.

People are matched on the stable identity behind the address, not the address
itself, so somebody whose email changes keeps their account and their history.

> **Known gap, being worked on.** Invites are currently created with
> `marver comments invite`, which signs the CLI in with a password - and identity
> mode has no passwords. So on a canvas gated this way, the owner can sign in but
> cannot yet invite anybody else from the CLI. Until that lands, seed the invites
> before switching a canvas to `MARVER_ID_ISSUER`, or run both canvases from the
> same `MARVER_DATA_DIR`.

### The gate footer

The gate footer ("Powered by Marver.design") is the honor system, not enforcement:
Marver is free, the gate is fully personalized to your app, and that one line is how
the tool spreads - we'd love it if you keep it. It's yours to remove, no strings:
`share: { branding: false }` in `design/config.ts` (this also strips every Marver
mention from the page metadata, the sign-in screens included).

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
