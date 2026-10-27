/**
 * Is a More-work note only an approval ("looks good", "perfect", "ok thanks", "looks good to me", "nice work")? Then it
 * settles the review as Looks good - typed into the More work box, it must never send the work back for a run. The
 * whole note must be approval's own phrases, one after another ("looks good, thanks", "great and works well"): a word
 * of approval's in any other order may be a request ("looks good, look again") or a question ("looks good, is it
 * done") - one extra run is cheap, a request swallowed is lost. A question never is one ("is it done?"), and when the
 * reply it follows asked one, no note is: "yes, thanks", "perfect" or "looks good" may each be the answer that asks
 * for more work.
 */
const w = (...xs: string[]) => `(?:${xs.join('|')}) `
const opt = (r: string) => `(?:${r})?`
const INT = `(?:${w('really', 'very', 'so', 'super', 'much', 'way', 'a lot')})*`
const VERDICT = w('good', 'great', 'perfect', 'nice', 'fine', 'cool', 'awesome', 'excellent', 'beautiful', 'amazing', 'brilliant', 'neat', 'sweet', 'super',
  'better', 'lgtm', 'ok', 'okay', 'yes', 'yep', 'done', 'approved', 'happy')
const THIS = w('it', 'this', 'that')
/** each phrase approval is said with, as words (lower case, no punctuation) each followed by a space */
const PHRASES = [
  // "looks good", "that looks really good now", "it's perfect", "this is great work", "all good", "looks good to me", "nice work"
  `${opt(w('it', 'this', 'that', 'all', 'it all', 'this all', 'thats', 'its', 'it is', 'this is', 'that is', 'im', 'i am'))}${opt(w('looks', 'is'))}${INT}${VERDICT}${opt(w('now'))}${opt(w('to me'))}${opt(w('work', 'job', 'stuff'))}`,
  // "works", "it works now", "works really well"
  `${opt(THIS)}works ${opt(`${INT}well `)}${opt(w('now'))}`,
  // "thanks", "thanks a lot", "thank you so much"
  `${w('thanks', 'thx', 'thank you')}${opt(w('a lot', 'so much', 'very much'))}`,
  // "love it", "I really love this", "I like it" (liking is approval only as yours: "looks like a lot" is not)
  `${opt(w('i'))}${opt(w('really', 'so'))}love ${THIS}`, `i ${opt(w('really', 'so'))}like ${THIS}`,
  // "nailed it", "that's it", "ship it", "happy with it", "that's exactly what I wanted", "well done"
  `nailed ${THIS}`, `thats it `, `ship ${opt(THIS)}`, `${opt(w('im', 'i am'))}${INT}happy with ${THIS}`,
  `${opt(w('thats', 'its', 'this is', 'that is'))}exactly ${opt('what i wanted ')}`, `${w('all', 'well')}done `,
]
// phrases one after another, or joined by "and" ("looks good and works well") - "and" never joins a request here
const WHOLE = new RegExp(`^(?:(?:and )?(?:${PHRASES.join('|')}))+$`)
/** a note that opens like a question asks one, with or without its "?" */
const ASKING = new Set(['is', 'are', 'was', 'were', 'did', 'does', 'do', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'has', 'have', 'why', 'what', 'how', 'where', 'when', 'which'])
/** a question mark in any script: the ASCII one, the full-width one CJK input types, the Spanish, Arabic and Greek ones */
const QMARK = /[?\uFF1F\u00BF\u061F\u037E\u203D\u2047\u2048\u2049\uFE56]/
/** a question or an offer with no question mark: "Would you like me to...", "Should I...", "Want me to...", "...if you like" */
const OFFER = /\b(?:(?:would|should|shall|do|did|can|could|will|may) (?:you|i|we)|want me|let me know|if you(?:'d| would)? (?:like|want|prefer)|i (?:can|could) also)\b/

/** Does the agent's reply ask the owner something? A question mark of any script, a question or an offer anywhere,
 *  or a last sentence that opens like a question ("Which shade for the footer") - there a note is the answer. */
export function asks(reply: string): boolean {
  const t = reply.toLowerCase().replace(/[’‘]/g, "'")
  if (QMARK.test(t) || OFFER.test(t)) return true
  const last = t.split(/[.!\n。！]+/).map((s) => s.trim()).filter(Boolean).pop() ?? ''
  return ASKING.has(last.split(/[^a-z']+/).find(Boolean) ?? '') || /^(?:want|any|anything)\b/.test(last)
}

export function isApproval(text: string, reply?: string): boolean {
  // the reply asked something: a note answers it - that is work, not a verdict
  if (QMARK.test(text) || (reply !== undefined && asks(reply))) return false
  const t = text.toLowerCase().replace(/@marver/g, ' ').replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, '').replace(/[👍✅🙌🔥👌💯🎉]/gu, ' good ').replace(/[’‘]/g, "'")
  // anything but English words and punctuation (another script, a number, a symbol, any other emoji) may be the
  // request itself - "Looks good, 改成蓝色" asks for blue: never stripped away to leave an approval behind
  if (/[^a-z\s'".,!:;()\-–—…“”]/.test(t)) return false
  const words = t.replace(/[^a-z\s']/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 10 || ASKING.has(words[0]!)) return false
  return WHOLE.test(`${words.join(' ')} `)
}
