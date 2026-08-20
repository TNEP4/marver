<!-- marver:managed 74631f5ad401327af4faf9e30bd5c87cce40c2b30ebd6ca994c212f66d176450 - edit freely: init preserves your edits and stages upstream updates at design/.local/latest/ for you to merge. Delete this line to detach this file from updates entirely. -->
# Critique - the structured review pass

For a real review (the human asked "review this", or you are gating your own work
before a milestone). Think like a design director: the deliverable is a written
critique, not a pile of nitpicks.

## Start with the specificity verdict

Before anything else, answer: **could a neighboring product use this design
unchanged?** Cover coherence, structural sameness, category-interchangeable choices,
and missed opportunities for product character. This is the single most predictive
question for AI-generated design - answer it before any checklist can anchor you.

## Score the ten heuristics (0-4 each)

| # | Heuristic | Asks |
|---|---|---|
| 1 | Visibility of system status | does the UI always show what is happening? |
| 2 | Match to the real world | user's language and concepts, not the system's? |
| 3 | User control and freedom | undo, escape hatches, no traps? |
| 4 | Consistency and standards | same thing looks and acts the same everywhere? |
| 5 | Error prevention | dangerous actions guarded before, not apologized after? |
| 6 | Recognition over recall | options visible, nothing memorized between screens? |
| 7 | Flexibility and efficiency | shortcuts for the fluent, defaults for the new? |
| 8 | Aesthetic and minimalist | every element earns its place? |
| 9 | Error recovery | errors named plainly with a way out? |
| 10 | Help and documentation | help where it is needed, when it is needed? |

Be honest: 4 means genuinely excellent and should be rare - an all-4 row means the
review did not look hard enough, not that the interface is perfect.
Mark a heuristic n/a with a one-line reason when it truly cannot apply (7 and 10
often on marketing surfaces) and renormalize the total to the applicable maximum.

## Two more lenses

- **Cognitive load**: flag decision points where options compete undifferentiated
  (no default, no grouping, no visible consequence - a labeled menu of twelve is
  fine; four equal-weight buttons with vague labels are not), and any screen where
  the user must remember something from a previous screen.
- **Emotional journey**: peak-end rule - what is the peak moment and what is the
  exit moment? Reassurance present at high-stakes points (payment, deletion, send)?

## Report format

1. Specificity verdict (one paragraph, first).
2. Heuristic table with per-row key issue.
3. **What works** - 2-3 things, specific about WHY they work.
4. **Priority issues** - 3-5, ordered, each tagged P0 (blocks/misleads) to P3 (nit),
   with: what, why it matters, and a concrete fix.
5. One provocative question the team should sit with.

Never bury the diagnosis: if the concept itself is wrong, the report says so at the
top and recommends re-entering Wireframe - a P0 concept issue outranks every P2 list.
