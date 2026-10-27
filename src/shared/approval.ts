/**
 * Is a More-work note only "looks good"? Then it settles the review as Looks good instead of running the work again.
 * The whole note must BE one phrase of this list once lower-cased, trimmed, and its trailing punctuation and approving
 * emoji dropped: one word more, another script, a digit - it goes to the agent as More work. An extra run is cheap; a
 * request swallowed as approval is lost. By design the agent's reply is never read: after a reply that offered more
 * ("Want me to do the footer too?") "looks good" settles it - the owner said looks good, not yes - and no answer to a
 * question ("yes", "ok", "sure") is on the list.
 */
const PHRASES = new Set(['looks good', 'looks great', 'looks good to me', 'lgtm', 'perfect', 'great', 'great job', 'nice',
  'nice work', 'love it', 'thanks', 'thank you', 'looks good thanks', 'looks great thanks', 'looks good, thanks',
  'looks great, thanks', 'approved', 'good', 'good job', 'well done', '👍', '👌', '✅'])

/** trailing punctuation, skin tones and variation selectors - and, in the second pass, the approving emoji too */
const TAIL = /[\s.!,;:…\u{1F3FB}-\u{1F3FF}️]+$/u
const TAIL_EMOJI = /[\s.!,;:…\u{1F3FB}-\u{1F3FF}️👍👌✅]+$/u

export function isApproval(note: string): boolean {
  const t = note.toLowerCase().replace(/\s+/g, ' ').trim()
  return PHRASES.has(t.replace(TAIL_EMOJI, '')) || PHRASES.has(t.replace(TAIL, ''))
}
