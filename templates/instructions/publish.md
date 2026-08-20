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

2. **The canvas password** - `MARVER_PASSWORD` at serve time. This is the READ
   boundary: one shared password for GUESTS. Members never need it - their own
   account signs them in at the gate, and invite links skip it entirely (the
   token is the authorization). Rotating it therefore only affects guests.
   No env var = an open canvas.

3. **Collaboration on or off** - `MARVER_DATA_DIR` at serve time. Set it to a
   path on a PERSISTENT disk and the serve grows accounts + live comments.
   Leave it unset for a static, comment-free canvas. Setting it to ephemeral
   container disk is the one real deploy mistake - comments would vanish on
   redeploy; marver fails loudly if the dir cannot be created.

## The serve contract (env vars, complete list)

| Var | Meaning |
|---|---|
| `PORT` | listen port (hosts inject this) |
| `MARVER_PASSWORD` | canvas password (guests' read credential); unset = open |
| `MARVER_DATA_DIR` | persistent dir for `comments/` + `auth.json`; unset = no collaboration |
| `MARVER_OWNER_EMAIL` | prints a single-use OWNER claim link in the deploy logs on first boot |
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
railway variables --set MARVER_PASSWORD=<pw> --set MARVER_DATA_DIR=/data \
  --set MARVER_OWNER_EMAIL=<owner@email> --set MARVER_TRUSTED_PROXY=1
railway up                        # uploads the repo; Railway runs build then start
railway logs                      # ← the owner claim LINK prints here, once (see below)
```

Republishing is just `railway up` again: the server unions the seeded logs on
boot, so collected feedback is NEVER clobbered by a new build. Run ONE instance -
the event log is single-writer by design.

## What the deployed gate offers (so you know what you're wiring)

On a collaboration canvas the gate has three doors, one credential each:
- **Guest** - the canvas password → read-only across published boards.
- **Member** - "Sign in instead" → their own email + password → read + comment.
  A member session IS gate passage; they never touch the shared password again.
- **Invited** - opening an invite link → set a display name + password (+ optional
  avatar) → account created, read + comment. The link skips the canvas password.

## Wiring people up (after first deploy)

`MARVER_OWNER_EMAIL` makes the first boot print an owner bootstrap in the logs:
a browser link (`<url>/#/i/<token>`) AND the exact repo command. The token is
single-use. Claim it from the repo so this machine can mint invites:

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
  has history, and the volume has an off-site replica for free.
- `design/.local/collab.json` - THIS machine's device credential. Gitignored;
  never commit it.
