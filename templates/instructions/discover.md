# Discover - understand before you draw

Run this phase for any NEW surface, feature, or project. Skip it only when a brief
already answers everything below. Its output is a written brief; nothing gets designed
until the brief has a human nod.

## 1. Read the repo, then interview

First inspect what exists: the app's screens, components, theme, copy, and any brief
or README - questions the repo answers are never asked. THEN ask at most five
questions, in one message; never CSS values or aesthetic lanes. Ask what changes the
work:

1. **Who** must this serve, and in what scene (device, ambient light, attention level)?
2. **The one job**: what should a visitor be able to decide, complete, understand, or
   feel? (One job. If you get three, ask which one wins.)
3. **The core flow**: entry → the moment of value → done. What are the 3-6 screens?
4. **What exists**: real content, brand assets, an app, competitors they respect?
5. **Out of scope**: what must NOT be touched or built?

## 2. Pick the mode - it drives every later decision

Name the surface's mode in the brief. The mode is the visitor's success:

- **Persuade** - the visitor decides and acts (landing, pricing, campaign). The offer
  and the action must be legible in the first viewport.
- **Operate** - the visitor completes a task (app UI, dashboard, settings). Scanability
  and native expectations outrank expression.
- **Read** - the visitor understands (docs, guides). Structure for comprehension.
- **Experience** - the visitor is inside the work (portfolio, gallery). The artifact
  leads; the interface recedes.

A tool's landing page is Persuade. A fashion house's docs are Read. The mode belongs
to the SURFACE, not the product.

## 3. Write the brief

Create `design/scenes/<scene>/_brief.md`: audience + scene, the one job, mode, the
flow as a numbered list, content sources, out-of-scope. Ten lines, not a document.
Show it. Get the nod.

## 4. Align on flow with a diagram frame

When the flow has branches or more than four screens, draw it before wireframing:
one frame (`<scene>/flow.tsx`) of labeled boxes and arrows - plain divs and SVG lines,
grayscale, no dependency. Each box names a future frame. The human can look at one
picture and say "step 3 is wrong" before step 3 costs anything.

Then move to Wireframe. Do not brand, do not pick type, do not open the craft rules
yet - those phases come after the flow and words are agreed.
