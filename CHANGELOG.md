# Changelog

Notable changes to `@marver-design/marver`. Format follows [Keep a Changelog](https://keepachangelog.com); versions follow semver.

## 0.13.0 - 2026-09-01

### Added

- **@-mentions in comments.** Type `@` in the composer to name someone already
  visible in the canvas's comments - they get one mail for that comment and a
  bell notification on the front door. Mentions ride the same identity-minimised
  projection as authors: browsers only ever see opaque ids, and you can only
  mention people you can already see. The agent side is real too: `marver
  comments list --json` now carries each comment's mentions.
- **Reply mail.** A fresh reply mails the thread's other participants (the 10
  most recent, at most once per person per thread per 6-hour window; history
  imports never mail). Activity mail reads like a comment - who wrote it and a
  snippet of what they said (capped, escaped; the identity service holds those
  snippets for its delivery window - a disclosed tradeoff, documented in
  docs/sharing.md) - and carries an unsubscribe link that mutes email without
  touching the bell. Caveat: delivery needs Marver Sign In - a sovereign canvas
  has no relay, and `share: { notify: false }` still declines everything.
- **Mentions light up in the canvas.** A mention of you pulses its comment pin
  in accent blue until you open the thread, the marker stack opens on the
  mentioning thread first, and a mention of YOU renders as the loudest chip -
  including in your own view (they used to render plain exactly for the person
  they were for). The @-picker got a solid background.

### Fixed

- **Comment `profile` events now bind to the signed-in author.** They were
  accepted with an arbitrary `author.email`, which let any commenter read the
  opaque id of any guessed address off the projection.
- **Blank bodies and duplicate reply ids are refused.** Replay always discarded
  them silently; the validator now agrees, so nothing downstream (like mail)
  can fire for an event that was never going to render.

- **`marver share explain` now asks the canvas's own resolver.** It called
  `resolveAccess` locally over the fetched roster, which drops the three things only the
  server's `explain` route does - fills the owner role (a fresh owner was explained as an
  ordinary ungranted person), explains a `@domain` through a synthetic member, and marks
  the winning step. It now fetches `GET /__mv/api/share/explain?who=`, so the terminal and
  the browser dialog can never disagree. `who` stays local (it lists only granted
  non-owner principals, where a local resolve is identical).

## 0.12.0 - 2026-08-31

### Added

- **Sharing: grant people access to a canvas, person by person, from the terminal or
  the browser.** On a canvas with a persistent volume and an owner account, `marver share`
  manages a roster of *people* - who may open the canvas, who may comment, and until when -
  over the canvas's owner-only routes; the browser share dialog drives the same routes.
  `add`, `remove`, `block`, `unblock`, `general <mode>`, `list`, `requests`, `explain`, and
  `who` cover the whole surface. Exact-email grants work on a password canvas; domain grants
  (`@acme.com`), refused-visitor access requests, and the front door need Marver Sign In.
  The full guide is [docs/sharing.md](docs/sharing.md).

  **One resolver, one place.** A single pure function answers "what can this person do here" -
  blocklist first (the only deny), then the owner, then grants additive with the highest match
  winning, then a general-access floor, all clamped by each board's published ceiling. The gate
  and comment writes enforce from it, reading one `share.json`, so the policy is one thing in
  one place rather than a rule re-implemented per door. `marver share explain <email>` traces
  it for one person and `marver share who` prints the grant matrix (both convenience views -
  the dialog is the accurate read for the owner and for domain principals).

- **`design/publish.json` v2: a board can carry its artifact type and landing view, not just
  its ceiling.** A board level may now be an object - `{ "max": "read" | "comment", "type":
  "doc" | "slides" | "design" | "sketch" | "refs" | "mix", "open": "canvas" | "board" |
  "present" | "focus" | "slides", "lock": true }` - where `max` is the ceiling (the only
  field that affects access) and the rest choose how the board presents. `open` accepts all
  five view names, but slides mode is v1.5: `open: "slides"` currently lands in `present`.
  Every 0.11 canvas parses unchanged: a bare `"read"` or `"comment"` string is still a valid
  row. (This is a schema version, unrelated to the read-privacy "v2" below.) Source paths
  in a published bundle now go opaque by default (`reveal.source` defaults off) - the inlined
  manifest used to carry every frame's repo path, which is a disclosure the moment a canvas
  is shared beyond its own repo.

- **Access requests: a refused visitor can ask, and you can approve from the terminal.** When
  someone is turned away at the identity gate, the canvas offers a request form instead of a
  dead end (authenticated by a short-lived, origin-bound, single-purpose token - the refused
  visitor has no session). Requests surface in `marver share requests` and the dialog;
  approving grants canvas-wide at the role you choose, declining resolves silently. One
  pending row per address, swept after 30 days.

- **The front door at `app.marver.design`.** A signed-in home page that lists the canvases a
  person can reach, each row lit by a short summary the canvas itself signs and serves. The
  front door holds no roster and makes no access decision - it asks each canvas, and each
  canvas answers for itself, against browser-pinned keys. Keep a canvas silent there with
  `share: { frontDoor: false }` in `design/config.ts`.

### Notes

- **Read privacy is still v2.** Sharing v1 controls who gets in and who may comment; every
  admitted person can read every published board. The read boundary today is the bundle - a
  board you do not publish is not in the build. Grants are canvas-scoped and approvals are
  canvas-wide by design; `share.json` is already shaped for the per-board, per-person read
  privacy that arrives in v2, served rather than bundled.

- **First boot writes `share.json` from your live 0.11 state and changes nothing you did not
  ask for.** Every existing account gets the canvas-wide `comment` grant it already had
  (clamped per board); until that first boot, every door keeps the legacy rules. Raising a
  board's ceiling never silently re-promotes anyone granted under the old one - the roster
  ratchets down on every boot and only your explicit re-confirm raises an entry.

## 0.11.1 - 2026-08-27

### Fixed

- **The password gate's cookie now gets `Secure` from the pinned origin too.** 0.11.0 fixed
  this for the collaboration session cookie and missed the gate's own, which is set in a
  different file and is the one most likely to be sitting behind a plain `proxy_pass` - it is
  the door on every password-mode canvas. Same rule, same reason: `MARVER_PUBLIC_ORIGIN`
  decides when it is set, and `X-Forwarded-Proto` is the fallback only when there is nothing
  better. Set `MARVER_PUBLIC_ORIGIN=https://your-canvas.example.com` and the thirty-day gate
  cookie is https-only regardless of what your proxy tells the process.

  Canvases behind a proxy that does send `X-Forwarded-Proto` - Railway, Fly, Vercel, Caddy,
  and nginx configured with `proxy_set_header` - were never affected.

## 0.11.0 - 2026-08-27

### Added

