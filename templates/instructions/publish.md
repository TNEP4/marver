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

## Railway quickstart (any volume-capable host works the same)

```bash
marver build                      # respects design/publish.json, seeds comment logs
railway init && railway up        # or link an existing service
railway volume add --mount-path /data
railway variables --set MARVER_PASSWORD=<pw> --set MARVER_DATA_DIR=/data \
  --set MARVER_OWNER_EMAIL=<owner@email> --set MARVER_TRUSTED_PROXY=1
# start command: npx marver serve
railway logs                      # ← the owner claim token prints here, once
```

Republishing is just `marver build` + redeploy: the server unions the seeded
logs on boot, so collected feedback is NEVER clobbered by a new build.
Run ONE instance - the event log is single-writer by design.

## Wiring people up (after first deploy)

```bash
# 1. claim the owner account (token from the deploy logs)
marver comments connect https://canvas.example.com --invite <token-from-logs>

# 2. invite each colleague - single-use link, no email infrastructure
marver comments invite colleague@company.com
#    → prints a single invite LINK; send it over Slack/DM (no canvas
#    password needed - the link is the credential). It opens straight into
#    "set a display name + choose a password" with an avatar picker.

# 3. the loop is now closed
marver dev                        # two-way syncs comments every 30s
marver comments list --open       # the agent's work queue
marver comments revoke <email>    # if someone leaves
```

Share links as `<url>/#/b/<board>` (or copy-link on any thread for a deep link
straight to it - the gate carries deep links through sign-in).

## What lands where (so you can reason about persistence)

- `design/publish.json` - the policy, git-tracked, part of the repo.
- `<MARVER_DATA_DIR>/comments/<board>.jsonl` - the live event log, on the volume.
- `<MARVER_DATA_DIR>/auth.json` - accounts (scrypt), sessions, invites, on the volume.
- `design/comments/<board>.jsonl` - the dev-side mirror, git-tracked: feedback
  has history, and the volume has an off-site replica for free.
- `design/.local/collab.json` - THIS machine's device credential. Gitignored;
  never commit it.
