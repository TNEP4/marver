---
name: publish-canvas
description: Use this when the canvas should be on a URL - a first publish, a republish after changes, or moving it to a new host. Steps with checks, the traps that have bitten, how to roll back.
last_success: none
depends_on:
  - design/publish.json
  - design/config.ts
  - Dockerfile
  - package.json
  - "service: the canvas host (Railway or any volume-capable host)"
  - "account: the host, and Marver Sign In or the canvas password"
---

# Publish a canvas

The recipe. `design/instructions/publish.md` is the reference - every variable, both gates, the
host contract; read it when a step here is not enough. Marver maintains this file; record your
project's values (which account, which domain, which gate) and every run in the log at the end.

## Prerequisites

- `@marver-design/marver` resolves from the registry in `package.json` - a `link:` or `file:`
  dependency cannot ride to a remote host.
- The three decisions are made: **which boards ship** (`design/publish.json` - publishing is
  default-closed), **who gets in** (Marver Sign In by default; the canvas password when nothing
  external may be in the sign-in path), **collaboration** (a persistent volume for comments, or none).
- The canvas has a name: `share: { name: "..." }` in `design/config.ts`.

## Steps

1. **Build locally first.** `npx marver build`.
   *Check:* it lists exactly the boards you meant, `textures:` reports the hi-fi frames asleep, and
   no warning names a deck with no slide frames.
2. **Check what ships.** `npx marver context check` when the project has `context/`.
   *Check:* no `team` or `restricted` file is reachable from a published board; a board's status
   ships only where its publish row says `"showStatus": true`.
3. **Commit the host files** - a `Dockerfile` (it gives the build a browser for the glass
   textures) and a `.dockerignore` with `node_modules`, `design/.dist`, `design/.local`.
   *Check:* `design/.dist` is gitignored and not in the upload.
4. **Create the service once:** a persistent volume, `MARVER_DATA_DIR` on it, the gate's variables,
   `MARVER_TRUSTED_PROXY=1` behind a proxy, `MARVER_CLI_TOKEN` generated (`openssl rand -hex 24`),
   never chosen. *Check:* the host lists the volume mounted at the path the variable names.
5. **Deploy** - on Railway, `railway up` from the repository root.
   *Check:* the deploy succeeds, and the URL answers with the gate.
6. **Walk it.** Sign in as the owner, open each published board, leave a comment, reload.
   *Check:* the comment survives the reload, and a second account sees only what its rights allow.
7. **Write the run** in the log below - date, revision, URL, what was checked.

## Traps

- **The upload is the working tree.** Untracked files and full-resolution images go up with it;
  `marver build` ships images at full size, and a large `design/assets/` can pass the host's upload
  cap. Keep heavy originals out of published frames, or out of the upload.
- **A repository linked to another project uploads there.** Check which project and service the
  host CLI is linked to before `up` - a canvas deployed onto the app's own service replaces the app.
- **An ephemeral data directory loses every comment** on the next deploy. The volume is not optional
  once collaboration is on.
- **Run one instance.** The comment log is single-writer.
- **Fonts only on your laptop** render differently in the build container; the glass textures then
  rest live. Bundle fonts with the project.
- **A republish never clobbers comments** - the server unions the seeded logs on boot - but tabs
  already open keep the old textures until they reload.

## Rolling back

Redeploy the previous revision the same way. Comments live on the volume, not in the build, so a
rollback keeps them; a board removed from `publish.json` hides its threads until it ships again.

## Run log

| Date | Revision | Who | URL | Outcome |
|---|---|---|---|---|