- **Marver Sign In: a canvas can ask people who they are, instead of asking for a shared
  password.** Set `MARVER_ID_ISSUER=https://id.marver.design` (plus `MARVER_PUBLIC_ORIGIN`
  and `MARVER_DATA_DIR`) and the gate becomes an identity gate. People sign in once - with
  Google, or a code emailed to them - and every canvas gated this way opens without another
  password. Nobody types a canvas password, so there is none to leak, rotate, or forget, and
  revoking one person revokes exactly them. This is the better default for a team, and the
  one we run ourselves.

  **Your guest list stays yours.** The identity service proves *who somebody is* and has no
  say in *where they may go*: an address gets in if it already has an account on your canvas,
  holds an unexpired invite, or is `MARVER_OWNER_EMAIL` on a canvas with no accounts yet.
  That decision is made on your disk, and the identity service is never told the answer.
  Somebody with a perfectly valid Marver account who is not on your list gets nothing.

  **The sovereign path is unchanged and is not going anywhere.** `MARVER_PASSWORD` still
  gates a canvas with accounts that live entirely in your `MARVER_DATA_DIR`, and a served
  canvas with no `MARVER_ID_ISSUER` set makes no outbound request at all - nothing to depend
  on, nothing to phone home to. (Stated precisely, because it is the kind of promise that
  should be: `marver serve` is silent. `marver dev` still makes the one anonymous registry
  request it always has, once a day, to notice a new version - `MARVER_NO_UPDATE_CHECK=1`
  turns it off - and a workspace you have connected to a published canvas still syncs its
  comments with that canvas.) The two are alternatives rather than layers: running both
  would weaken your invite list to "an account OR whoever has the password", so the identity
  gate replaces the password gate rather than sitting beside it.

  How it works, for anyone who wants to check rather than trust: the canvas mints a
  single-use nonce bound to the browser that started the sign-in, the tab visits the identity
  service and comes back with a short-lived ES256 assertion in the URL fragment - the one
  part of a link no server ever receives - and the canvas verifies it against published JWKS
  before issuing its own ordinary session. The assertion's audience is the canvas's exact
  origin, port included, so one minted for one canvas is inert at another. The verifying half
  is dependency-free and lives in this repo (`src/server/marver-id.ts`), which is why
  pointing a canvas at a different issuer is a configuration change rather than a fork.

  `MARVER_PUBLIC_ORIGIN` is required and the canvas will not start without it, in
  development too. The audience cannot be inferred safely: nginx's documented
  `proxy_pass http://localhost:PORT` rewrites `Host` and adds no `X-Forwarded-*`, so a
  request from the internet is indistinguishable from a local one - and a canvas that
  guessed would hand its caller a `http://localhost` audience and a cookie with no Secure
  flag.

  Sign-in fails closed: if the identity service is unreachable, existing sessions keep
  working and new ones are refused. Nothing falls back to open.

  **Managing people from the repo needs `MARVER_CLI_TOKEN`.** `marver comments invite`,
  `revoke` and `sync` authenticate the CLI with a password, and an identity account has none -
  so set `MARVER_CLI_TOKEN` on the canvas to a *generated* secret of 32 characters or more
  (`openssl rand -hex 24`) and pass the same value back:

  ```
  MARVER_CLI_TOKEN='<that same value>' marver comments connect https://canvas.example.com
  ```

  (`--token` works too, but a secret on the command line is visible to anything that can
  list processes.)

  It acts as whoever owns the canvas, so it does nothing until somebody has signed in and
  claimed it. Generate it rather than choosing one: nothing rate-limits this credential and
  nothing slows a guess down, so its entropy is the whole defence, and a length floor is the
  only part of entropy a program can check. The canvas refuses to start on a value that is too
  short, and on one containing characters an `Authorization` header cannot carry - hex rather
  than base64, so that a canvas never boots holding a secret it would go on to reject.

  `connect` trades that secret for an ordinary session and stores THAT in
  `~/.marver/canvases/`, so neither the secret nor the session lands in your repo. **Rotate
  `MARVER_CLI_TOKEN` to revoke it**: every session it minted stops working the moment the
  variable changes, and sessions people hold in their browsers are untouched. That is the
  lever rather than `comments revoke`, because the session acts as the owner and a canvas
  refuses to remove its last owner.

  It is an environment variable, and not a page that hands out tokens to whoever is signed in,
  for a reason worth stating plainly: authored frames run same-origin in a canvas. That is
  deliberate and documented, and it means frame JavaScript can read `mv_c` and ride the
  viewer's session - so any browser-reachable way to mint a durable credential is a way for a
  frame to mint one silently and carry it off, an owner's if an owner is the one looking. A
  browser-approved device flow was built for exactly this job and pulled before release for
  exactly that reason; requiring a real top-level navigation narrowed it and did not close it,
  because `Sec-Fetch-Site: same-origin` proves where a request came from and never that a
  person meant it. An environment variable is on the other side of that line: it is never
  sent to a page, and reaching it already means reaching the deployment.

  The cost is honest. It is a static secret that rotates by redeploying, and it acts as the
  owner rather than as a person, so it is an operator's credential and belongs with your other
  deployment secrets. Per-member CLI credentials still want the frame isolation this release
  does not have.

### Changed

- **The gate refuses to be framed** - every gate response now carries
  `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. A
  credential form inside somebody else's page, under a transparent button, is the classic
  clickjack, and `SameSite=Lax` does not help because a framed page on the same site still
  carries its cookies. Called out because it is a behaviour change rather than an addition:
  if you were embedding a password-gated canvas in an iframe, that stops working. Embedding
  a canvas people have already signed into is unaffected - it is the gate itself that
  refuses.

### Fixed

- **`Secure` on the collaboration session cookie no longer depends on a header your proxy may
  not send.** A canvas decided whether it was on https by reading `X-Forwarded-Proto`, and
  nginx's own documented `proxy_pass http://localhost:PORT` sets no `X-Forwarded-*` at all. A
  canvas served over https behind that configuration saw no header, concluded "not secure",
  and issued a thirty-day session cookie the browser would happily send over plain http. Where
  `MARVER_PUBLIC_ORIGIN` is set it now decides - a deliberate statement by whoever deployed
  the canvas, rather than a guess about a proxy that may not be speaking. The header remains
  the fallback only where there is nothing better, which is development on loopback.

  This release fixed the collaboration session cookie only. The password gate's own cookie
  still guessed from the header - see 0.11.1.

- **The collaboration credential has moved out of your repository, because `marver dev` was
  serving it.** It lived at `design/.local/collab.json`, and the dev server puts the repository
  on the web so frames can import from it. Authored frames run same-origin, so any frame could
  `fetch('/design/.local/collab.json')` and carry off a live session for your published canvas.

  It now lives in `~/.marver/canvases/`, keyed by the project's path - one file per canvas per
  machine, outside anything that is served. `connect` writes there, `dev` moves an older
  credential out of the repo the first time it runs, and nothing needs doing by hand.

  Guarding the old location was tried first and is the reason for the move: a deny rule matched
  the path asked for rather than the file served, so a repository containing
  `leak.json -> design/.local/collab.json` walked straight past it - and after that was fixed,
  `public/` and Vite's derived `index.html` candidates each did the same. Enumerating a
  bundler's resolution rules is not a thing anyone finishes. Those guards stayed as depth,
  `design/.local` is still never served whatever route a request takes, and Vite's own default
  deny list is no longer replaced by ours.

  If you have ever run `marver dev` on a repository you did not write, treat that credential as
  exposed: change `MARVER_CLI_TOKEN` on the canvas, which ends every session it minted, or on a
  password-account canvas `marver comments revoke` and reconnect.

