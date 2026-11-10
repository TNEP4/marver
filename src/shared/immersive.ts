/**
 * Spec 32 C2, C5, C9, C10: immersive play's motion, one set of numbers for the shell (the stage's padding and FLIP, the
 * pills' fade), main (the strip's hide timer, `MOTION.out.strip`) and the strip's CSS (its transform and opacity, which a
 * unit test checks against these). Copied from the design (tab-strip/_immersive.tsx `MOTION`). Constants only - no
 * imports - so the app's main bundle and the shell both take it as it is.
 */
export const MOTION = {
  /** shown to hidden: the strip leaves, the pills fade, the stage grows into the room */
  out: { strip: 240, pills: 160, stage: 320, ease: 'cubic-bezier(.4, 0, .9, .6)', stageEase: 'cubic-bezier(.2, .8, .2, 1)' },
  /** hidden to shown */
  back: { strip: 260, pills: 200, stage: 300, ease: 'cubic-bezier(.15, .7, .2, 1)', stageEase: 'cubic-bezier(.2, .8, .2, 1)' },
} as const
export type Motion = typeof MOTION
