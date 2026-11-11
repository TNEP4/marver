# Marver for Mac

Marver for Mac shows every canvas you run on this Mac in one window, a tab each, and tells you when one needs you.
It shows the canvases you run and starts none: a canvas still runs from its repo with `npx marver dev`, and stops
there. A shared canvas's https link opens in a tab of its own too.

**[Download Marver for Mac](https://github.com/TNEP4/marver-app/releases/latest/download/Marver-arm64.dmg)** ·
Apple silicon · macOS 13 or later

Help > Marver Help opens this page. The app's source is [`app/`](../app) in this repository; its releases, each with
what changed, are in [TNEP4/marver-app](https://github.com/TNEP4/marver-app/releases).

## What it needs

- **A Mac with Apple silicon and macOS 13 (Ventura) or later.** On an Intel Mac, or on macOS 12 or older, it does not
  open at all ([below](#on-an-intel-mac-or-an-older-macos)).
- **Canvases on Marver 0.27 or later.** They show in the app, a tab each, and closing, reloading or quitting asks
  before losing their unsaved work. Marks, notices and live pictures need **0.29 or later**, the version to use with
  the app. A canvas on 0.26 or older does not appear: update it with `npm i -D @marver-design/marver@latest`.
- **Marver 0.32 or later, with app 1.2,** for Home to name the board an agent works on and for how long, and for Hide
  UI to take the whole window in play ([Hide UI in play](#hide-ui-in-play)).

## Install

1. Download [Marver-arm64.dmg](https://github.com/TNEP4/marver-app/releases/latest/download/Marver-arm64.dmg)
   (Apple silicon · macOS 13 or later). Every release has this name, so the link always fetches the latest; the disk
   image it opens is named for its version, "Marver 1.0.0". Safari may first ask whether to allow downloads from
   GitHub's download site: allow it.
2. Open it and drag Marver onto Applications.
3. Eject the disk image.
4. Open Marver from Applications. macOS asks once, because the app was downloaded: whether to open an app
   "downloaded from the Internet", adding that "Apple checked it for malicious software and none was detected".
   Marver is signed with a Developer ID and notarised by Apple. Choose Open; that is the only question.

**Opening it straight from the disk image works too.** macOS asks there first (Open, Show Disk Image, Cancel). Marver
then moves itself into Applications without asking, quits and opens from there, so macOS asks its question a second
time, at the copy in Applications. Dragging it in first saves that second question. Once moved, the tab strip says
once: "**Marver moved itself to Applications.** You can eject the disk image." Opened from another folder, such as
Downloads, Marver moves itself the same way and says "You can delete the copy in Downloads." It never deletes the copy
it came from.

**When something is already in Applications**, Marver moves nothing. It says what it found, and what to do:

| In Applications | Marver says | Then |
|---|---|---|
| a Marver of this version or newer | "Marver 1.0.1 is already in Applications" | "Open it, and this copy quits. You can delete this copy afterwards." Open It or Cancel |
| an older Marver | "An older Marver (0.3.0) is in Applications" | "To replace it, drag this Marver into Applications and choose Replace." Show Both or Cancel |
| another app named Marver | "Another app named Marver is in Applications" | "Marver doesn't replace it. Move it out of Applications, then drag this Marver in." Show Both or Cancel |
| an empty folder named Marver.app | "An empty folder named Marver.app is in Applications" | "Move that empty folder to the Trash, then open the download again." Show Both or Cancel |
| anything else of that name | "Something named Marver.app is in Applications" | "Marver doesn't replace what it doesn't know. Move it out of Applications, then drag this Marver in." Show Both or Cancel |
| nothing, but this account can't add apps there | "Marver can't add itself to Applications" | "This account can't add apps to Applications. Drag Marver into Applications in Finder: it asks for an administrator's name and password." Show Both or Cancel |

Show Both shows this copy and what is in Applications in Finder, for the drag. Marver never replaces, renames or
deletes what is in Applications, and never asks for an administrator's password itself: when one is needed (an older
Marver this account can't change, say), Finder asks. Cancel opens Marver where it is, and it asks again the next time.
A Marver that runs outside Applications works, but does not update itself. The Applications folder in your home folder
(`~/Applications`) counts too: a Marver there is not moved, and updates itself.

## An earlier Marver

A Marver before 1.0 (any 0.x, `~/Applications/Marver.app` included) has no updater, so it is replaced once, by hand:

1. Quit it. While one Marver runs, opening another only brings the running one forward.
2. Install 1.0 as above. An older Marver in Applications is the "An older Marver" case: drag 1.0 over it and choose
   Replace.
3. Drag any other old copy to the Trash, so you never open it by mistake.

Your settings and tabs stay: every version keeps them in the same folders ([Uninstalling](#uninstalling)).

## First launch

Marver opens on Home. With no canvas yet, Home is the welcome: "No canvas running yet", and three ways in. In a repo
with Marver, run `npx marver dev`. In a repo without Marver yet, run `npm i -D @marver-design/marver && npx marver
init` first. Each command has a Copy button. For a canvas someone shared with you, paste its link in the field there
and press Return. A canvas you start appears a second later, on Home and in its own tab. The ? button in the corner
is How Marver runs ([Help](#help-how-marver-runs)).

A canvas's tab and Home card wear its name and its logo: `name` in its `design/config.ts` (else `share.name`, else
the folder's name) and `logo` (else `share.logo`, else the first of `design/logo.svg|png`, `public/logo.svg|png`,
`public/favicon.svg|png|ico`, else Marver's mark). A canvas still on its folder's name or Marver's mark looks like
every other one in the strip, so `marver dev` says so on its boot line.

## Links into the app

When Marver is open with a canvas in a tab, `npx marver link` prints a `marver://` link for that canvas instead of its
localhost one, and an agent hands you that. Click it anywhere - the terminal, a chat, a note - and Marver comes forward
on that board, the frames selected and in view:

- **The canvas's tab is already open:** Marver never reloads it. The tab moves to the place the link names, as
  `marver show` does - and if you were typing a comment or a Jam edit there, it stays put and says "Your agent wants
  to show you <the frame> · Go" instead, so nothing you typed is lost.
- **It has no tab yet:** a tab opens on that place.
- **The canvas is not running:** Home opens with its card first under Not running, highlighted, and its menu open on
  Copy start command. When that canvas's tab is still open but stopped, its tab's card is the one.

A link names its canvas by its folder, and only a canvas running from that same folder opens it - never another canvas
that took the same port later. A link that names no place Marver understands opens the canvas on its board.
`marver link` gives the `marver://` link only while Marver is in use (it keeps `~/.marver/state/app-live.json` fresh
every 30 seconds) with that canvas open in a tab; otherwise, and with `--web`, the localhost link. Home's field opens a
`marver://` link too ([The link field](#the-link-field)).

## Home

Home shows your canvases as cards. **View** (the sliders button at the top) switches between two views, and Home
keeps your choice; it starts on Board.

- **Board**: a column per state - Needs you, Agent working, Ready to review, Running, Not running - and the shared
  canvases as chips along the foot, under Shared with you. A full column scrolls.
- **Grid**: three sections, Running, Not running and Shared with you, four cards a row. Running holds the cards of the
  board's first four columns, in that order. A section with no card is left out.

Each canvas has a card (one per tab, so a canvas open twice has two), in the first column that fits, in that order. Each card's line says what is going on:

| Column | The line |
|---|---|
| Needs you | "2 questions on Checkout", "Agent run failed on Checkout", "Agent stalled on Checkout", "Agent run to review on Checkout" (the board is named when all of them are on one board), or "Stopped unexpectedly": its process ended while you were not looking at it |
| Agent working | "Agent working on Checkout · 4 min", from an hour "2 h". The board and the minutes need a canvas on Marver 0.32 or later; an older one reads "Agent working" |
| Ready to review | "3 new frames to look at" |
| Running | "Running", "Starting…", "Not responding", "Can't reach", "Crashed" or "Unloaded", then " · tab closed" when its tab is closed and it still runs. A port that does not answer as a Marver canvas reads "Not a Marver canvas", named by its host |
| Not running | "Stopped" while its tab is open, "Ran 2 hours ago" ("Ran Oct 27" after two weeks), or "Not running" for a canvas a link named that never ran here |
| Shared with you | "Open" (or "Opening…", "Can't reach", "Crashed") for a shared canvas in a tab, "Opened 3 days ago" for one opened before |

"Agent working" counts from when the agent began: a `marver work start` hold, or a Jam run once it has started, never
while it waits for its turn, a session or a free slot. Not running lists the canvases that ran before, not those in a
temporary folder (`/tmp`, `/private/tmp`, `/var/folders`), which are tests and scratch copies. A shared canvas shows its
name and logo once Marver has opened it once (read from the canvas's own `meta.json`, through that tab's sign-in).

**Clicking a card.** A running or shared card opens its tab; Return or Space does the same from the keyboard. A card
that is not running opens its menu.

**A card's menu.** Right-click a card, or press its more button (it shows on hover), for its menu. A shared chip on the
board has the same menu on a right-click.

| Card | Its menu |
|---|---|
| running | Open; Update to 0.32.0, in blue, when its Marver has a newer release; Copy link (its localhost link); Copy path; Reveal in Finder |
| not running | Copy start command; Copy link (its `marver://` link); Copy path; Reveal in Finder |
| shared | Open; Copy link |
| not a Marver canvas | Open |

Update to copies the command that updates that canvas, in its own folder; nothing is updated in the app. Copy start
command copies the command that starts it in its folder. A copy row says "Copied" for a moment, then the menu closes.

### The link field

The field at the top of Home opens a canvas link: a local canvas's, a shared canvas's https link, or a `marver://`
link. ⌘L (File > Open Link…) takes you there from any tab. Before you press Return, the line under it says where the
link goes ("↩ opens in Checkout's tab"), or why it can't ("Nothing is running on localhost:5173"). Escape takes you
back to the tab you came from.

### Help: How Marver runs

The ? button opens How Marver runs: how to open a canvas (`npx marver dev` in its repo), add Marver to a repo (`npm i
-D @marver-design/marver && npx marver init`) and update a canvas (`npm i -D @marver-design/marver@latest`), each with
a Copy button. Its foot shows where Marver keeps its settings and agent notes (`~/.marver/`), with Show the files. A
click outside it, or Escape, closes it.

## The tab strip

Each canvas you run has a tab, with its round logo and its name. The tabs share the strip's width, and the open one
stands out in glass. On a narrow window, or with many tabs, a tab shrinks to its logo and its badge, and » at the end
lists the tabs that do not fit, with a word for any that is not running as it should ("stopped", "can't reach"). Pick
one to open it. Home has its own button, at the left (⌘T). Hover a tab to see its key: ⌘1 to ⌘8, and ⌘9 for the last
canvas.

**Its badge.** Each canvas's tab shows an orange count of what needs you (Marver's questions, captures to review, runs
that failed or stalled), else a blue dot when frames are new since you looked, else a shimmer while an agent works,
and a teal dot while a Jam session runs. While Home is open the tabs drop their counts, dots and shimmer: Home already
shows them. [What the marks mean](boards-and-folders.md#what-is-new-what-needs-you).

**Its menu.** Right-click a tab for its Marver menu, with icons like the sidebar's:

- a canvas on this Mac: Open in browser, Reveal in Finder, Copy local link, Mark all as seen and, with Marver 0.31 or
  later, Resolve all comments (every open conversation on that canvas, never what Jam is working on, with Undo);
- a shared canvas: Open in browser, Copy link, Reload, Force reload;
- every tab: Close tab.

The ContextMenu key or ⇧F10 opens it from the keyboard. » opens the same kind of menu, one row per hidden tab.

**Moving the window.** Drag the strip where it is empty. However many tabs you have, the strip keeps at least 40 px
empty before its right end, or before a message showing there, so there is always somewhere to grab: the tabs shrink
and move behind » a little sooner instead.

The strip and Home follow Reduce Transparency and Increase Contrast, and show a clear focus ring when you use the
keyboard.

## Hide UI in play

In play, prototype, slides or focus mode, `h` (Hide UI) takes the whole window: the tab strip and the window's buttons
go with Marver's own controls, and the stage grows into the room they leave. A thin band along the top, 16 px and
invisible, still drags the window. Everything comes back with:

- `h` again;
- Escape, which leaves play (it first cancels a comment you are writing or the laser);
- leaving play any other way: the strip comes back, and the canvas keeps its controls hidden until you press `h`;
- switching tabs (⌘1 to ⌘9, say): coming back, everything shows.

On a board locked to play, Escape shows everything again. On the canvas, Hide UI hides Marver's controls and keeps the
strip, which is how you move between canvases; a shared canvas's tab keeps the strip too. This needs app 1.2 and a
canvas on Marver 0.32 or later. In a browser, or with an older app or canvas, Hide UI works as before: the strip stays.

## What it asks, and when

- **Notices.** Nothing touches macOS's notices or the Dock before you choose. The first time a canvas needs you while
  Marver's window is in front, the strip offers "Get a notice when a canvas needs you": Turn On, and macOS asks then;
  Not now, and it never offers again. Settings' Notices row turns them on or off later.
- **The microphone.** macOS asks the first time a canvas listens, at your first Jam session or capture with the
  microphone on, giving Marver's reason: "Marver uses the microphone only during a Jam session you start."

## Updates

Marver keeps itself up to date from the Applications folder. It checks 30 seconds after it opens, every 4 hours and
when the Mac wakes, and downloads an update quietly; a check that finds nothing says nothing. **Marver > Check for
Updates…** checks now and answers in the strip: "Marver 1.0.0 is up to date", "Couldn't check for updates · You're
offline" or "Couldn't check for updates · Try again later". While it works, the item reads Checking for Updates… or
Downloading Update….

**When an update is ready**, the strip says "1.0.1 is ready" with **Restart to Update** (its tooltip is the first line
of what changed), and the Marver menu reads Restart to Install Update. Two ways to install it:

- **Restart to Update** closes your canvases as a quit does, installs the update and opens the new Marver. A canvas
  with unsaved work - an unsent capture, an edit not yet saved - holds it: its tab comes forward saying "**Unsaved
  work here** the update waits", and from any other tab the strip says "1.0.1 waits for Checkout" (that canvas's
  name) with Try Again. Once that work is saved, or its tab closed, the strip is back to "1.0.1 is ready": press
  Restart to Update again. A canvas the app can't read, such as a shared one, asks first, as it does at a quit
  ("Restart to update anyway?"). Marver never restarts by itself.
- **Quit Marver.** A plain quit installs the downloaded update: the next time you open Marver, it is the new version.

**After an update, Marver opens as it does after a quit.** With Settings' "Reopen tabs at launch" on (the default),
each running canvas gets its tab back on the board it showed, and Settings if it was open; with it off, Marver starts
on Home and every running canvas still gets its tab. Shared canvases do not come back in tabs (Home's Shared with you
reopens them), and a canvas that is not running gets no tab. What a page held only in memory, such as an open panel or
a scroll position, does not come back. The first launch after says "Updated to 1.0.1", once.

**Where it updates.** Only from an Applications folder, and only where this account can change Marver and its
folder: Marver never asks for an administrator's password to update. Otherwise the Marver menu says why, in place of
Check for Updates…:

| The menu | Its alert |
|---|---|
| Updates Need the Applications Folder… | "Marver updates itself only from the Applications folder" - "This Marver runs from ~/Downloads. Quit it, move it to Applications, and open it from there: it then checks for updates on its own." OK or Show in Finder |
| Updates Unavailable… | "Marver can't update itself here" - "Updating replaces Marver where it is, and this account can't change /Applications. Download the latest Marver and install it again to update." OK or Download |
| Updates Unavailable… | "Marver can't check for updates" - "Its updater couldn't start on this Mac. Download the latest Marver to update by hand." OK or Download |

**If an update goes wrong:**

- The restart can fail before Marver ends: "Marver couldn't restart to install 1.0.1" - "Your canvases were closed
  safely. Open Marver again: it may already be 1.0.1, and if not, it tells you how to get it." Quit, then open Marver.
- When the update did not install, Marver opens as the version it was and the strip says "1.0.1 couldn't be
  installed", with Download, which fetches the latest disk image in your browser. Open it, drag Marver into
  Applications and choose Replace.
- **If Marver won't open after an update**, download
  [the disk image](https://github.com/TNEP4/marver-app/releases/latest/download/Marver-arm64.dmg) again, open it,
  drag Marver into Applications and choose Replace. Your settings and tabs stay.

## Exporting a PDF

**File > Export PDF…** (app 1.1, a canvas on Marver 0.31 or later) prints the open board as a PDF - one page per slide
([Deck PDFs](pdf.md)) - and, when it is ready, opens a save panel on `~/Downloads/<board>.pdf`. The canvas's own Export
PDF (a board's menu, slides and present mode's toolbar) saves the same way in the app. The canvas sends the app only
the finished job's id: the app fetches the file itself from that canvas, checks it is a PDF of 200 MB at most, checks
again that the tab still shows the same canvas page after you chose where to save, and writes it whole.
In app 1.0.1 (no File > Export PDF…), the canvas's Export PDF ends on a notice with **Download**: 1.0.1 cancels a
download its window did not start while in front, so the file waits for that click rather than for the last page.

## The performance report

When Marver is slow, crashes or flashes, a report helps find out why. **Help > Export Performance Report…** (also on a
canvas's page that keeps crashing, beside Copy Details) opens a save panel on
`~/Downloads/Marver-report-YYYY-MM-DD.json`, writes the file and shows it in Finder. Nothing is uploaded, and the file
is JSON you can read before you send it. If it cannot be saved, an alert says why ("The performance report wasn't
saved") and no half-written file is left.

**What it holds:** the last 7 days of the app's own records in `~/.marver/perf/` (fewer when Settings' "Keep
performance files" keeps fewer):

- when it was made, and the app's, Electron's and macOS's versions;
- your Mac: its chip, cores, memory, model and macOS version, and each display's scale and refresh rate;
- one row per hour: the app's own CPU and memory, the canvases' memory, the GPU process's memory, the highest memory
  pressure and the worst thermal state;
- events, newest first, at most 2,000: a page or a helper process that crashed or stopped answering, the GPU
  restarting or changing, power and heat, memory pressure, tabs unloaded and reopened, the flashes you marked (whether
  a picture was kept, never the picture), the updater's and the move's steps, and an error in the app by its type
  alone (such as `TypeError`);
- how long tab switches took, per day, and how many crash reports the app kept;
- for each part, whether it was read whole.

A tab appears only as an opaque id, such as `t3`.

**What it never holds:** board, canvas or file names; paths, hosts or links; error messages or stack traces; process
names or ids; pictures; traces or crash dumps. Board loads and headless runs are not in it either: they stay in each
repo, where `npx marver perf` shows them ([Performance](performance.md)).

**Where to send it:** [open an issue on TNEP4/marver](https://github.com/TNEP4/marver/issues/new), say what happened
and roughly when, and attach the file.

## `~/.marver/` and its README

Marver keeps its settings and its state in `~/.marver/`, beside the files `marver dev` keeps there. At every launch
the app writes a `README.md` in it, for you and your coding agent: every file, every setting, and the rules for
changing them (edits to the README itself are lost). Settings (Marver > Settings…) writes `config.json` and
`theme.json`. Show the files, in Home's How Marver runs (the ? button), opens the folder; Help > Show Performance Files opens the app's performance records.

## Uninstalling

Quit Marver and drag it from Applications to the Trash. Its files stay until you delete them:

- `~/Library/Application Support/Marver`: the app's web data, shared canvases' sign-ins among it;
- in `~/.marver/`, the app's own: `config.json`, `theme.json`, `schemas/`, `state/`, `perf/` and `README.md`.

The rest of `~/.marver/` (`running/`, `prefer/`, `canvases/`, `models/`) is what `npx marver` keeps for your repos'
canvases: delete the whole folder only when you no longer use Marver at all.

## On an Intel Mac, or an older macOS

The app needs Apple silicon and macOS 13 or later. On any other Mac nothing of it runs: macOS refuses to open it with
its own message, and Marver has no chance to explain. That is why the requirement sits beside every download link.
Marver runs the same in your browser: `npx marver dev`.

## Troubleshooting

- **A canvas does not appear.** `npx marver ls` lists every canvas running on this Mac, with its version. Not listed:
  it is not running, so start it with `npx marver dev` in its repo. Listed at 0.26 or older: update it
  (`npm i -D @marver-design/marver@latest`) and start it again.
- **A tab says "Not a Marver canvas".** "Something else answers on this port: a canvas that stopped without cleaning
  up, or another program, or the canvas failed to render - its terminal says why. The app shows nothing it serves."
  Start the canvas again and press Try Again, or Close Tab.
- **Marver does not update.** The Marver menu says why ([Where it updates](#updates)).
- **Marver won't open after an update.** Download the disk image again and drag Marver over the old one (Replace).
- **Anything else:** [an issue on TNEP4/marver](https://github.com/TNEP4/marver/issues), with the performance report
  attached when it is about speed, a crash or a flash.