- **A gated canvas is no longer publicly cacheable in identity mode.** The `Cache-Control`
  decision keyed off the password verifier alone, so an identity-gated canvas marked its
  assets `public, immutable` - an invitation for a shared CDN to serve somebody's private
  frames to anybody who asked. Both modes are now `private, no-store`.

- **A missing cosmetic file no longer falls through to the bundle.** Favicon and logo paths
  are allowed past the gate on the promise that they are favicons and logos; when no such
  file existed, the hash-routing fallback handed an unauthenticated caller `index.html`
  instead. For those paths a miss is now a miss.

## 0.10.2 - 2026-08-24

### Fixed

- **`marver shot` renders content frames at their real size.** The verify-loop screenshot
  (and the file-drop `design/.local/shots/*.request.json` transport) used to capture every
  frame at the mobile viewport - a 780x1688 crop - so a `Doc layout="wide"` frame came back
  squeezed and anything past ~1688px tall was invisible to the verifying agent. A shot now
  sizes a content frame the way the canvas does: its `contentWidth` (760 document / 1280 wide,
  or a declared `meta.viewport`'s width) at full measured height. Long frames render in full;
  past a capture-safe height the shot drops to 1x pixel density and, if still enormous, reports
  `truncated` with a note rather than producing a gigapixel PNG. The `/api/shot` and file-drop
  results now include `scale` and, when clipped, `truncated`/`note`.
- **A slow dev server no longer fails a healthy frame.** A frame that hadn't reported ready
  within 10s was marked `frame failed` / `frame never reported ready (10s)`, hidden behind a red
  card that only a per-frame click could clear - but the frame was usually fine, just waiting on
  a slow module response (Vite re-optimizing dependencies, or the box saturated by parallel Live
  Jam agents). A genuine failure already reports itself immediately, so silence past the deadline
  now auto-renavigates the frame once on a fresh revision; if it's still loading it stays visible
  behind a quiet "still loading" pill (with its own reload) instead of a failure. A late ready
  clears it, and a stale ready from the superseded document is dropped by generation so it can't
  mark a reloading frame ready.

### Added

- **`marver dev` warns when your instructions predate the installed package.** Upgrading the
  package doesn't refresh the managed files in `design/` - so a workspace scaffolded on an
  older version could run the new daemon against an agent contract that predated it (for
  example, Live Jam armed with no `jam.md` on disk). Dev now prints one line at boot when a
  managed instruction file is behind the installed version - `instructions predate marver
  <version> (jam.md, ...) - run: npx marver init` - comparing the on-disk `marver:managed`
  hashes against what this version ships. Files you edited or detached are never flagged.

## 0.10.1 - 2026-08-21

### Added

- **Point an agent at anything on the canvas by its location.** Right-click a board, scene,
  or frame in the sidebar for a Copy path action (the same signpost icon as the floating
  toolbar): a board copies `board: <b>`, a scene `board: <b> - scene: <s>  (design/scenes/<s>/)`,
  a frame `board: <b> - frame: <id>  (<file>)`. Laser copy now leads with `[board > scene]`
  before the file and selector, and the floating toolbar plus Shift+P copy that same frame
  address (board, frame, file) - all routed through one helper so the three never drift. On a
  real copy the toolbar signpost flashes to a check. The AGENTS templates and the Live Jam
  guide explain how to read every pasted address.
- **Manage boards from the sidebar.** Rename a board inline from its right-click menu; the
  dev server performs an atomic no-clobber move and refuses a board that has a live connection
  or a comment log (comment and sync state is board-keyed and cannot follow a file rename).
  Reorder boards by dragging - a pointer-driven gesture (not native drag-and-drop) that holds
  a grabbing cursor for the whole drag and marks the landing with a single brand-blue seam per
  gap, overlaid so the list never shifts. A plain click still switches boards.

### Removed

- The Duplicate-frame button on the floating selection toolbar.

## 0.10.0 - 2026-08-21

### Added

- **Live Jam speaks five more agent CLIs: Cursor, droid (Factory), opencode, grok, and pi**,
  alongside claude and codex - which also covers the apps built on them (Factory drives
  `droid`, Cursor drives `cursor-agent`, Conductor drives `claude`). Each adapter spawns its
  CLI headless with the same posture claude set: edits yes, shell no (or OS-sandboxed) -
  cursor runs with its sandbox forced on and never gets `--force`, droid loses its shell,
  delegation, and connector tools, opencode runs under a per-spawn default-deny permission
  grant, grok has its shell and subagents removed, pi's tool allowlist simply omits bash. Detection knows their env markers (`CURSOR_AGENT`,
  `OPENCODE`, `PI_CODING_AGENT`; droid and grok set none and are found by PATH), and
  `jam: "droid"` in the config block names one exactly as before. The Live Jam guide carries
  the full spawn-and-jail table.

- **The verify loop: agents can now SEE what they built.** Field feedback from 0.9.0: a
  jam agent shipped variants that were blank at render time, because no-shell (deliberate -
  the job packet carries untrusted text) also meant no screenshots. The answer is a jailed
  capability, not a shell: `GET /api/shot?frame=<id>&theme=<t>` on the dev server renders
  the frame with the machine's own headless Chrome (CDP over Node's built-in WebSocket -
  zero new dependencies) and returns a PNG under `design/.local/shots/`. Two transports,
  because the no-shell jail rules out the obvious one: a **file-drop inbox** (the agent
  writes a `<slug>.request.json`, the dev server renders and writes a `<slug>.result.json`
  with the PNG path) works for every agent including Claude Code, whose WebFetch refuses
  localhost; and `npx marver shot <frame>` / `GET /api/shot` for shell-ful agents and
  humans. The inbox watcher pairs `fs.watch` with a 1s sweep, so a request lands even on
  filesystems where watching is flaky (macOS temp, network mounts) - the same belt-and-
  braces the comments daemon uses. Readiness is deterministic (root mounted, fonts ready);
  a failed navigation, an unreachable server, or a frame that threw at render all return an
  honest `{ok:false,error}` carrying the real cause (the frame's own exception, surfaced via
  the frame host) rather than a blank that reads as success - so even an agent whose model
  cannot read images still learns from the JSON whether the frame rendered. The generated
  jam instructions require: shoot, read the result, LOOK at the PNG when you can - and say
  so honestly when you cannot. Verified live: Claude Code screenshotted a tour frame through
  the file-drop path and read back its real headline; Claude, Codex, Cursor, grok, and pi
  all read a rendered PNG correctly in isolation (opencode's configured model has no vision,
  and degrades to the JSON signal).
