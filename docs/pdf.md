# Deck PDFs

`npx marver pdf <board>` turns a board into a PDF: one page per slide, exactly what the stage shows, with real text you
can search and copy, vector shapes, and links that click. The running `marver dev` makes it with your own Chrome, so
what prints is the frame your agent built - fonts, images, charts and all.

```sh
npx marver pdf pitch                 # design/exports/pitch.pdf
npx marver pdf pitch --notes         # design/exports/pitch-notes.pdf - a handout with the speaker notes
npx marver pdf pitch --theme dark --out ~/Desktop/pitch.pdf
```

On the canvas: **Export PDF** in a board's menu (right-click it in the sidebar), and the export button in slides and
present mode's toolbar, which prints in the theme the stage shows. A notice shows the page it is on, with Cancel; the
file downloads when it is done. In the Mac app, **File > Export PDF…** does the same for the open board and asks where
to save it.

## What goes in the PDF

- **A slides board** (its publish row plays it as slides) prints its deck: its `slide: true` frames in reading order -
  top to bottom, then left to right - each once, as slides mode plays them.
- **Any other board** prints its frames in the board's order, as Play walks them, html frames included. A slide frame
  is its stage size on any board; any other frame is printed at the device Play shows it at - the viewport whose width
  is its node's on the board, else the frame's own viewport, else the first - at that viewport's height.
- **Each page is the slide's own size** (1280×720 is 13.33 × 7.5 in), margins zero. A slide taller than its stage is
  cut where the stage cuts it, and the report names it *clipped*.
- **The finished slide.** Entrances show their end state (the PDF is never "playing"), animations are stopped where
  they end - an infinite one at its first pose, so a spinning mark rests upright - and a video shows its first frame.
  Motion driven by your own `requestAnimationFrame` code cannot be stopped from outside: it prints as it is two frames
  after the slide settles.
- **Screen styles, not print styles.** `@media print` and Tailwind's `print:` are ignored: the page is the slide you see.
- **Images at full resolution.** Every image is printed from its original file, never the downscaled copy the canvas
  shows while you zoom.
- **Bookmarks** - one per page, named by the frame's title - and the PDF's title (the board's), author (the canvas's
  name) and creator (`Marver x.y.z`).
- **Theme**: `--theme` when you give one, else the theme pinned on the frame's node, else the frame's own, else light.

## Effects Chrome cannot print

Some CSS effects come out wrong when Chrome prints: a frosted-glass `backdrop-filter` prints transparent, a `filter`,
`mix-blend-mode` or a CSS `mask` prints as a grey box, a large soft `box-shadow` prints as a hard grey rectangle, and a
`<canvas>` or `<video>` may print blank. (A `filter` that is only `drop-shadow()` prints right, and is left as it is.)
Marver fixes each one element by element, and checks its own work:

- **Glass** keeps its children live (text, links, icons stay vector and selectable); only the blurred backdrop behind it
  becomes a picture, taken at 3x.
- **A filtered, blended or masked box, a canvas, a video** becomes a 3x picture of itself, including the shadow or blur
  that spills past its edge; any link inside it stays clickable.
- **A large soft shadow** is redrawn as a stack of sharp vector shadows that follows the blur's falloff - no picture
  at all.
- **An effect on the page itself** (a filter or blend on `body` or `html`) has nothing to be patched into: that page is
  printed as a 3x picture, and the report says why. So is an effect under a rotation or a skew.

Then the fixed page is compared with the unfixed screenshot, taken before anything was prepared for print. A fix that
changes more than 1 % of its own area, or anything outside it, is thrown away and that page is printed as a 3x picture
instead (*raster*). Every printed page is also rasterised (macOS `sips`) and compared with the screen - pixel by pixel,
allowing only the edge differences two renderers make, and area by area - which catches anything that only goes wrong
in print: such a page becomes a picture too. Where there is no rasteriser (not on a Mac), the report says *screen-certified only*.

`--raster` prints every page as a 3x picture (no vector text). `--vector` fixes nothing: every page exactly as Chrome
prints it (a page whose print differs from the screen is named, and kept).

## The report

```
design/exports/mark-ii.pdf - 32 pages, 2.7 MB, 17.8 s
  patched: mark-ii/12-chat (::after mix-blend-mode: soft-light; mask-image), mark-ii/17b-navigation-views (backdrop-filter; box-shadow)
  every page print-certified (rasterised and compared with the screen)
```

Each kind of slide that needs a look is named: **skipped** (a frame the manifest no longer lists, or a non-slide frame
on a slides board), **failed**, **patched** (and with what), **raster** (and why), **unsettled** (still loading images or
charts after 10 s - printed anyway), **clipped**, **spilled** (Chrome made more than one page; the first is kept),
**changed while printing** (its source changed twice while it rendered). `--json` prints all of it, slide by slide.

A slide that fails to render fails the export - a PDF is never handed over with a page missing. `--keep-going` prints
the rest and leaves the failed page blank, named in the report.

## The handout (`--notes`)

`--notes` prints a handout instead: each slide's picture, its title, and its notes (the frame's `.note.md`, rendered as
Markdown at 11 pt or more) - "No notes" where there are none. Long notes continue on the next page. Letter landscape by
default, `--paper a4` for A4. Page numbers in the footer, a bookmark per slide. The slides in a handout are pictures:
the deck PDF is the one you search.

## What it does not do

- **Not a tagged (accessible) PDF**: the pages are merged with pdf-lib, which keeps each page but not Chrome's structure
  tree. The handout, printed as one document, is tagged.
- **Links between slides** (`data-goto`) do not carry over; `https:` and `mailto:` links do.
- **Published canvases** cannot export: the build has no browser. Export from `marver dev`.
- A CJK character may copy out of the PDF as its compatibility form (a Kangxi radical) - how Chrome's font subsets map
  it; it displays and prints right.

## Limits

One PDF at a time per canvas (a second is refused, naming the one running). 300 pages at most, a page side of 4096 CSS
px at most, 15 minutes, 500 MB. The job's folder (`design/.local/pdf/`) keeps only the finished file, for an hour, and
is emptied when `marver dev` starts. `marver init` keeps `design/exports/` out of git.
