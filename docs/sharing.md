# Sharing a Marver canvas

[Publishing](publish.md) decides which boards ship and how a canvas is gated.
**Sharing** decides who gets in and who may comment - person by person, from the
terminal or the browser.

The one thing worth holding in your head: **there is a single pure function that
answers "what can this person do here", and the doors that enforce access all
call it.** The gate, comment writes, and the browser dialog's owner routes read
from the same `share.json` and the same resolver, so the policy is one thing in
one place, not a rule re-implemented per door.

> **Sharing needs a place to keep the roster.** `marver share` and the dialog
> manage a roster of *people*, which needs three things: `MARVER_DATA_DIR` (a
> persistent volume for `share.json`), an **owner account** on the canvas, and
> the owner's **device credential** (`marver comments connect`, authenticated
> with `MARVER_CLI_TOKEN` on an identity canvas - see the
> [publishing guide](publish.md#marver-sign-in-marver_id_issuer---recommended-for-teams)).
> With those, a canvas gated by a **password** supports exact-email grants
> today. **Marver Sign In** adds what only a verified identity can do: domain
> grants (`@acme.com`), the request-access flow for refused visitors, the
> hosted browser dialog, and the front door. A password canvas without
> `MARVER_DATA_DIR` is one shared secret and nothing to share person by person.

## The inputs sharing combines

Access is built from a few inputs, and the resolver combines them in one fixed
order (the precise order is in [How access is computed](#how-access-is-computed-the-resolver-precisely) below):

1. **The blocklist** - the only *deny*, applied first. Its reach is narrower than
   it sounds; see the note under `block` below.
2. **The owner** - the canvas owner precedes principal matching and can always
   open and administer the canvas.
3. **Grants** - who was let in and at what level (`view` or `comment`), optionally
   until a date. Grants are *additive*: the highest matching grant wins.
4. **General access** - the floor for anyone admitted: `private`, `password`, or
   `public`. What you can actually select is clamped by the gate you run (below).

Every result is then **clamped by the board's published ceiling** - `publish.json`
says a board tops out at `read` or `comment`, and no grant can exceed it. A grant
of `comment` on a board published `read` resolves to `view`.

## `marver share` - the roster from the terminal

`marver share` calls the same owner-only routes the browser dialog does,
authenticated with the device credential [`marver comments connect`](publish.md#marver-sign-in-marver_id_issuer---recommended-for-teams)
stored. Connect once as the owner, then:

```bash
marver share add sam@acme.com                    # grant view (the default)
marver share add sam@acme.com --role comment      # grant comment instead
marver share add sam@acme.com --expires 2027-06-01   # a grant that lapses on its own
marver share add @acme.com --role comment         # any verified @acme.com address (identity canvas only)
marver share remove sam@acme.com                  # take the grant back

marver share block troll@spam.com                 # see the note below - narrower than it reads
marver share unblock troll@spam.com

marver share general private                      # the stored floor (the gate may clamp it, below)
marver share general password
marver share general public

marver share list                                 # the roster: general access, grants, blocklist
marver share requests                             # pending access requests
marver share requests --approve sam@acme.com      # grant them - canvas-wide, at view
marver share requests --approve sam@acme.com --role comment
marver share requests --decline sam@acme.com      # resolve it silently - no rejection reaches them

marver share explain sam@acme.com                 # the resolver's trace for one person (see caveats)
marver share who                                  # granted principals x published boards
```

**`block` is narrower than "refused everywhere."** The blocklist is the first and
only deny *inside the resolver*, but two things sit outside it, and the CLI says
so when you block: **"Blocking only bites while general access is Private."** If
general access is `password` or `public`, the same person can still enter
anonymously - there is no identity to block at an anonymous door. And a canvas
**owner** is admitted ahead of the blocklist (someone must be able to administer),
though comment authorization can still deny them. Blocking reliably denies an
*identified, non-owner* person and their access requests; it is a complete entry
denial only while general access is private.

**`explain` and `who` are convenience views, not the enforcing trace.** They run
the real resolver, but the *CLI* runs it locally over the roster it fetched, and
it takes three shortcuts the enforcing doors do not:

- it does not pass the owner role, so a fresh owner with no grant of their own is
  explained as an ordinary ungranted person (the server's own `explain` route
  fills the owner role in; the dialog is the accurate view for the owner);
- it treats a `@domain` argument as having no address to match, so a domain row
  in `who` shows `(per member)` rather than an effective role;
- it prints each step's role but not which step *won* - the resolver marks a
  winning step, and the CLI renderer drops that mark, so read the trace as the
  inputs, not a highlighted verdict.

So `explain <exact-email>` for an ordinary granted person is reliable and matches
what the gate does; for the **owner** or a **`@domain`**, read it as a sketch and
trust the dialog. `who` lists *granted principals* down the side (not the owner,
who holds no grant row), the blocklist, and - when general access is open - an
anonymous row; it is the grant matrix, not a census of everyone who could get in.

Domain grants (`marver share add @acme.com`) need Marver Sign In: a canvas that
cannot verify who holds an address cannot verify their domain.

## `publish.json` v2 - the ceiling, and the board's shape

`publish.json` is where a board's **ceiling** lives - the most any grant can
resolve to there - and, in the v2 row shape, a few facts about how the board
presents. Every 0.11 canvas parses unchanged: a bare `"read"` or `"comment"`
string is still a valid row. (This is a **schema** version; it is unrelated to
the read-privacy work also called "v2" further down.)

```jsonc
{
  "boards": {
    "roadmap": "comment",                    // v1 row: the ceiling, nothing more

    "brand": {                               // v2 row: an object
      "max": "read",                         //   required - the ceiling ("read" | "comment")
      "type": "design",                      //   optional - the artifact type (default "mix")
      "open": "focus",                       //   optional - the landing view
      "lock": true                           //   optional - freeze the landing view (needs "open")
    }
  },
  "reveal": { "structure": true, "source": false }
}
```

- **`max`** (`"read"` | `"comment"`) is the ceiling. This is the only field that
  affects *access*; everything else is presentation.
- **`type`** is one of `doc`, `slides`, `design`, `sketch`, `refs`, `mix`
  (default `mix`). It picks the board's default landing view and its card icon;
  nothing infers a type from content.
- **`open`** names the landing view. The parser accepts five names - `canvas`,
  `board`, `present`, `focus`, `slides` - but not all are distinct surfaces yet:
  today `canvas` and `board` both land on the canvas, `present` and `focus` are
  their own modes, and **`slides` currently aliases `present`** (slides mode is
  v1.5). Absent means the type decides.
- **`lock`** freezes the canvas in the `open` view (no view switcher). It
  requires `open` - freezing an unnamed mode is meaningless, so the build refuses
  it.
- **`reveal.source`** defaults **off** on a published canvas: the bundle would
  otherwise carry every frame's repo path, which is a disclosure the moment a
  canvas is shared beyond its own repo. `reveal.structure` defaults on.

Publishing stays **default-closed**: no `publish.json` and no explicit
`--boards`/`--all-boards` flag means nothing ships. A board absent from the
policy is absent from the bundle - which is also the read boundary in v1 (see
["What v1 does not do"](#what-v1-does-not-do)).

## General access, and what your gate can enforce

`marver share general <mode>` is clamped to what the **gate you run can actually
enforce** - and it is clamped when you *set* it, not when access is resolved. When
you ask for more than the gate allows, the owner API stores the operative
(clamped) mode, and the CLI tells you what it stored and why, so the roster never
holds a state the server cannot enforce:

| Gate you run | `private` | `password` | `public` |
|---|---|---|---|
| **Marver Sign In** (`MARVER_ID_ISSUER`) | private | private | private |
| **Password** (`MARVER_PASSWORD`, no issuer) | private | password | password |
| **No gate** (neither set) | public | public | public |

So on an identity canvas general access is always `private` - membership is the
whole point, and there is no anonymous door to open. On a password canvas,
`public` clamps to `password` (the password would otherwise be theater). A canvas
with no gate is `public` by definition. When the CLI clamps your request it tells
you what it stored and why.

## `share.json` - the grant store

The roster lives in `share.json` on your volume (`MARVER_DATA_DIR`), beside
`auth.json`. It is a plain JSON file on the server, written mode `0600` (readable
by the OS account running Marver, not by a browser owner - browser owners inspect
it through the CLI or the dialog, both of which go through the owner API). You
rarely touch it by hand, but three things about how it behaves are worth knowing:

- **It is created once, at serve boot, from your live 0.11 state.** Every existing
  account gets a canvas-wide `comment` grant (clamped per board) because that is
  exactly what they could do the day before. Until that first boot, every door
  falls back to the legacy rules it always had - upgrading changes nothing you
  did not ask for.
- **A grant carries a per-board ratchet, not just a role.** A grant records what
  you *asked for* (`assigned`) separately from what each board currently resolves
  to (`boardRole`). Reads always take `min(current ceiling, boardRole)`, and every
  boot re-clamps entries *down* to the ceiling, never up. So raising a board's
  ceiling later does **not** silently re-promote everyone who was granted under
  the old, lower one - the entry stays low until you explicitly re-confirm it.
  This is the non-promotion invariant, and it is the reason a ceiling change is
  always safe.
- **It fails closed.** A present-but-corrupt or malformed `share.json` denies
  rather than falling back to open - a policy typo must never quietly grant the
  ceiling. A *missing* file is the pre-migration signal and keeps legacy rules; a
  broken one stops the doors.

## Access requests - when someone refused wants in

When a person is refused at the identity gate, the canvas offers them a request
form instead of a dead end. The refused visitor has no session to authenticate
with, so the canvas mints a **short-lived, origin-bound, single-purpose request
token** and accepts a request only against it (the `marver-reqaccess+jwt`
contract). The request lands as one pending row per address:

- it surfaces in `marver share requests` and in the dialog's requests list;
- **approving grants canvas-wide at the role you choose** (`view` by default) -
  in v1 an approval covers every published board, and the CLI and dialog both
  say so;
- **declining resolves the row silently** - no rejection email reaches the asker;
- a repeat ask from the same address replaces its note, it does not pile up a
  second row, and a row expires on its own after 30 days.

## The front door (`app.marver.design`)

The front door is the signed-in home page at `app.marver.design`: a person signs
in once and sees the canvases they can reach, each row lit by a short summary the
**canvas itself signs and serves**. The front door holds no roster and makes no
access decision - it asks each canvas, and each canvas answers for itself.

For a canvas operator there are two things to know:

- **Your canvas answers its own summary probes, and only signed ones.** The front
  door presents a `marver-summary+jwt` (audience = your exact origin, authorized
  party = the app, valid ≤120s); the canvas verifies it against the identity
  service's published keys before answering, and the answer is signed by the
  canvas so the browser can pin it. Owner mutations from the dialog carry a
  separate `marver-owner-api+jwt` (≤300s), and outbound mail rides a
  `marver-relay+jwt`. You do not configure any of this - it is the wire, listed
  so you can recognize it.
- **You can keep your canvas out of it.** `share: { frontDoor: false }` in
  `design/config.ts` makes the canvas stop answering front-door identity and
  summary probes - the app receives no signed summary from this canvas, so it has
  nothing to show. The privacy tradeoff around the front door is disclosed in full
  in the [publishing guide](publish.md#who-can-open-your-canvas); this is the
  switch that makes your canvas silent to it.

## How access is computed (the resolver, precisely)

For anyone who wants to check rather than trust, here is the exact order the one
resolver (`resolveAccess`) runs, top to bottom:

1. **Blocklist.** If the address is blocked, every board is `none` and the person
   is refused, and nothing below runs. (An anonymous caller - past a password
   gate, or on a public canvas - has no identity to block, so this step never
   fires for them, which is why blocking does not stop anonymous entry.)
2. **Owner.** The canvas owner precedes principal matching and resolves to
   `comment` on every board - still clamped by the ceiling, so an unpublished
   board is empty even for the owner.
3. **Grants, additive, highest wins.** Every live grant matching the address
   (exact, or by verified domain) contributes its `boardRole`, read through the
   read-time ceiling `min`. The highest contribution per board wins.
4. **General access.** If the operative mode is not `private`, everyone admitted
   gets `view` as a floor.
5. **Ceiling clamp.** Every board's result is `min(result, publish.json ceiling)`.

`entry` (may they open the canvas at all) is "at least `view` on at least one
board". Note the gate's own entry check short-circuits step 1 for the owner - the
owner is always admitted so the canvas can be administered - which is the one
place the blocklist does not have the last word.

## What v1 does not do

Sharing v1 controls **who gets in** and **who may comment**. It does **not** yet
do per-person *read* privacy: every admitted person can read every published
board. The read boundary in v1 is the bundle itself - a board you do not publish
is not in the build, so the way to keep something from an audience today is a
separate canvas for that audience. ("v2" here means this next release, the
read-privacy one - a different thing from the `publish.json` v2 *row schema*
above, which ships now.)

Three consequences, stated plainly because they are easy to assume otherwise:

- **Grants are canvas-scoped.** `share.json` is already shaped for board-scoped
  grants, but the CLI and dialog accept `canvas` scope only - a board-scoped grant
  would open the whole bundle while reading as "just this board", so the door
  refuses it until read privacy makes it real.
- **Approvals are canvas-wide.** An approved access request covers every published
  board, and the surfaces say so. The request records what the refused link
  pointed at, but that target is context in v1, not an enforced scope.
- **A deep link is presentation, not a wall.** A single-frame or single-board
  link lands that visit in the right view, but the rest of the canvas stays
  reachable by URL. The door renders because there is one frame to show, not
  because the others are protected.

All three become enforced in the read-privacy release, when boards are *served*
per person rather than *bundled*. The schema is already ready for it; v1 declines
the operations it cannot honor rather than pretending to.