- **A troubleshooting drill written for the agent, with an upstream loop**
  (`design/instructions/jam.md`): boot line first, then the raw run log in
  `design/.local/jam-logs/`, then the CLI's own headless auth check - fix what belongs to
  the workspace (a wrong `jam.agent`, a logged-out CLI), and file what belongs to marver
  at github.com/TNEP4/marver/issues with the evidence and, when debugging surfaced one,
  the patch. The give-up reply on the canvas now points at the same drill.

### Fixed

- **The daemon pins `PWD` to the workspace when spawning an agent.** `spawn(cwd:)` changes
  the directory but not the inherited env var, and some CLIs (opencode, verified) trust
  `PWD` over `getcwd` - a dev server whose own cwd differed from the repo root would have
  had the agent editing the wrong directory.
- **The early ack no longer leaks plan narration into the thread.** A first message like
  "On it...\n\nNow let me gather context: ..." posted the note-to-self along with the ack;
  a fenceless ack is now trimmed to its first paragraph (a fenced first message stays whole).
- **`/api/shot` is owner/token gated**, so a cross-origin page can't trigger the browser it
  spawns; the `marver shot` CLI sends the dev-session token, and the file-drop jam path is
  unaffected. It also renders from the dev server's actual listening address, not the
  client-supplied Host header. And a hung headless Chrome can no longer wedge the shot queue -
  a watchdog kills it past a deadline and settles every in-flight CDP call.
- **The working glow follows the agent to the frames it actually builds.** A comment on one
  frame whose answer is several NEW frames ("one frame per page") left the glow stuck on the
  commented frame. Jam agents have no shell to run `marver work`, so the daemon now moves the
  glow itself: it watches which frames the agent creates or edits during the job, lights those,
  and clears the commented frame once the agent is clearly building elsewhere.
