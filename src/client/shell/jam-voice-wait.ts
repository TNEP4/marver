/**
 * When a capture's words are whole, and how long its last words are waited for (jam-voice.ts) - pure, so a test
 * holds them to it.
 */

/** A segment's last words are waited for this long after it is cut - and as long again after the speech engine was
 *  last heard from (words or a final, for any segment: it is working through what it was given - a cold start of its
 *  process, a long last phrase, other phrases ahead of it) - never past FINAL_MAX. Past it the capture seals without
 *  them, and a capture stopped with E goes straight on (27 Oct: one reached the agent with no words; the wait was a
 *  flat 3 s). A lost engine or connection answers at once, never this late. */
export const FINAL_MS = 15_000
export const FINAL_MAX = 60_000

/** How much longer to wait for a final, cut at `cut`, with the engine last heard at `heard` (ms; <= 0: stop waiting). */
export const finalWait = (cut: number, heard: number, now: number): number => Math.min(Math.max(cut, heard) + FINAL_MS, cut + FINAL_MAX) - now

/** A capture's words are whole when every segment cut for it came back final and none was lost - and, when you said
 *  yes to the microphone, when it had one at all: the engine not available, the microphone still opening (or refused)
 *  hears nothing, and those words are missing, not complete. */
export const wordsWhole = (finals: boolean[], lost: boolean, expected: boolean): boolean =>
  (finals.length > 0 || !expected) && finals.every(Boolean) && !lost
