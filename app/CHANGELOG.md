# Changelog - the Marver Mac app

## 1.2.1 - 2026-11-11

### Highlights
- Settings in glass, with updates in one place
- See when Marver last checked for updates, and what's new before you restart
- D switches light and dark on Home and Settings
- Turn off automatic updates in Settings; Check for Updates still works
- The Settings tab wears a gear, like a canvas wears its logo

Use it with canvases on marver 0.32.0, as 1.2.0; older canvases keep working as before.

- **Settings, redone in Home's glass.** One centred column: Updates, Appearance, Tabs, Notices and Performance, with
  real switches, a System / Light / Dark control and a menu for how long performance files are kept. A settings file
  that does not apply says so at the top, with its problems and its text.
- **Updates in Settings.** Marver and its version, whether it is up to date and when it last checked, Check for updates;
  while it checks or downloads, it says so; once an update is ready, what's new in it, Release notes and Restart to
  update - your canvases keep running until you do.
- **Download updates automatically** (`autoUpdate` in `config.json`, on by default): off, Marver checks only when you ask.
  A `config.json` that sets it does not apply in a Marver older than 1.2.1 (an unknown key); updates only move forward.
- **D switches light and dark** on Home and in Settings, the opposite of what shows; canvases keep their own theme.
- The Settings tab shows a filled gear on a round plate, the size of a canvas's logo.
- Each release now opens with a few short highlights: the update's "What's new", its tooltip and the GitHub release
  page show them.

## 1.2.0 - 2026-11-11

Use it with canvases on marver 0.32.0 for everything below; older canvases keep working as before.

- **A new tab strip.** Tabs share the strip's width, each with its canvas's round logo, the open one lifted in glass; on a
  narrow window they shrink to their logo, and » lists the rest. A gap before the strip's right end always lets you drag
  the window. While Home is open the tabs drop their counts - Home already shows them. Home has its own button (⌘T).
- **The tab's right-click is a Marver menu**, with icons, like the sidebar's: open in browser, reveal in Finder, copy the
  link, mark all as seen, resolve all comments, close the tab - and » opens the same kind of menu.
- **Hide UI takes the whole window** in play, prototype, slides and focus mode: the strip and the window's buttons go,
  and come back with H, Escape, leaving play or switching tabs; a thin band along the top still drags the window. On the
  canvas the strip stays.
- **A new Home.** Your canvases as cards in a grid - Running, Not running and Shared with you - or as a board with a
  column per state: Needs you, Agent working, Ready to review, Running, Not running.
  Each card says what is going on: what waits on you, "Agent working on <board> · N min", when it last ran. A right-click
  or the more button on a card opens its menu: Open, Update, Copy start command, Copy link, Copy path, Reveal in Finder.
- **Open any canvas link from Home**, a `marver://` link included; ⌘L takes you there. "How Marver runs" (the ? button)
  shows how to start a canvas and add Marver to a repo, and with no canvas yet, Home is the welcome.
- Home and the strip follow Reduce Transparency and Increase Contrast, and show a clear focus ring when you use the keyboard.
- Fixed: a click or key right after a canvas finished loading could be missed by the white-flash recorder.

## 1.1.0 - 2026-11-10

Use it with canvases on marver 0.31.0 for everything below; older canvases keep working as before.

- **`marver://` links open Marver.** A link an agent gives you (from `marver link`) brings Marver forward on that canvas's
  board, the frames selected and in view. A tab already open is never reloaded - if you were typing a comment there, it stays
  put and offers to go. A canvas that isn't running opens Home on its card, with its start command.
- **Ask your agent to show you something.** `marver show` moves your open canvas to that frame, scene, board or comment
  thread and brings its tab and the window forward; if you were typing a comment there, it offers to go instead.
- **Resolve All Comments** on a canvas tab's menu, beside Mark All as Seen: every open conversation on that canvas, never
  what Jam is working on, with Undo.
- **File > Export PDF** saves the open board as a PDF where you choose (the save panel opens on Downloads); the canvas's own
  Export PDF, in a board's menu and in slides and present mode, saves the same way. Up to 200 MB - a larger one:
  `npx marver pdf`.
- **Calmer tabs:** frames new since you looked show a blue dot, not a count; orange still counts what waits on you.
- **Home:** canvases in temporary folders no longer fill Recently here; recent and shared canvases keep their name and logo;
  a running canvas on an older Marver says so, with the command that updates it.
- Live pictures are saved in sRGB, so your agent reads the colours the page asked for.

## 1.0.1 - 2026-11-05