- **Tighter agent jails, verified live.** grok's shell was actually reachable - its deny-list
  named `run_terminal_cmd` but the real tool is `run_terminal_command`, so the flag missed and
  a prompt-injected comment could run commands. grok now uses a read/edit tool ALLOWLIST (no
  shell, no web, no subagents - a name a deny-list can't miss). opencode runs `--pure` so a
  repo plugin can't execute outside its permission grant. Every other CLI's shell containment
  was re-checked against the real binary (Cursor's OS sandbox blocks network egress; pi and
  droid have no shell tool) rather than assumed. The Live Jam guide now states the trust model
  plainly: your own agent, on your machine, every diff reviewed - not an airtight sandbox.

## 0.9.0 - 2026-08-21

### Added

- **A Live Jam guide** (`docs/live-jam.md`), now that the feature arrives armed rather than
  opted into: how the agent is chosen and how to correct it, every key in the config block,
  what each of the two CLIs is allowed to do, where the trust boundary sits, and what to
  check when a mention does nothing.

### Changed

- **Live Jam is on by default, at concurrency 6.** Tagging `@marver` in a comment was the
  headline workflow and a config edit stood in front of it. Now it arms itself: the tool
  RUNNING the process wins (its env markers are evidence, and `init` is usually run by the
  agent), then whatever is on PATH, claude first. That last tie-break is a guess, which is
  why the answer is made visible rather than clever - `init` prints the agent it chose and
  writes it into `design/config.ts` in plain sight as
  `jam: { agent: "claude", concurrency: 6 }`, and the generated instructions have the agent
  confirm that line names the tool it actually is. One word to correct, once per repo.
  Workspaces that predate the block need no re-init; they resolve the same way at every
  dev boot. `jam: false` is the off switch, and `jam: "codex"` is shorthand for naming the
  agent. Six frames at once replaces three - at three, half of a multi-frame ask sat
  waiting on the other half while the human watched. With no agent CLI installed, jam stays
  off and both `init` and `marver dev` say so instead of going quiet.
- **A named agent is never quietly swapped, nor armed when it cannot run.** `jam.agent`
  naming something marver cannot spawn turns Live Jam off with a printed reason rather than
  detecting some other tool and answering the human's comments with it; the same applies
  when the named CLI is not on PATH, which used to claim every mention and then fail it. A
  `design/config.ts` that fails to parse also leaves jam off - it may have said `jam: false`,
  and arming a process spawn against intent we cannot read is the one wrong-way error worth
  avoiding.
- **`jam.subagents` does something now, and Codex fans out too.** The setting existed but never
  reached the spawned agent, which reads no config - so the parallel-frame policy is stated in
  the job prompt, and turning it off keeps a job on a single agent. The Codex adapter had also
  been marked as having no subagents; `codex exec` carries `collaboration.spawn_agent`, so a
  multi-frame Codex job now fans out the way a Claude Code one does. The prompt only ever says
  "you MAY", so an older CLI without those tools just works serially instead of failing.
- **Worth knowing, now that it is on by default:** the two agents are locked down differently,
  because their CLIs differ. Claude Code is spawned with shell access removed entirely
  (`--disallowedTools Bash`); Codex runs in its own `workspace-write` sandbox, which bounds
  what commands can *touch* but still lets the model run them. Both are confined to the
  workspace, and every change is a diff you review.

### Fixed

- **A one-message agent no longer posts the raw reply fence into the thread.** Live Jam posts
  the agent's first streamed message as an immediate ack. Codex emits a single message at the
  very end, carrying the completion block, and a fast Claude Code run can do the same - so the
  ack was the finished reply, fence and all, followed by a second message with the same words.
  The early path now normalizes exactly like the final one, which also makes the existing
  duplicate check catch it: one clean reply.

- **The jam ledger and journal are bound to the machine that wrote them.** Both live in
  `design/.local/`, which is gitignored and never synced - but gitignore is a convention,
  not provenance: a repo can force-add its own `.local/` and hand a clone a pre-authorized
  ledger plus a pre-baselined journal. Each line and file now carries a device stamp, so
  jam state that arrived with a clone is read as absent. The stamp is derived from the
  machine, not stored (marver writes nothing outside `design/`), so it stops one repo
  published to everyone rather than someone who already knows your machine - and the larger
  caution is unchanged either way: `marver dev` imports and executes `design/config.ts`, so
  running a dev server in a repo you do not trust is already running its code.
  One-time upgrade cost: an existing journal predates the stamp, so the first boot after
  upgrading rebaselines - any `@marver` mention left unprocessed while the server was down
  is marked seen instead of run. Re-comment to pick it up.

- **Comments wear the brand blue.** Pins, thread cards, the comment-mode pick cursor and
  the anchored-thread chrome move off systemGreen. Interact keeps purple, and green is now
  reserved for the done state alone - in dark mode the comment and done greens had drifted
  to the same value, so a frame carrying threads and a frame that had just landed a change
  looked alike. A pin, a thread card and a selected frame are told apart by shape.

## 0.8.1 - 2026-08-19

### Added

- **`marver work` - the chat agent's hand on the canvas.** The live working shimmer was
  exclusive to Live Jam; now any coding agent can drive it: create the frame files first,
  pin them on the board, `npx marver work start <scene/frame ...>` - the human sees the
  request land on the canvas in seconds, before the first component exists - build
  (independent frames in parallel, one subagent each), then `work done`. Marks are leased
  (default 10 min, max 30) so a crashed agent can never leave a frame glowing. The dev
  server writes `design/.local/dev.json` (port + per-boot token) as the CLI's discovery
  and credential; presence itself never touches disk. The generated AGENTS.md teaches
  the choreography.
- **`marver canvas` - a second name for `marver dev`.** Both start the same full local
  canvas (hot reload, comments, Live Jam, working state); `dev` reads naturally to
  developers, `canvas` to everyone else. There is no reduced mode behind either name.
- **Agents report marver bugs upstream.** The generated AGENTS.md now teaches the
  coding agent to file issues on the marver repo when the TOOL itself misbehaves
  (search first, `bug`/`enhancement` labels, version + expected-vs-actual + an
  abstract reproduction) - with privacy as hard law: issues are public, so nothing
  from the owner's repo (code, names, comment text, screenshots) may appear; failures
  are described in neutral terms or handed to the owner instead. The owner is always
  told what was filed. Every canvas becomes a field reporter, no user effort.

### Changed

- **The powered-by links carry automatic attribution.** Every canvas's marver.design link
  now ships UTM-tagged with zero setup: `utm_source` says which surface class sent the
  visitor (`published-canvas` / `dev-canvas`), `utm_medium=powered-by`, `utm_campaign` is
  the canvas's own name slugged (`marver-tour`), and `utm_content` names the placement
  (`gate` badge / `shell` wordmark).
- **`init` wires every agent in, and showing the work comes first.** The repo-root
  CLAUDE.md @-import has a sibling: init now also creates (or appends one pointer line
  to) a root AGENTS.md, so Codex-style agents inherit the canvas contract too. And the
  contract's Show-the-work section is stricter - making the request visible is the
  agent's FIRST act: skeleton frame created, pinned, and shimmering before research,
  reading the codebase, or planning begins.
- **Comments are frame-scoped now, and notifications reach you anywhere.** The client holds
  every board's comment log, not just the open board's: a thread pins to its frame wherever
  that frame appears - the all-scenes board finally shows every conversation - and a Marver
  reply landing on ANY board raises the notification pill no matter where you are, with View
  navigating to the right board and opening the thread. Replies and resolves route to the
  thread's origin log, so reading a thread from another board never forks it.

### Fixed

- **The jam shell ban is enforced, not just requested.** The Claude Code adapter now passes
  `--disallowedTools Bash` alongside its tool allowlist: `--allowedTools` only pre-approves
  tools, so a permissive inherited `settings.json` could have re-authorized shell. The
  documented boundary (no shell for untrusted comment text) is now explicit in the spawn.
- **The jam ack never narrates.** The agent's streamed first line posts to the thread
  verbatim - and sometimes that line was plan narration ("I'll start by acknowledging,
  then look at the board...") instead of a message to the owner. The packet now spells
  out that the first text ships verbatim and must address the owner, and the daemon
  backstops it: an unmistakable plan-narration first line is skipped and the next
  streamed text becomes the ack - a later tight ack, never a leaked plan.
- **`data-goto` follows a frame to its board.** Clicking a link whose target frame lives on
  another board used to SPAWN that frame onto the current board (mutating it - and in dev,
  saving the mutation). Navigation now follows the frame home: the canvas switches to the
  first curated board that pins the target, focuses it, and carries interact mode across the
  switch - links are navigation, never edits. A frame no board pins still spawns in place
  (the original single-board prototype behavior), and play mode is unchanged.
- **Comments no longer vanish across board switches and reloads.** Board nodes the file did not
  key yet were minted RANDOM keys on every load - and comments anchor to node keys, so any
  comment created on a never-saved board orphaned invisibly on the next mount (and on published
  canvases, which can never save keys back, on every visit). Keys are now deterministic
  (board + frame + occurrence), and a single thread-host resolver adopts threads whose stored
  key no longer holds onto the first node still showing their frame - a comment degrades to its
  frame, never to invisible, and never to two pins.
- **Old comment logs keep their origin.** Events written by 0.8.0 clients carry no `board`;
  they now get it stamped from the log they came from, so replying to an old thread can never
  route the reply into whatever board happens to be open.
- **Create-first frames land at their declared size.** A board node appended before the
  manifest registered its frame file was sized by the 390x844 guess - and the guess persisted.
  The size now corrects itself the moment the frame arrives, guessed sizes never reach the
  file, and authored sizes on temporarily-missing frames are never touched.
- **`marver init` no longer resurrects the demo scene.** Re-running init on a workspace with
  real scenes used to scaffold demo/ back next to real work; the demo now only lands on a
  first canvas.
- **Static canvases stop knocking.** A published canvas without collaboration used to poll
  the comments API forever (and retry an EventSource against it); the client now detects the
  static serve once and goes quiet.
- **No phantom comments on static canvases.** A published serve without `MARVER_DATA_DIR` used to
  let `/__mv/api/*` requests fall through to the static handler, which answered them with
  `index.html` HTTP 200 - the client read that as success, so a guest's comment echoed locally
  and silently evaporated on reload. The serve now refuses the API with a 404 JSON error the
  client surfaces as a toast.
- **The published shell wordmark honors `share.name`.** Deploy hosts build from anonymous paths
  (`/app`), so the sidebar read "App"; a declared `share.name` now names the shell like it
  already named the gate.

## 0.8.0 - 2026-08-19

Live Jam: tag `@marver` in a canvas comment and a local coding agent picks it up, edits the real
frame source, and replies in the thread - live. Plus a dev identity system and a full polish pass
on the comment thread experience.

### Added

- **Live Jam - the agent in the thread.** A daemon inside `marver dev` watches the comment logs:
  an owner-authored `@marver` spawns a headless agent (`jam: { agent: "claude" }` or `"codex"`)
  that reads the whole thread, edits the real frame source, and replies live - a streamed
  first-line ack within seconds (model provenance included), a look-around-before-asking clarify
  ladder, replies matched to your message's energy and length, follow-ups in an engaged thread
  triggering WITHOUT re-tagging, parallel jobs across frames, and crash-safe recovery: a batch
  killed mid-run (even by a server restart) resumes on the next boot from a durable journal.
  Every reply carries a provenance tooltip - dev user, harness, model.
- **A hard trust boundary.** Only the owner's device triggers: a device-bound ledger (keyed per
  board + comment id, never synced), a same-origin + cookie gate on every dev write (comments AND
  profile), and a recursion guard so agent replies never re-trigger. The agent runs locked down
  (Claude Code: no shell, Read/Edit/Write/Glob/Grep + WebSearch/WebFetch only; Codex: confined
  to its workspace-write sandbox) - and its reply is extracted structurally
  (the `marver-reply` block), so narration can never leak into a thread. Comment text is framed
  as untrusted data end to end.
- **The felt surface.** A frame being worked on wears the selection geometry in marver blue with
  a rotating shimmer, a top-to-bottom content wave, and a parallelogram shimmer matrix on its
  flank - phased per frame so parallel jams don't pulse in sync, held alive by a heartbeat for
  the whole job. Replies land as minimal notification pills (frame title + preview) that stack
  into a card deck at 3+, expand, clear, and jump you to the thread - delivered instantly over
  the dev websocket. Marver renders as its own participant with the blue mark avatar everywhere.
- **Dev identity + review controls.** Comments in dev render as "You" (green Y) until you set a
  profile - hover your avatar (pen on gray), "Set up your profile": name + photo, saved to
  `design/.local/` on your machine only; a connect account takes over name + email automatically,
  and account-less history re-renders as the live you. New shortcuts: ⇧L toggles "laser comment"
  (the element lighting comments paint in the artwork - anchoring stays precise with it off),
  ⇧C hides pins, both in stateful two-row tooltips; Prototype view moved beside Hide UI.

### Changed

- **The thread card grew up.** World-parked beside its frame with pin-style screen-constant
  scaling, height rules that respect the frame, content-mask scroll fades, a custom glass
  scrollbar riding the card's far edge (action buttons never collide), and a stage-docked
  position in Play that re-docks on device switches. The composer centers its text exactly,
  renders `@marver` bold WITHOUT caret drift (metrics-safe text-stroke), and the send button is
  reliably clickable.
- Laser/comment hover lighting leaves a frame together with the pointer - no fossilized outlines
  on frames the cursor crossed; the expanded notification list no longer clips pill shadows.

## 0.7.0 - 2026-08-17

Prototype mode becomes a first-class review surface. The prototype (Play) now carries the same toolbar
as the canvas, laser and comments work INSIDE it, and every comment wears the colour of the element it
points at - the groundwork for tagging a coding agent from anywhere you review.

### Added

- **The prototype is a review surface, not just a viewer.** Play's top-right toolbar is now the SAME
  controls as the canvas - device switch, theme, laser, comment - built from one shared set of
  components so the two can never drift. Laser and comment work inside the running prototype: the stage
  runs the same element inspector the canvas frames do, so you can point at, highlight, and comment on
  the live app while you walk a flow. The bottom-left navigator (restart / prev / i-of-N / next) stays.
- **Hide UI (H).** One binary toggle hides all chrome for a clean point-and-shoot frame, shared by the
  canvas and the prototype. No auto-fade, no hover magic; a page refresh always brings the chrome back
  (the safety net for a forgotten shortcut). It replaces the prototype's old three-state auto-hiding bar.
- **Comments wear their element's colour.** Comment mode reuses laser's per-element depth hue: the
  element you hover, the composer, the pin, the thread card, and the active-element highlight all take
  that specific element's colour - a comment on a blue heading reads blue, on a green button green. The
  avatar keeps the commenter's own colour; filled buttons use a hue-aware shade so the glyph stays legible.
- **The commented element lights up.** Picking an element locks a persistent outline on it (the highlight
  stops chasing the mouse while you compose), and opening a thread re-lights its anchored element - so
  everyone sees exactly which element a comment is about. It clears on close.

### Changed

- **Prototype chrome is discreet and reliable.** The prototype's floating toolbar wears the same quiet
  dark skin as the bottom-left navigator, so it recedes into the stage instead of reading as a bright
  slab; and it no longer auto-hides or sticks under the cursor - it behaves exactly like the canvas pill
  (explicit collapse, Hide-UI, no surprises).
- **Prototype is an action, not a menu item.** The Prototype-view button moved into the canvas pill's
  action group (beside comment, laser, tidy), leaving the far right purely for UI management (Hide UI,
  collapse).
- **The element label reads clearer.** The laser/comment element tooltip now sits below-left of the
  cursor with a gap - clear of the element you are pointing at - and slides in from the edge instead of
  being clipped.
- **Escape exits laser mode**, matching comment mode.

### Fixed

- **Canvas comment highlight is now reliable.** A frame hosting an open thread or a draft shows its LIVE
  app rather than the frozen lean snapshot, so the active-element highlight appears, updates, and clears
  in real time - it used to be intermittently missing, or frozen after close, depending on snapshot
  timing. A clean snapshot rebuilds once the thread closes.
- **Highlights only show while a thread is active.** Closing a thread or hiding pins (Shift+C) clears the
  element highlight; a remotely-resolved thread no longer strands one.
- **Prototype comment overlay positions faster** after a walk and never renders behind the frame or off
  screen. Element-hue values, message origins, and stage-swap timing are all validated.

## 0.6.0 - 2026-08-17

Image-heavy boards, done right. A board full of high-resolution screenshots now zooms fast and stays
crisp, images render in FULL instead of cropped, content frames size themselves to their content, and
the switcher opens on a tight landing board instead of loading every frame at once.

### Added

- **Client-side image level-of-detail (LOD).** A board of 150+ high-res screenshots used to jank hard
  on zoom - the real cost was decoded memory, not file size (a 2708x1610 PNG is ~17MB decoded, so 174 of
  them held ~3GB of bitmaps the browser resampled every frame). Each `Img` now decodes STRAIGHT to its
  on-screen size via `createImageBitmap` and paints on a canvas; bitmaps freeze during a pan/zoom and
  re-pick resolution only when the gesture settles (the tldraw pattern). Result on a 174-image board:
  ~26MB decoded at overview vs ~3GB before (~100x less), lag-free zoom, crisp detail when you stop.
  Falls back to a plain `img` where `createImageBitmap` is unavailable.
- **Board ranking and a fast landing board.** Boards carry an `"order"` field; the switcher ranks curated
  boards by it and always sinks the auto `all-scenes` everything-board to the BOTTOM. A fresh open now
  lands on the FIRST curated board - a tight, fast board and a good first impression - instead of
  rendering every frame at once. Rank boards deliberately; the first is what people see first. `order`
  survives the shell's autosaves.

### Changed

- **Reference images show in FULL.** `Img` no longer cover-crops to a fixed height (that sliced the
  sides off every screenshot). Each image fills its column at its natural aspect ratio - never cropped,
  never letterboxed - so same-aspect screenshots line up on their own and the frame auto-heights to fit.
  Size an image by how many share its `Row` (fewer = bigger), not by a fixed height; `h` is accepted for
  back-compat but no longer constrains size. A clean inset hairline (grayscale, light + dark) sits on the
  image's own edge, overriding a screenshot's ragged or baked-in border instead of framing it twice.
- **Content frames fit their content when you resize.** A manual WIDTH resize now keeps the HEIGHT auto:
  the frame reflows and refits to show everything, instead of freezing at a stale height (only an explicit
  device viewport locks it). The content-frame height cap was raised so a long reference doc renders in
  full rather than clipping, and zoom now reaches 500% for inspecting screenshot detail.
- **Authoring doctrine updated to match.** The scaffolded instructions now teach sizing images by row
  grouping instead of cropping, and ranking boards with `order` (first = landing, `all-scenes` is heavy
  and auto-last).

### Fixed

- **No jiggle on zoom.** An image's display aspect-ratio is pinned on first decode, so an LOD resolution
  switch changes only the pixels, never the layout box - frames no longer drift as you zoom.
- **Fast zoom no longer stalls frames.** The LOD re-decode is debounced past the gesture and drops queued
  work when a new gesture starts, so oscillating zoom-in/out never stacks decode waves and times frames
  out to a ready-timeout.

## 0.5.0 - 2026-08-15

The performance & fidelity release (SPEC-M5): the canvas stops jiggling. Moving around a board no
longer swaps between two documents on every pan/zoom - each passive frame renders as a lean DOM
snapshot that IS what you see, and the real live app takes over the moment you interact with it.

### Added

- **Lean-primary rendering.** Every passive frame shows a **DOM snapshot** - a self-contained static
  copy of the frame (real DOM + real CSS, zero JavaScript) served in a `sandbox="allow-same-origin"`
  iframe. It reflows on resize with the browser's own layout engine and carries the app's exact colors
  (no rasterisation), so panning, zooming, and device-sweeping a board is smooth and pixel-honest. The
  full live app sits underneath and swaps in instantly when you focus a frame (double-click), or in
  laser/comment mode. This replaces the earlier screenshot facade, which invented colors and jittered.
- **Publish parity.** The lean tier now works in published builds (`marver build` → `marver serve`),
  not just dev - captured client-side from the bundled same-origin frames, no build-time renderer.
- **Faster first paint.** Leans capture bounded-parallel and viewport-first, so the frames you're
  looking at appear first and a big board settles in seconds instead of tens of seconds.
- **Content-frame color families.** Tag a diagram node with a built-in family - `HQ:::blue`,
  `Carriers:::orange`, `Drivers:::purple` (also `green red gray`) - and it gets a filled, on-brand
  color with a legible border in both themes, no `classDef` boilerplate. The same six names work in
  `Md` prose as `:blue[the shipper's world]`, so a sentence and the diagram beside it read as one
  color language.
- **`Head :: gloss` diagram labels.** A node label written `Head :: gloss` renders the head bold on
  top with the gloss lighter and smaller below - a box scans as label-then-detail, no run-on.
- **Authoring doctrine that ships with the tool.** The scaffolded instructions
  (`instructions/shape.md`, `instructions/reference/color.md`) now teach an agent these conventions -
  the `::` label hierarchy, the `:::family` / `:blue[…]` palette, and "pick one family per concept and
  hold it" - so diagrams and highlighted prose come out consistent by default instead of hand-rolled
  hex and one-off `classDef`s.

### Changed

- **Sidebar header** shows the humanized repo name (`marver-pilot` → "Marver Pilot", ellipsed if
  long); the logo links to marver.design.
- **Sidebar board/scene labels** are humanized - kebab filenames render Title Case (`crm-specs` →
  "Crm Specs"), dropping the dashes, while an explicit `meta.title` is honored verbatim.
- **App cursor** is the marver arrowhead - tilted, rounded, small, soft-shadowed, and theme-adaptive
  (black-on-light / white-on-dark); reverts to a normal pointer in interact/prototype and keeps the
  pin/crosshair in comment/laser mode.
- **Copy-file-path shortcut** moved to `Shift+P` (was a mislabeled `C`).

### Fixed

- The canvas "jiggle" - text shifting ~1-2px when you click or zoom a frame - is gone; there is no
  longer a per-gesture document swap to shift it.
- Mermaid diagrams no longer pop in/out or flash the wrong theme during zoom (async render is awaited;
  a diagram's baked colors re-capture on theme change; the cover's color-scheme is pinned to the
  frame theme, not the viewer's OS).
- A frame you've scrolled, typed into, or themed re-captures faithfully; agent edits (HMR) drop the
  stale snapshot and rebuild; slow data that lands shortly after load triggers one bounded re-capture
  (data that changes much later shows live the moment you focus the frame, and the lean rebuilds when
  you leave it).

### Known limitations

- Memory targets typical authoring boards (~15-20 frames); dozens of heavy production apps need the
  bounded-residency milestone. A frame the serializer can't render faithfully (canvas/video/open- or
  script-created-closed shadow-DOM/nested-iframe/cross-origin-CSS/blocked-CSP/oversized) degrades to
  live automatically. (One narrow edge: a declarative closed shadow root can't be detected and may
  render stale - rare in practice.)

## 0.4.0 - 2026-08-14

The collaboration release (SPEC-M3): the canvas becomes a place where colleagues,
the designer, and the coding agent close the feedback loop together.

### Added

- **Element-anchored comments.** `C` enters comment mode: click any element inside a
  frame (laser outlines guide you) and the thread pins to it - fractional position
  inside the element's box, so pins ride through responsive reflow. Threads are
  Google-Docs-shaped: root + one level of replies, resolve/reopen. Anchors survive
  agent edits via a verified ladder (semantics → CSS path → fuzzy quote match);
  a dead anchor parks the thread visibly at the frame edge, never silently deleted.
  Inactive frames collapse their open threads into a top-right avatar stack.
  `Shift+C` hides all pins; `?c=<thread>` deep-links a specific thread through the
  password gate (copy-link on every card).
- **Real commenter identity, no email infrastructure.** Viewers on a published canvas
  claim an account through a single-use invite link (owner mints it; the link travels
  over Slack/DM) - display name, password, avatar. Accounts are scrypt-verified with
  per-user salts; sessions survive restarts. The first account owns the canvas;
  `MARVER_OWNER_EMAIL` prints the owner's one-time claim link in the deploy logs.
  Avatars fall back to initials on a deterministic color.
- **Gate v2: one credential per persona.** The gate on a collaboration canvas has
  three doors: guests pay the canvas password (read-only), members sign in with
  their OWN password (their session IS gate passage - they never touch the shared
  secret), and an invite link (`<url>/#/i/<token>`) opens straight into the claim -
  email shown as an INVITED chip, profile-picture picker (client-side 128px
  downscale), display name, password. Sign-in/claim endpoints sit in front of the
  gate (rate-limited, non-enumerating); rotating the canvas password only ever
  affects guests. Primary buttons stay disabled until their mandatory fields are
  filled, with a tooltip naming what's missing. The boards payload carries the
  owner's display name, so a read-only refusal says who to ask. Static canvases
  keep the single-field gate untouched.
- **One deploy, comments live everywhere.** `marver serve` grows a collaboration API
  (REST + SSE) when `MARVER_DATA_DIR` names a durable volume; the published canvas is
  the comments' home. `marver dev` two-way syncs every 30s (`marver comments connect
  <url>` once), so client feedback lands in `design/comments/<board>.jsonl` - a
  git-tracked, append-only event log the agent reads with zero tooling. Republishing
  never clobbers collected feedback (the store unions the bundle seed on boot).
- **The agent works the queue.** `marver comments list --open --json` / `reply` /
  `resolve --addressed-in <frame>` - resolving records which variant answered the
  feedback, making the fork-don't-overwrite doctrine auditable. `marver comments
  invite <email>` mints single-use invite links from the CLI (owner only), `revoke
  <email>` retires an account. `instructions/iterate.md` carries the
  comments-as-work-queue discipline; `instructions/publish.md` is the agent-facing
  deploy runbook (boards policy, gate, volume, accounts) and AGENTS.md routes to it.
- **Laser mode.** `L` (or the toolbar crosshair) outlines every element in every frame
  with depth-hued borders (60° per nesting level) plus a DevTools-style hover label.
  Zero layout shift - outlines only. Clicking an element copies its full address for
  the agent - frame source file + CSS path (+ JSX source location when stamped).
  Comment mode shows only the hover highlight (no full rainbow) and a chat-teardrop
  cursor, so picking an element to comment on stays calm.
- **Default-closed publishing.** `marver build` now requires a publish policy:
  `design/publish.json` names each published board with `read` or `comment` rights
  (enforced server-side, not just hidden in UI). `--boards a,b` stays as an explicit
  override; publishing everything takes a deliberate `--all-boards`.

### Changed

- **`c` is comment mode now** (the Figma/Miro convention). Copy-selected-file-paths
  moved from `c` to `y`.
- `marver build` without a publish policy fails with instructions instead of
  publishing everything - the privacy default flipped closed.

### Security

- Comment mutations are CSRF-protected (double-submit cookie + origin checks) and
  rate-limited; session and invite tokens are stored hashed; every pushed event is
  validated hard (author must match the session, thread ids cannot be hijacked,
  edits are owner-only, timestamps cannot come from the future) - and accepted
  events are never rewritten, so id-keyed sync converges byte-identically.
- v1 trust boundary, stated plainly: frame code in your design repo runs same-origin
  with the shell - review what you merge. Full frame sandboxing is the v1.1 follow-up
  (SPEC-M3 §0 records the probe results and the plan).

### Durability & concurrency

- Comment appends and auth writes are `fsync`'d before they are acknowledged - a
  comment or account confirmed to the client survives a crash or volume interruption,
  not just the page cache.
- `auth.json`'s read-modify-write is guarded by a cross-process lock (stale-stolen
  after 10s, never deadlocks) so a deploy overlap or an accidental second instance
  cannot resurrect a revoked account or drop an invite. The comment log needs no lock:
  append-only + id-keyed union is conflict-free by construction (and git merges it
  with `merge=union`). Two honest v1 limits, documented not hidden: thread ordering
  uses client timestamps (a badly-skewed clock can mis-order a resolve/reopen race -
  re-resolve to fix), and comment logs have no hard size ceiling (fine at the design-
  review scale marver targets; a per-board cap is a later concern).

## 0.3.1 - 2026-08-13

### Fixed

- Play-mode variant chrome: the current variant's name was invisible (theme ink on the always-dark glass pill - now the pill's own light ink), and switching variants jiggled the controls. Redesigned: the letter chips now use the sidebar's exact badge language (20px, 7px-radius, one shape in every state) so the two surfaces read as one concept, they LEAD the cluster as the stable anchor, and the name trails at natural width (capped with ellipsis + a tooltip carrying the full title) - a name change grows the pill rightward without moving anything underfoot.

## 0.3.0 - 2026-08-13

The co-thinking release: the canvas now holds the thinking, not just the screens.

### Added

- **Content frames (SPEC-026).** Specs, Mermaid diagrams, and mood boards as ordinary frames beside UI frames - import `Doc`, `Row`, `Col`, `Space`, `Md`, `Diagram`, `Img` from `@marver-design/marver/content`. Works in a repo with no app at all: idea first, design second.
  - `Doc` auto-sizes the frame to its content (measurement protocol; auto sizes are session-transient, manual resize and device views still win). Published canvases keep parity.
  - `Diagram` is first-class Mermaid, lazily loaded - a workspace with no diagrams ships zero mermaid bytes. Source theme overrides are stripped; parse errors show an in-frame card and heal live.
  - `Md` renders theme-aware markdown; `[label](goto:scene/frame)` links jump the canvas. Raw HTML is inert, images are local-only.
  - `Img` shows `design/assets/` imagery with captions; `h={n}` cover-crops a mixed-aspect row to one height so it reads aligned.
  - Zero-external-request boundary: URLs are rejected in diagram source, rendered SVG is sanitized, published builds copy only referenced local assets.
- **The marver diagram theme.** Full Apple system palette (12 series colors + systemGray ramp, exact HIG light/dark pairs), system font stack, accent-washed nodes by default - a plain flowchart is never gray-on-gray. Label typography rides inside the SVG (measured, not post-styled).
- **Frame intent.** Content frames declare `intent` (`diagram` | `spec` | `moodboard` | `notes`); the sidebar shows a glyph per row - every row leads with an icon, variant groups carry the flask.
- **Sidebar tells the canvas's story.** Rows and scene groups order by canvas position, not file order.
- **The onboarding fork (SPEC-025 amendment).** Both first-session paths - empty repo and existing app - now stop and ask what the highest priority is: think the idea through together on the canvas, or go straight to screens.
- **Shape & Iterate doctrine.** `instructions/shape.md` (feature-story boards: specs → lo-fi → hi-fi with graduated spacing) and `instructions/iterate.md` (fork-don't-overwrite, letter variants, the archive ritual).
- **Craft doctrine hardened.** Real assets are binding (Phosphor icons by default, actual brand logos, fetched imagery). Interactive means visibly interactive at every fidelity - cursor + hover on every clickable target, component-library gaps (shadcn on Tailwind v4 ships `cursor: default` buttons) fixed at the design-system base layer.

### Changed

- Markdown typography moved to the HIG scale: 16px body on 1.65, tightened heading tracking, contained Notion-style tables, re-asserted list markers (Tailwind preflight strips them in host apps).

## 0.2.4 - 2026-08-13

- Onboarding as a conversation (SPEC-025): setup flow asks what you're building, proposes a stack (a recommendation, not a requirement), hosted tour canvas as the waiting room, local canvas as the reveal. Two dogfood rounds folded in.

## 0.2.3 - 2026-08-12

- Hardening release: live-JOIN adjacency, same-directory group invariant, tsx-only inference, extractor boundaries, sceneRows dedupe, play-mode chrome fixes, extreme-zoom badge fade.

## 0.2.2 - 2026-08-12

- Update discovery: glass pill + stdout notice + daily registry check (opt out with `MARVER_NO_UPDATE_CHECK=1`). `design/` collision guard on init.

## 0.2.1 - 2026-08-12

- The dogfood friction release: all 23 logged friction issues triaged; bugs fixed.

## 0.2.0 - 2026-08-11

- First public release on npm as `@marver-design/marver`, Apache-2.0. The agent-native design canvas: `design/` folder, live frames from your app's real components, boards, device sweeps, play mode, published canvases with a password gate.
