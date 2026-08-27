# Publish - put the canvas on a URL, collaboration included

Publishing is three decisions, then one build and one process. A coding agent can
run the whole thing; nothing here needs a human at a dashboard except pasting env
vars if the host has no CLI.

## The three decisions

1. **Which boards ship, with which rights** - `design/publish.json`:

   ```json
   { "boards": { "release-review": "comment", "roadmap": "read" } }
   ```

   `read` = visible to anyone past the gate. `comment` = signed-in accounts can
   also pin threads. Boards not listed do not ship at all - their frames are not
   even in the bundle. `marver build` FAILS without this file (default-closed);
   `--boards a,b` overrides ad hoc (grants comment), `--all-boards` ships
   everything loudly.

2. **Who gets in** - pick ONE of two gates at serve time. They are alternatives,
   not layers; setting both weakens the invite list to "an account OR whoever
   has the password". No env var at all = an open canvas.

   **Marver Sign In - `MARVER_ID_ISSUER`. Use this by default.** People sign in
   as themselves (Google, or an emailed code) instead of sharing a secret. One
   sign-in opens every canvas gated this way, there is no password to leak or
   rotate, and removing one person removes exactly them. Needs
   `MARVER_PUBLIC_ORIGIN` set to the canvas's exact public origin, and
   `MARVER_DATA_DIR`.

   ```
   MARVER_ID_ISSUER=https://id.marver.design
   MARVER_PUBLIC_ORIGIN=https://<the deployed url>
   ```

   **The canvas password - `MARVER_PASSWORD`.** The sovereign option, and the
   right one when the canvas must depend on nothing outside itself: no outbound
   request of any kind. One shared password for GUESTS; members never need it,
   since their own account signs them in and invite links skip it entirely.
   Choose it deliberately - offline or air-gapped hosting, or an explicit
   preference for no third party in the sign-in path - not by default.

   **Who may enter is decided by the canvas either way**, from the invite list
   the owner keeps. Marver Sign In proves who somebody is; it has no say in
   where they may go, and is never told the answer.

3. **Collaboration on or off** - `MARVER_DATA_DIR` at serve time. Set it to a
   path on a PERSISTENT disk and the serve grows accounts + live comments.
   Leave it unset for a static, comment-free canvas. Setting it to ephemeral
   container disk is the one real deploy mistake - comments would vanish on
   redeploy; marver fails loudly if the dir cannot be created.

## The serve contract (env vars, complete list)

| Var | Meaning |
|---|---|
| `PORT` | listen port (hosts inject this) |
| `MARVER_ID_ISSUER` | `https://id.marver.design` - people sign in as themselves (**preferred**) |
| `MARVER_PUBLIC_ORIGIN` | REQUIRED with `MARVER_ID_ISSUER`: this canvas's exact public origin |
| `MARVER_PASSWORD` | the sovereign alternative: one shared password; unset = open |
| `MARVER_DATA_DIR` | persistent dir for `comments/` + `auth.json`; unset = no collaboration |
| `MARVER_OWNER_EMAIL` | who owns an empty canvas. With Marver Sign In they just sign in; with a password, a single-use claim link prints in the deploy logs on first boot |
| `MARVER_CLI_TOKEN` | generated 32+ char secret (`openssl rand -hex 24`) that lets this repo run `comments invite`/`revoke`/`sync` as the owner. Required with `MARVER_ID_ISSUER` - identity accounts have no password for the CLI to use |
| `MARVER_TRUSTED_PROXY` | set to `1` behind a reverse proxy (Railway, Fly) so rate limits see real IPs |

## The host contract (works on any volume-capable host)

The host does two things, and the deploy config names both. **`design/.dist` is
gitignored - it is built ON THE HOST at deploy time, never committed.**

- **build command**: `<install> && npx marver build` (respects `publish.json`,
  seeds comment logs into the bundle)
- **start command**: `npx marver serve` (reads `PORT` + the env vars above)
- a **persistent volume** mounted at some path, named by `MARVER_DATA_DIR`

The `@marver-design/marver` dependency must resolve from the registry (a local
`link:`/`file:` dep cannot ride to a remote host) - a normal registry version (`npm i -D @marver-design/marver@latest`) in
`package.json` is all it takes.

## Railway quickstart

Commit a `railway.json` so `railway up` knows how to build and serve:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "NIXPACKS", "buildCommand": "pnpm install && npx marver build" },
  "deploy": { "startCommand": "npx marver serve" }
}
```

Then, once per service:

```bash
railway init                      # or `railway link` an existing service
railway volume add --mount-path /data
# The default gate: people sign in as themselves.
railway variables --set MARVER_ID_ISSUER=https://id.marver.design \
  --set MARVER_PUBLIC_ORIGIN=https://<the deployed url> --set MARVER_DATA_DIR=/data \
  --set MARVER_OWNER_EMAIL=<owner@email> --set MARVER_TRUSTED_PROXY=1 \
  --set MARVER_CLI_TOKEN="$(openssl rand -hex 24)"