Marver now records what the app does and what you ask of it, closely enough to explain a slow launch, a white flash or a
command that did not take. It changes no behaviour. Use it with canvases on marver 0.30.0 for the full picture; older
canvases keep working and record what they did.

- **Every command, however you give it:** keys, menus, the tab strip and its menu, Home, Settings, the update pill, a clicked
  notice, the Dock, the app's dialogs - what it was, how you gave it, whether it worked, how long it took. Names and key
  combinations only, never what you type or a setting's value. Help > Show Performance Files shows them.
- **A launch line for each launch:** ready, window shown, the first canvas uncovered and its page, what was restored.
- **White flashes are watched in more places:** a tab being shown and, with marver 0.30, a board load, a theme switch and a
  frame's reload, under a budget of 3 s of capture a minute. Each minute's `sample` says what was and was not covered.
- **Fourteen days of history.** Samples moved to `samples.jsonl`, rows unchanged; each log is a live file plus closed segments
  deleted whole by age (`keepPerfDays`), never rewritten, with a safety cap per file. The file 1.0.0 left is kept until it ages out.

## 1.0.0 - 2026-11-02

The first public release: notarised by Apple, and from now on Marver keeps itself up to date.

Use it with canvases on marver 0.29.0 or later, which marks, notices and live pictures need; a canvas on 0.27 or 0.28
shows in a tab and asks before losing unsaved work, without them. It is also the first public build of 0.3.0's work:
marks, notices, shared canvases in tabs and live pictures. How to install, update and remove it:
[the install page](https://github.com/TNEP4/marver/blob/main/docs/app.md).

- **One download, always the latest.**
  [Marver-arm64.dmg](https://github.com/TNEP4/marver-app/releases/latest/download/Marver-arm64.dmg), for Apple silicon
  and macOS 13 or later. The app and its disk image are signed with a Developer ID and notarised by Apple, so macOS
  asks one question at the first open, because the app was downloaded.
- **Marver moves itself to Applications.** Opened from the disk image or another folder while Applications holds no
  Marver, it copies itself there without asking, opens from there and says "Marver moved itself to Applications."
  once. Opened from the disk image, macOS asks its question again at the moved copy. With a Marver of this version or
  newer already there, it offers Open It. With an older one ("To replace it, drag this Marver into Applications and
  choose Replace."), or anything else of that name, it says what it found and what to do, and Show Both opens both in
  Finder: Marver never replaces, renames or deletes an app itself, and never asks for an administrator's password.
- **Updates on their own.** From the Applications folder, Marver checks 30 seconds after it opens, every 4 hours and
  when the Mac wakes, and downloads an update quietly. Marver > Check for Updates… checks now and answers in the strip
  ("Marver 1.0.0 is up to date"). A copy outside Applications, or one this account can't change, does not update, and
  the Marver menu says why: Updates Need the Applications Folder… or Updates Unavailable….
- **Restart to Update.** A downloaded update shows in the strip as "1.0.1 is ready", with Restart to Update; the
  Marver menu reads Restart to Install Update. It closes your canvases as a quit does, so a canvas with unsaved work
  holds it: its tab comes forward, and the strip says "1.0.1 waits for Checkout" (that canvas's name), with Try Again.
  Marver never restarts by itself; not pressed, the update installs at your next quit.
- **After an update, Marver opens as it does after a quit**: each running canvas's tab on the board it showed (with
  Reopen tabs at launch on), and "Updated to 1.0.1", once. Shared canvases reopen from Home. An update that did not
  install says "1.0.1 couldn't be installed", with Download.
- **Export Performance Report…** in the Help menu, and on a canvas's page that keeps crashing: the last 7 days of the
  app's own records as one JSON file you save and can read - your Mac, the app's CPU and memory by the hour, and
  crashes, hangs and flashes as counts and times. No board or canvas names, links, paths, error text or pictures, and
  nothing is uploaded. Attach it to an issue on TNEP4/marver.
- **An earlier Marver is replaced by hand, once.** Builds before 1.0 have no updater: quit it, install 1.0, and drag
  the old copy to the Trash (`~/Applications/Marver.app` included). Your settings and tabs stay.

## 0.3.0 - unreleased (spec 28 A4)

Marks, notices, a notice's click and live pictures need a canvas on marver 0.29.0: a canvas on 0.28 or earlier shows
none of them, only "Stopped" when its process dies.

- **Each canvas's tab says when it needs you.** One mark after its name: an orange count of what needs you - Marver's
  questions, captures to review, runs that failed or stalled (99+ past 99) - else a blue count of new frames, else a
  light sweeping the mark while an agent works (a still wash with Reduce Motion); and a teal dot on its logo while a
  Jam session runs. A hidden or unloaded tab keeps its mark, and one the app cannot hear from for a while dims it.
  VoiceOver reads the marks in the tab's name and says "<name> needs you" when the count rises.
- **Notices, once you want them.** The first time a canvas needs you while the window is in front, the strip offers
  "Get a notice when a canvas needs you": Turn On, and macOS asks then; Not now, and it never offers again. Nothing
  touches macOS's notices or the Dock before that. With notices on, a canvas open in a tab you are not looking at -
  another tab in front, or the window hidden, minimised, in the background or the screen locked - sends one when
  something new needs you: its name, then "Asks you:", "Ready to review:", "Failed:" or "Stalled: ... - choose what to
  do", and "and N more"; at most one a minute per canvas, and none for what already waited when the app connected.
- **The Dock counts what needs you** across your open canvases, once notices are on (Settings: Dock badge, on by default).
- **A canvas that dies says so.** When a canvas's process ends without stopping (a crash, `kill -9`), its tab counts a
  "Stopped" need and, with notices on, sends a notice, until you look at it, close it or the canvas starts again. A
  canvas you stop yourself sends nothing.
- **A notice opens its item.** Clicking one brings the window forward on its canvas's tab - reopening it if you
  closed it, loading it again if it was unloaded - and the canvas opens what the notice named: the thread, the review,
  the run's Retry or choices. A later click replaces one still waiting for its page; a "Stopped" notice shows its tab.
- **Settings: Notices.** The Notices row turns notices on and off, says that macOS decides whether they show, and
  always offers Open System Settings. With Marver set to Don't Allow, or a Focus that silences it, macOS hides notices
  without telling the app, so the app cannot warn you; they still wait in Notification Center when only a Focus held
  them. When a notice fails to post, the row says "macOS couldn't post Marver's last notice" and the strip says
  "<name> needs you" in its place. The Dock badge row shows once notices are on.
- **A picture in play is what you saw.** A capture's picture of the play stage is read back from the canvas's own
  view - an open menu, typed text, the comment pins - in place of a fresh render. The canvas asks only when the whole
  stage is in view with nothing of its own over it and has shown its screen for a second (a device preset, a slide
  fitted to the window). The app answers only for the active tab, with the window shown and not minimised and no tab
  page (Home, Settings, an error page) over the canvas; it does not check that the window has focus, that the screen
  is unlocked or that no other app covers it. When the app cannot answer, or the tab, its page or the stage changed
  while it was read, the canvas takes its render instead. A canvas reads its own view's pixels and nothing else: no
  Screen Recording permission.
- **Shared canvases open in a tab.** An https link - `⌘L`, Home's field, or a canvas the front door opens - opens that
  canvas in a tab of its own, one per site, named by its host, after your local canvases; `⌘1`-`⌘9` and `»` reach it.
  It is someone else's page: it cannot reach the app, it may copy to the clipboard and go full screen and nothing
  more, a download is cancelled (Open in Browser does that), and an http link goes to your browser, as does a window
  it opens on another site - unless that site already has a shared tab here, where it opens instead. Marver ID's
  sign-in runs inside the tab and is kept; the tab returns to the board you opened, never to a sign-in page. It wears
  its page's icon - for a canvas published with marver 0.29.0 or later, its repo's logo - else its host's initials.
- **Closing, reloading or quitting asks first for a shared canvas**: the app cannot tell what it holds, so one sheet
  names it ("pilot.example.com is a shared canvas: the app can't tell what it hasn't saved").
- **Home lists Shared canvases**: the open ones, then the last 12 opened, which reopen with a click. Shared tabs are not
  restored at launch.
- **A shared canvas that cannot be reached**, or whose link opens no page here (a download, a redirect to http), says
  why in words, tries again by itself (at once when the Mac is back online), and offers Open in Browser; a bad
  certificate is never gone past. A site whose `/` redirects counts as answering.

## 0.2.2 - 2026-10-26

- **The icon has room at its sides.** The mark filled 83% of the icon's width, 9.5% from the left edge and 7.2% from
  the right, so it looked crowded beside other apps, most of all in the Dock. It now fills 70%, centred, with its
  slant eased from 23 to 13 degrees, so it sits square in the tile (Nic's pick of three, 26 Oct).

## 0.2.1 - 2026-10-26

- **The performance record keeps the days you set.** The app's log kept its newest half past 5 MB, about 2 to 4 days of
  daily use. It now grows to 2 MB for every day kept (`keepPerfDays`, 14 by default, up to 90), so the days are the limit.
- **The canvas's floating chrome sits right under the tab strip** (with marver 0.27.3): the sidebar and the toolbar no
  longer add the browser's edge below the strip's own padding.

## 0.2.0 - unreleased (spec 28 A3)

- **A canvas runs under the tabs** (the one ground, A3.8 #24-#33). A canvas whose shell offers `inset` (Marver
  0.27.2) is placed at the window's full height under the transparent strip when its own document commits on that
  instance, told 44 by `mv:doc`; it is uncovered only once it is trusted, said 44 in its hello and answered the
  latest presentation request at its size, and a resize, a show, HTML fullscreen, a live resize's end and the GPU
  process lost or replaced each cover it until it answers again. A hello that says 0 moves its document below for
  the rest of its life; any other canvas (Marver 0.27.1 and earlier) stays below the strip, covered, as in 0.1.
- **The cover is S15's** (A3.8 #3; spikes.md S15): a web view whose ground is its own native background and whose
  page draws the still dots, between the canvases and the strip - a plain view, or an image of the dots, is drawn
  beneath a full-height web view on macOS and never covers. It covers only once its own renderer has made a frame,
  so until then, and again after its renderer or the GPU process is lost until it makes one, every canvas is placed
  below the strip (app 0.1's opaque layout). The strip paints its controls only; Home, Settings and every tab page
  run the full height too, painting the ground and still dots under the strip themselves, with everything to read,
  click or scroll 44 px down. The cover's renderer counts in the app's own memory.
- Presentation requests wait while the window cannot draw (hidden, minimised, or covered entirely by other windows):
  an epoch made meanwhile is asked when the window shows, so no `cover` record blames the page for time hidden.
- Hidden tabs are unloaded when macOS runs short of memory (Settings: Unload hidden tabs when memory runs short, on by
  default): at warn the least recently shown one, then 30 s before the next; at critical every hidden tab but the one
  in front; also when the canvases together pass half of the Mac's memory. Never the tab in front, and never one that
  is busy - unsaved work, a Jam session, the microphone, an agent at work - nor one that has not said it is idle (a
  Marver 0.27.0 canvas), one playing sound, one with DevTools open, one hidden less than 10 s or one whose page
  declined. Nothing asks and nothing comes forward. An unloaded tab keeps its place, name and logo, dimmed, and
  reopens on its board and camera when shown, saying "Reopening" until it is back (its board alone if its canvas came
  back on another address); a link opened into it opens on what the link names instead. What an unload does not keep
  is the page's undo, Back and Forward, and a selection the link does not name.
- **The performance recorder** (Settings: Performance recorder, on by default; Keep performance files, 14 days). Every
  5 s the app samples its processes - CPU, memory, each canvas's own footprint, the memory pressure - keeps a minute
  in memory and writes one `sample` line a minute to `~/.marver/perf/app.jsonl` (Marver Dev: `app-dev.jsonl`), with
  every renderer and GPU process end, hang, GPU change, power and thermal event, tab state and switch time, each line
  about a tab carrying the page id its canvas said hello with; the machine's profile in `perf/machine/`. One sampler
  serves the recorder and unloading; with the recorder off nothing is written and the sampler runs only while a tab
  could be unloaded. `npx marver perf --crashes`, `--flashes` and `--machine` read it, joined to the repo's board
  loads. Retention: 5 MB a file, 50 flash pictures, 10 crash reports, `keepPerfDays`.
- **Mark a Flash** (⌃⌥F on any view, or Help > Mark a Flash): the moment, the minute of samples before it, the GPU
  process's events around it, the pressure and the GPU figures, and a 480 px picture of the app's views as the app
  stacks them (not the screen), in `perf/flashes/`. The picture is taken and written first; then the strip's pill
  says "Flash marked" with its time, and Show reveals the picture. A second press within 2 s marks nothing new.
  With the recorder off a mark is still written, saying it has no samples before it.
- **White-out candidates**: during a canvas's gestures, a quarter-second check of the visible view for a white-out,
  written as `whiteout-candidate` - automatic and not verified; the marks are the evidence.
- Uncaught errors in main go through the recorder's writer (`main-error`, in `app-dev.jsonl` for Marver Dev), written
  in their own turn, whatever the recorder setting.

## 0.1.0 - unreleased (spec 28 A2, for Nic)

- The build: one bundle for main and one per preload, the release flavour packaged for Apple silicon, all nine
  fuses, signed with a Developer ID and the hardened runtime, the microphone line, macOS 13 and later.
- The debugging guard: a release build started with a remote-debugging switch ends at once (exit code 3).
- The icon for macOS 13-15 (`Marver.icns`); macOS 26's `Marver.icon` is still to make in Icon Composer.
- The packaged smoke and the test harnesses. The smoke gates A2's budgets from outside the signed build: a second
  launch reaches the canvas's first frame callback within 1 s, and the app's own memory - macOS's footprint, with no
  canvas open (the GPU process counted) and with one open (the GPU process reported beside it) - stays under 200 MB.
- Trust: the app reads `~/.marver/running/` itself and proves each canvas document before it commits (a fresh nonce,
  A1's proof, the registry read again once when a restarted canvas's own reload beats its slot file); trust belongs
  to the committed document. No service worker on a local canvas, swept before its partition's first load. The
  microphone only for a trusted canvas's main frame; app pages pinned; every view sandboxed with dialogs off; a link
  or a window leaves for the browser only from a trusted canvas, and a save sheet only for a trusted canvas in use.
  The canvas bridge admits a trusted document and replays what the page said before, hello first.
- The window: one window named `main` (its place kept), the strip over a plain cover in the active tab's ground, and
  every view - a canvas, Home, Settings, a tab page - below the strip (the opaque strip; the one ground is app 0.2's).
  Closing the window hides it; the Dock shows it again. HTML fullscreen stays in its view.
- Tabs: Home, canvases by slot then by port, Settings; `⌘1`-`⌘8` and `⌘9` the last canvas; a tab loads when first
  shown and stays loaded; the session restored from `tabs.json`; a tab closed for its canvas's run stays closed.
- One guard for every document the app replaces - closing a tab, quitting, `⌘R`, `⇧⌘R`, Try Again, a link: a page
  that said it holds unsaved work is refused at once and comes forward with "Unsaved work here"; one main cannot hear
  asks first (Cancel the default); the page's own `beforeunload` an extra veto. The quit is one guarded operation
  per canvas tab, cancelled by any refusal - and a refused quit shows the window, even one you had closed. A tab the
  quit already closed and you open again while it runs stops it, once its page is back. Only a link that names a
  hash on the page's own document opens with no question; one without a hash is a new document.
- Each canvas tab wears its canvas's logo (`design/logo.svg` and the rest of A1's ladder, proved like the page) once
  the canvas is ready, shown or not; a canvas with none wears its initials.
- Home lists the canvases running on this Mac, four across in a window of the default size, and Recently here; a
  canvas whose slot file offers no bridge (Marver 0.27.0) says to update for the full unsaved-work guard. Settings is
  a view of `~/.marver/config.json` and `theme.json`.
- A canvas that starts after launch opens its tab on the board it was left on; a second `marver dev` of the same repo
  gets a tab of its own.
- The tab's own page in place of an error page - starting, stopped, not a Marver canvas, can't be reached, crashed -
  and crashes with one owner: the first reloads at once, a second within a minute latches until you press Reload.
- A quit whose helpers end at the same moment (a SIGTERM to the app's process group) exits cleanly: a page whose
  renderer went is never read in a way that throws, so main no longer stops on Electron's error box.
- Once the window is up, an error nothing in main caught is recorded in `~/.marver/perf/app.jsonl` and the app goes
  on - never Electron's modal error box over pages that may hold unsaved work. A quit whose guard fails is refused,
  never left waiting: the next `⌘Q` quits.
- A canvas back after a stop or a restart picks up what waited for it: a tab whose reload met nothing listening, or
  whose page reloaded itself while the canvas was still starting, loads once it is ready; a crash's reload waits for
  it; a page kept under a failure is looked at again. A crash page offers Reload only when there is something to
  reload into, and a crash's reload that fails shows the failure.
- Home and Settings come back from a renderer that went, and an app page that tried to leave its own address keeps
  getting the app's news. A tab closed while its first view was being made stays closed and loads nothing.
- Mark All as Seen in a canvas tab's right-click menu clears every frame's "new" (Marver 0.27.1; disabled on a
  canvas without the bridge). A link from `⌘L` into a canvas that is restarting under a page it keeps is refused,
  saying the page stays as it was. With Reopen tabs at launch off, the boards saved for canvases not running stay in
  `tabs.json`.
- Not responding: the pill's Reload asks first, then ends the page's renderer once and reloads every tab it held.
- The menu bar: the app's keys fire once whatever the page does with keys; the canvas's own items with their keys in
  their names; a stale click does nothing. F6 between the strip and the page; focus never left beneath a tab page.
