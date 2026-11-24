# Search

Press **⌘K** (Ctrl+K off a Mac) anywhere on the canvas - or click the magnifying glass beside the sidebar's collapse
button - and a small glass search opens over the canvas. Type: folders, boards, scenes, frames, sticky notes and
comment threads are found as you type, and **the selected one's frame is drawn live on the right**, so you can tell
"Filter the feed" from "Filter the feed · Night" before you go. **Enter** takes the canvas there.

## What it finds

Everything Marver knows about each thing, from your files:

- **Frames** by their title, file name, description, device (`ipad`, `boox`, `mac`...), sticky note and the words in
  their own file (a Markdown file a Doc frame shows, too).
- **Scenes** by their title and their brief; **boards** and **folders** by their title, description and type.
- **Sticky notes** by their text, and **comment threads** by every message in them (a resolved thread only when you
  search comments alone, or when nothing else matches).

**Every word you type must match** - in any field, in any order: `sign ipad` finds "iPad sign-in". Results come in
the order of their level - folders, boards, scenes, frames, notes, comments - best first in each. A frame id typed in
full (`feed-night/04-filter`) is always the first result. One letter off is forgiven when nothing matches exactly
(`keybaord` finds keyboard), and the second line says where a match came from when it was not the name ("in note").

## The keys

| Key | Does |
|---|---|
| ⌘K | opens search; again closes it |
| ↑ ↓ | moves through the results; the preview follows |
| Enter | goes there - the board, the frame fitted and selected, a thread opened - and closes |
| ⌘Enter | goes there and keeps search open, to walk through several |
| Esc | closes; the canvas stays where it was |

Opened again, search shows your last query, selected: type to replace it. With nothing typed it shows **Recent** -
the last places you went with it on this canvas.

## Only some kinds, and the archive

The pill at the right of the field reads **All**. Click it to pick kinds - Folders, Boards, Scenes, Frames, Notes,
Comments - and whether to **Include archive**. The choice is remembered per canvas in this browser.

Archived things (a board whose status is `archived`, a board or folder typed `archive`, or - when nothing says
otherwise - a folder named like `archive`, `old` or `arch-...`) sit behind a "+9 in archive" row unless you include
the archive - an archived thing whose exact id or name you type still comes up. To mark a folder as an archive for
good, give it `"type": "archive"` in `design/boards/_folders.json`; `npx marver context check` lists the folders read
as archive by their name alone.

## The preview

The frame on the right is the frame itself - the same page the canvas draws, scaled down - not a picture, so it is
always current. Its shape shows at once, then the frame; the next result's frame is prepared while you look, so moving
down is instant. Frames in the preview cannot be clicked or focused, play no sound, and do not count as looked at. A
folder shows its boards instead. Project code can tell it is in a preview with `window.__mvPreview` (skip analytics or
polling there), and a frame that should never render there says so in its meta:

```tsx
export const meta = { title: 'Live call', preview: false }   // search shows its shape: "No live preview for this frame"
```

## For agents: `marver search`

```
npx marver search <words> [--kind frame,scene] [--archive] [--limit 8] [--json]
```

The same search from the files - no dev server needed: each result with its id, where it sits, its file and (when the
dev server runs) a link. Agents are told to use it to find a frame by what it is. It reads what the files say: words
that only shared screen components show are not in it yet.
