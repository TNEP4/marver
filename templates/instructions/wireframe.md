# Wireframe - nail structure and words while changes are cheap

Lo-fi is for NEW work: a new site, feature, flow, or page where the question is
"what is on this screen and in what order", not "how does it look". Skipping it on
new work means debating typography over a structure nobody agreed to. Skip it only
when the structure is already settled (a refinement of an existing screen goes
straight to Build).

## What lo-fi is deciding

Structure and copy. Nothing else. The flow's screens, each screen's content and
order, and the actual words. Everything visual is deliberately withheld so feedback
lands on what is actually being decided.

## The rules (strict)

1. **Throwaway code is correct here.** Plain divs, inline layout, one file per frame.
   Do NOT build proper components for wireframes and do NOT touch the app's
   `components/` directory - lo-fi structure hardening into real components is how
   throwaway decisions become permanent. If the app already has branded components,
   you MAY compose with them as-is (a real Button is a fine box) - never restyle
   them for the wireframe.
2. **No new visual decisions.** Grayscale, system font, sharp corners, 1px borders,
   no shadows. Existing components keep their look; you just don't ADD any. The frame
   should read as unfinished - polish invites feedback on the wrong layer.
3. **Real copy, always.** Copy IS the design at this stage - headlines, button labels,
   error messages. Lorem ipsum decides nothing; write words the shipped product could
   use, and expect them to be edited.
4. **Boxes for images.** A gray box with a one-word label ("hero photo", "avatar").
   Never source or generate imagery in this phase.
5. **Every screen reachable.** Wire the flow with `data-goto` as you go. A wireframe
   that cannot be walked end-to-end in play mode (press P) is not done.
6. **States are structure.** empty / error / loading as sibling frames for any screen
   where they meaningfully differ - "what does empty look like" is a structural
   decision, not polish.

## Variants

Diverging on structure? Versions are sibling frames in one scene, ordered by prefix:
`landing/a-single-column.tsx`, `landing/b-split.tsx`. Name variants by their
structural idea. Two or three real alternatives beat five shades of one.

## Exit criteria

Move on only when: the human has walked the flow in play mode, the copy has been
read and edited, and one structure per surface has won. Then Brand (if the world is
unsettled) or Build (if it is). The winning wireframe EVOLVES into the hi-fi frame -
same file, same id, rebuilt from real components - so links and boards survive. The
losing variants get deleted, not archived; the flow diagram stays as documentation.
