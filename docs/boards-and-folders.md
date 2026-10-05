# Boards and folders

A board is a saved canvas - a set of frames, arranged. Boards sit at the top of the sidebar, and
folders keep them tidy: a folder holds boards and folders, a folder inside a folder - a
**sub-folder** - holds boards. Two levels, so a board sits at the root, in a folder, or in a
sub-folder.

```
Start here
Features
  Shipper            <- a sub-folder
    New load
    Orders
  Phone
    Pickup inspection
  Carrier office     <- a board, straight in Features
Context
  Meetings
Archive
```

Everything below works the same way at both levels, and the same from the sidebar as from the files
- so a person arranging boards by hand and an agent arranging them by writing files always agree.

## In the sidebar

- **New folder** - right-click the Boards header, or its `+`. Name it inline: what you type is its
  title, any casing, punctuation or emoji.
- **New folder inside** - right-click a top-level folder: a sub-folder, at its end.
- **Drag** a board into any folder or sub-folder (drop it on the header), or between any two rows -
  the blue seam shows exactly where a release lands, indented with the level it lands in. Drag a
  folder among the boards; a folder with no sub-folders can also drop into a top-level folder and
  become one.
- **Move to new folder** on a board makes a folder at the board's own level, with the board inside:
  in its slot at the root, a sub-folder in its slot when it sits in a folder, and right after its
  sub-folder when it sits in one (a sub-folder holds no folders).
- **Move to top level** - on a board in a folder, or on a sub-folder.
- **Rename** changes the title. **Delete folder** never deletes a board: what the folder held moves
  up one level, into its place.

At the bottom of a folder, one gap belongs to several levels: after the last board of a sub-folder
you can drop into the sub-folder, after it in its folder, or after the folder at the root. Where you
hold the pointer decides - over the row above, its indent picks the level; over the row below, the
seam takes that row's level.

## In the files

Two files carry it, and they are the truth.

**A board names its folder** - the one it sits in directly, at either level - next to its rank:

```json
{ "version": 1, "name": "new-load", "folder": "shipper", "order": 0, "nodes": [] }
```

`order` ranks the board among its siblings. At every level the boards and folders there share one
sequence: the root's boards and folders, a folder's boards and sub-folders, a sub-folder's boards.

**`design/boards/_folders.json` lists the folders**, ranks them, titles and describes them - and
nests a sub-folder with `parent`:

```json
{ "version": 2, "folders": [
  { "name": "features", "order": 1, "title": "Features", "description": "One board per capability, by surface" },
  { "name": "shipper", "parent": "features", "order": 0, "title": "Shipper" },
  { "name": "context", "order": 2 } ] }
```

- A folder's `name` is its slug - what boards point at with `folder`, unique across both levels. Its
  `title` is what people see; renaming in the sidebar changes the title and never the slug.
- `parent` names a top-level folder. A sub-folder never holds a folder.
- The file says `"version": 2` while any folder has a parent, and `1` when none does.
- A folder a board names but the registry lacks is still real - it shows at the top level. To nest
  it, register it with its `parent`.
- A registry that breaks these rules is an error the canvas shows, never read as empty.

`npx marver boards` prints the tree as the files say it is - every folder and sub-folder, every board
with its rank, the landing board - and `--json` gives the same tree. The landing board is the first
board in that reading order, down through folders.

## Descriptions

Every folder, board, scene and frame takes one `description`: a sentence for agents - what it is
for, and its state when that is not obvious. A folder's sits on its entry in `_folders.json`. They
all land in `design/manifest.json`, the file an agent reads first, so a new session knows what each
folder is for before it files a single board.

## Agents

Agents make the same moves by editing those two files; `instructions/boards.md` in your project
teaches each one - creating a sub-folder, moving a folder in or out, renaming a slug (members'
`folder` and sub-folders' `parent` move with it), deleting (contents up one level). The sidebar
refuses a write that would overwrite an edit it has not seen, so an agent's file write and a
person's drag never silently erase each other.

## Publishing

A published canvas shows the folders of the published boards only - a sub-folder's parent included,
since the tree needs it. A folder with nothing published at any depth never reaches the bundle, so
its name and description stay private.

## Mixed versions

Marver 0.20 and earlier read one level of folders. They refuse a version-2 registry with an error
instead of rewriting it flat, so upgrade the whole team before nesting a folder. A browser tab opened
before the upgrade is refused the same way once folders nest - reload it.
