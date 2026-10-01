# Sticky notes

A sticky note is the aside beside a frame: a yellow note left of it on the canvas, in dev and on
every published or shared canvas, that says what the screen cannot - what the frame is for, how
two variations differ, how a mechanism works, an open question. Reviewers read it, click its links,
and comment on its text exactly as they comment on a frame.

## Writing one

One markdown file, nothing to declare:

| For | File |
|---|---|
| a frame `checkout/cart` (`cart.tsx`, `.jsx` or `.html`) | `design/scenes/checkout/cart.note.md` |
| a scene `checkout` | `design/scenes/checkout/_note.md` (beside the scene's first frame on the board) |
| a component frame | `design/components/<name>.note.md` |

Markdown with the Md block's rules: headings, lists, tables, emphasis, code; `[text](goto:scene/frame)`
links jump to a frame; `http(s)` links open a new tab; images come from `design/assets/`; raw HTML is
inert. A scene note is 380 wide, a frame note 260; when a frame has both, they stack in one column,
scene first. An edit lands on the canvas as you save, without reloading the frame.

The room is the layout's job. Every layout the shell composes (a board's `layout` recipe, the auto
board, tidy, device views) reserves the note's width in front of its frame and its height below it:
a note longer than its frame runs on under the card, and the row beneath starts under the note, the
gutter unchanged. A note landing on a board already composed re-applies the recipe so the frames
make way - whether the board is open at the time or not - and so does a note that grows. Nobody
moves frames for a note. A board dragged by hand keeps its positions; `t` makes the room there.

## Diagrams

A ```mermaid fence renders hand-sketched on the paper: rough boxes, hatched fills, handwriting
labels, one ink. Write plain mermaid - no `%%{init}%%`, theme, colours or `style` lines, no URLs or
images in the source. Every family works; flowchart, sequence, state, class, ER, pie and mindmap
read best at note width, while gantt, journey, timeline, quadrant and git graphs are wide by nature
and want few items. This look is the note's alone: the `Diagram` block in content frames keeps its
own theme.

## Reading one

- Fold: the dog-ear at the note's corner folds the column to a tab; the tab brings it back.
- `N` hides every note on the canvas and shows them again.
- Both are per viewer, in the browser - never saved to the board, never shared.
- Comments: in comment mode (`C`) click any element of a note; the pin sits on the note, follows a
  fold onto the tab, and the thread card opens beside the column.

## On a slide

Beside a slide (`slide: true`), the note is the presenter's script and the next agent's memory,
and the [slides guide](slides.md) teaches agents to write it in four short parts - **Aim** (what the
slide must do in the argument), **Say** (the talk track), **Visual** (what the image or drawing
carries) and **Source context** (where the facts come from, and their limits) - so the slide itself
can stay sparse. A note ships with a published canvas like any other: keep anything the audience
must not read out of it.

## What it is not

A note is an aside, a screen's worth of reading at most. Specs, flows and mood boards stay content
frames on the board.