# ...or the sovereign alternative, if this canvas must depend on nothing external:
#   --set MARVER_PASSWORD=<pw>   (instead of MARVER_ID_ISSUER/MARVER_PUBLIC_ORIGIN)
railway up                        # uploads the repo; Railway runs build then start
railway logs                      # with a PASSWORD gate, the owner claim link prints
                                  # here once. With Marver Sign In there is no link -
                                  # the owner simply signs in. See below.
```

Republishing is just `railway up` again: the server unions the seeded logs on
boot, so collected feedback is NEVER clobbered by a new build. Run ONE instance -
the event log is single-writer by design.

## What the deployed gate offers (so you know what you're wiring)

**With `MARVER_ID_ISSUER`** there is one door: people sign in at
id.marver.design with Google or an emailed code, come back, and are let in if
the owner's list has their address. Nobody types a canvas password because there
isn't one. An address that is not on the list is refused by name, on screen.

**With `MARVER_PASSWORD`** the gate has three doors, one credential each:
- **Guest** - the canvas password → read-only across published boards.
- **Member** - "Sign in instead" → their own email + password → read + comment.
  A member session IS gate passage; they never touch the shared password again.
- **Invited** - opening an invite link → set a display name + password (+ optional
  avatar) → account created, read + comment. The link skips the canvas password.

## Wiring people up (after first deploy)

**With Marver Sign In**, the owner just signs in - `MARVER_OWNER_EMAIL` claims an
empty canvas for that address, with no token to pass around.

**To manage people from this machine, the canvas needs `MARVER_CLI_TOKEN`.**
`comments invite`, `revoke` and `sync` sign the CLI in with a password, and
identity mode has none. Generate a secret - do not choose one, nothing
rate-limits this and nothing slows a guess down - set it on the canvas, and hand
the same value back:

```bash
# on the canvas (deployment environment):  MARVER_CLI_TOKEN=$(openssl rand -hex 24)
MARVER_CLI_TOKEN='<that same value>' marver comments connect https://canvas.example.com
```

Hex, not base64: an `Authorization` header carries letters, digits, `_` and `-`,
and the canvas refuses to start on a value it could never accept. `--token` works
too, but a value on the command line is visible to anything that can list
processes, so prefer the variable.

It acts as whoever owns the canvas, so let the owner sign in once first - until
somebody owns it there is nobody for the token to be. `connect` trades it for an
ordinary session and stores THAT, so the secret never lands in your repo.
Rotating `MARVER_CLI_TOKEN` ends every session it minted.

Then invite people by address, and send them nothing:

```bash
marver comments invite colleague@company.com
#    → in identity mode the ADDRESS is the invitation. They open the canvas URL,
#      sign in as themselves, and the invite is spent by that sign-in. There is
#      no link to forward and no canvas password to send with it - the claim link
#      is deliberately shut off in identity mode, so do not go looking for one.
```

It is a deployment variable and not something a page hands out, because authored
frames run same-origin in a canvas: frame code can read `mv_c` and ride the
viewer's session, so anything a browser can mint, a frame can mint silently. A
browser-approved device flow was built for this job and removed before release for
that reason. Do not reintroduce one, and do not invent a workaround that posts to
internal endpoints.

**With a canvas password**, `MARVER_OWNER_EMAIL` makes the first boot print an
owner bootstrap in the logs: a browser link (`<url>/#/i/<token>`) AND the exact
repo command. The token is single-use. Claim it from the repo so this machine can
mint invites:

```bash
# 1. claim the owner account - copy the command the deploy logs printed:
marver comments connect https://canvas.example.com --invite <token-from-logs>

# 2. invite each colleague - one command, one link, no email infrastructure
marver comments invite colleague@company.com
#    → prints a single invite LINK (<url>/#/i/<token>). Send it over Slack/DM
#    with the canvas password. It opens straight into the claim (name +
#    password + optional avatar). Single-use; 7-day expiry.

# 3. the loop is now closed
marver dev                        # two-way syncs comments every 30s
marver comments list --open       # the agent's work queue
marver comments reply <thread> --body "..."          # answer in the loop
marver comments resolve <thread> --addressed-in <frame>   # close with a receipt
marver comments revoke <email>    # kills the account + its sessions, mid-flight
```

Share the canvas as `<url>/#/b/<board>` (with the canvas password), or copy-link
on any thread for a deep link straight to it - the gate carries deep links
through sign-in.

## What lands where (so you can reason about persistence)

- `design/publish.json` - the policy, git-tracked, part of the repo.
- `<MARVER_DATA_DIR>/comments/<board>.jsonl` - the live event log, on the volume.
- `<MARVER_DATA_DIR>/auth.json` - accounts (scrypt), sessions, invites, on the volume.
- `design/comments/<board>.jsonl` - the dev-side mirror, git-tracked: feedback
  has history, and the volume has an off-site replica for free. **Each event
  carries its author's email address** - that is how the canvas decides who may
  edit or resolve their own thread. Harmless in a private repo; if yours is
  public, or may become public, gitignore `design/comments/` and let the volume
  be the record. The canvas keeps its own copy either way, so nothing is lost.
- `~/.marver/canvases/<project-hash>.json` - THIS machine's device credential, kept
  OUTSIDE the repo because `marver dev` serves the repo;
  never commit it.
