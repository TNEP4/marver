# Publishing a Marver canvas

A published canvas is a static site: `marver build` bundles the shell, the prototype
stage, and your frames with all data inlined - it fetches nothing, saves nothing, and
runs on any static host. `marver serve` hosts it, optionally behind a gate - a shared
password, or Marver Sign In (see [Who can open your canvas](#who-can-open-your-canvas)).
Give it a persistent volume (`MARVER_DATA_DIR`) and comments + viewer accounts persist
across deploys (`MARVER_OWNER_EMAIL` bootstraps the first owner account).

Publishing is default-closed: `design/publish.json` names the boards that ship and
their rights (`"read"` or `"comment"`) - no policy and no explicit flag means no build.
A board row can also be an object that says how the board presents - its `type`
(`doc`, `slides`, `design`, `sketch`, `refs`, `mix`), the view visitors land in
(`open`: `canvas`, `board`, `present`, `focus`, `slides`), `lock` to freeze them
there, and for decks `transition` / `chrome` - the fields are spelled out in the
[sharing guide](sharing.md#publishjson-v2---the-ceiling-and-the-boards-shape) and,
for decks, the [slides guide](slides.md).

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
| Set | nothing | `MARVER_PASSWORD` | `MARVER_ID_ISSUER` + `MARVER_PUBLIC_ORIGIN` |
| People prove | nothing | they know a secret | who they are |
| Named accounts | none | only with `MARVER_DATA_DIR` | always (needs `MARVER_DATA_DIR`) |
| Who decides entry | - | you | you |
| Outbound requests | none | none | public keys only |
| Best for | a public canvas | one link to a small group | a team, across canvases |

`MARVER_DATA_DIR` is what turns a gate into accounts. Without it the password gate
is exactly one shared secret and nothing else - no per-person identity, no comments
that persist, and nothing for `marver comments invite` to write to. Marver Sign In
requires it outright, because identity accounts need somewhere to live.

They are alternatives, not layers. Setting both `MARVER_PASSWORD` and
`MARVER_ID_ISSUER` would weaken your invite list to "an account OR whoever has the
password", so the identity gate replaces the password gate rather than sitting
beside it.

**Whichever you choose, the guest list stays yours.** This is the part worth
reading twice: with Marver Sign In, the identity service proves *who somebody is*
and has no say in *where they may go*. Your canvas decides that, from a list it
holds. Somebody with a perfectly valid Marver account who is not on your list
gets nothing.

And the honest fine print, because this is a promise we publish rather than a
slogan: Marver stores which canvases a person has *signed in to*, and issues
short-lived tokens for them. What someone can **do** on your canvas is answered
by your canvas to their own browser, cached only there, and never sent to us.
Two things do cross the line, both disclosed and both optional: an invite email
means the identity service learns that an address was invited to your origin
(that is what sending the mail requires - decline it entirely with
`share: { notify: false }` in `design/config.ts` and use the dialog's "copy
invite message" instead), and the front door at `app.marver.design` learns
which origins a person probes (`share: { frontDoor: false }` keeps your canvas
silent there). The app ships no third-party analytics and no summary telemetry.

**Sharing, precisely.** Sharing controls who may **comment**, and who gets in
at all. What a person who is in can **see** is decided at build time by
`design/publish.json` - boards you do not publish are not in the bundle. One
canvas per audience is the read boundary today; per-person read arrives in v2,
served rather than bundled. Managing that roster - granting people, blocking
them, approving access requests, and reading who-sees-what from the terminal -
is its own guide: [Sharing a Marver canvas](sharing.md).

### Sovereign accounts (`MARVER_PASSWORD` + `MARVER_DATA_DIR`)

```bash
MARVER_PASSWORD=secret MARVER_DATA_DIR=/data npx marver serve
```

Everything stays here. Accounts live in `MARVER_DATA_DIR` as scrypt hashes, invites
are minted by you, and the canvas makes no outbound request of any kind - there is
no service to depend on and nothing to phone home to. If you want a canvas that
still works in ten years on a disconnected network, this is it.

`MARVER_PASSWORD` on its own is a simpler thing: one shared secret in front of the
bundle, with no accounts behind it. Add the volume when you want named people.

Auth is an HMAC-signed 30-day cookie with a per-boot secret (a server restart
re-prompts), and each password attempt pays an scrypt cost. Invite people with
`marver comments invite <email>`; they claim it in the browser and choose a
password.

**Set `MARVER_PUBLIC_ORIGIN` here too if you serve over https.** It is required for
Marver Sign In and optional here, but it is what puts `Secure` on that 30-day
cookie. Without it the canvas has to guess from `X-Forwarded-Proto`, and nginx's
own documented `proxy_pass http://localhost:PORT` sends no `X-Forwarded-*` at all -
so an https canvas behind that config drops `Secure` and the cookie will travel
over plain http. Proxies that do set the header (Railway, Fly, Vercel, Caddy,
nginx with `proxy_set_header`) were never affected. Fixed in 0.11.1; on 0.11.0 the
gate cookie guessed regardless.

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

A Marver account is **free**, and there is exactly one of it. That is the point:
the account is not per canvas, so the second board you share with somebody costs
them nothing - no signup, no password to store, no invite link to keep. The first
canvas is where they pay the thirty seconds; every one after that is a click. If
you have ever watched a review die because a reviewer could not find the link, that
is the friction this removes.

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
itself, so somebody whose email changes keeps their account and their history. Their
other sessions are signed out when that happens - a session records the address it
was minted for, and leaving it alive would hand it to whoever claims that address
next. A rename onto an address someone else already holds is refused outright.

> **Managing people needs `MARVER_CLI_TOKEN`.** `marver comments invite`,
> `revoke` and `sync` authenticate the CLI with a password, and an identity
> account has none. Set `MARVER_CLI_TOKEN` on the canvas to a generated secret of
> 32 characters or more and hand the same value back:
>
> ```bash
> # on the canvas:  MARVER_CLI_TOKEN=$(openssl rand -hex 24)
> MARVER_CLI_TOKEN='<that same value>' marver comments connect https://canvas.example.com
> ```
>
> `--token` works too, but a secret on the command line is visible to anything
> that can list processes, so prefer the variable.
>
> Generate it, do not choose it: nothing rate-limits this credential and nothing
> slows a guess down, so its entropy is the whole defence. Use hex rather than
> base64 - an `Authorization` header carries letters, digits, `_` and `-`, and the
> canvas refuses to start on a value it could never accept. It acts as whoever
> owns the canvas, so let the owner sign in once first.
>
> `connect` trades it for an ordinary session and stores THAT in
> `~/.marver/canvases/`, so neither the secret nor the session lands in your repo.
>
> **To revoke it, rotate `MARVER_CLI_TOKEN`.** Every session it ever minted stops
> working the moment the variable changes; sessions people hold in their browsers
> are untouched. `marver comments revoke` cannot help here - the session acts as
> the owner, and a canvas refuses to remove its last owner - so rotation is the
> lever, and it is the reason each device session records which secret minted it.
> (One instance at a time, as ever: during a rolling restart an old replica still
> honours old sessions until it drains.)
>
> It is a deployment variable rather than something a page hands out, and that is
> deliberate. A browser-approved sign-in for the CLI was built for this and then
> removed before release: authored frames run same-origin in a canvas, so frame
> JavaScript could have driven the approval itself and walked away with a
> long-lived credential; no header distinguishes a frame from the page around it,
> because they are the same origin. Per-member CLI credentials still want the
> frame isolation this release does not have, so the one credential is the
> operator's.

### The gate footer

The gate footer ("Powered by Marver.design") is the honor system, not enforcement:
Marver is free, the gate is fully personalized to your app, and that one line is how
the tool spreads - we'd love it if you keep it. It's yours to remove, no strings:
`share: { branding: false }` in `design/config.ts` (this also strips every Marver
mention from the page metadata, the sign-in screens included).

### Name the canvas

`share: { name: "Your App" }` in `design/config.ts`. That name titles the gate,
labels the brand pill, and becomes `utm_campaign` on every powered-by link the
canvas emits, so site analytics can tell which canvas sent a visitor. Unset, it
falls back to the root directory name - which inside a container is usually
`app`, so every unnamed containerised canvas reports as one campaign.

## Railway (the one-pager)

1. Push your repo to GitHub and create a Railway service from it.
2. Build command: `npm ci && npx marver build`
3. Start command: `npx marver serve`  (Railway's `$PORT` is picked up automatically)
4. Variables: `MARVER_PASSWORD=<your password>`

Deploy. The repo itself is the deployable - nothing to export, nothing to sync.

## Docker (everywhere else)

```dockerfile
FROM node:22-slim
WORKDIR /app                      # set share.name in design/config.ts - the fallback name is this directory
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
