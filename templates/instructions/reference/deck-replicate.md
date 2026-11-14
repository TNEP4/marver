# Replicating a deck in a third-party tool

Run this when the human wants a Marver deck rebuilt in another presentation
tool, so other people can edit it and work on it together. It works in any
tool your session can drive through a good MCP or API: Google Slides,
PowerPoint (or a `.pptx` file you write), Keynote, Canva, and the like. Use
the human's own access, and say what you will create, and where, before you
create it. A PDF is not this (slides.md, "A deck as a PDF").

## The rule: native and atomic

Rebuild every slide from the tool's own components, one element at a time:
every text a text box, every shape a shape, every line a line, every table a
table, every chart a chart (or the shapes and text that draw it), every
image an image. Never paste a picture of a slide, or of any part of one that
holds text, shapes or lines. A picture is only for what was a picture on the
slide already: a photo, an illustration. The test is simple: a colleague
clicks any word or shape and changes it.

Keep it one to one: the same positions, sizes, fonts, colours, line breaks
and stacking as the slide. Read them off the rendered slide (open it alone at
its stage size, `/__mv/frame/?id=<scene/frame>`, and measure), not from the
code. Scale every length to the tool's page, font sizes included. Group what
moves together, such as a card and its label. Copy each slide's speaker notes.

## The trap: text centred vertically

What you measure in the browser and what the tool draws place text
differently: the browser sets glyphs inside the line height, a slide tool
from the top of its box, after an inner padding you often cannot see. Text
lands too high or too low, and the layout no longer lines up.

So **anchor every text box to the middle**, put the box's centre on the
centre of the text you measured, and make the box a little taller than the
text. The text then sits where the slide had it, whatever the tool's padding
and font metrics. Keep the slide's line breaks and turn autofit off.

## Check it, then say what differs

Render each rebuilt slide in the tool and compare it with
`npx marver shot <scene/frame>`. Fix what moved. Then tell the human where
the deck is and anything that is not native or not exact: a picture you
kept and why, a font their readers must install, an effect the tool cannot
draw.
