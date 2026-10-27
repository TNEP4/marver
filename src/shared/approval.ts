/**
 * Is a More-work note only an approval ("looks good", "perfect", "ok thanks", "looks good to me", "nice work")? Then it
 * settles the review as Looks good - typed into the More work box, it must never send the work back for a run. Every
 * word must be one of approval's own (a change, a negation or a request is never in the set); a question never is
 * ("is it done?"), and a bare "yes" or "ok" is an answer, not an approval, when the reply it follows asked one.
 */
const WORDS = new Set(['looks', 'look', 'good', 'great', 'perfect', 'nice', 'lgtm', 'ok', 'okay', 'thanks', 'thank', 'you', 'thx', 'cool', 'love', 'it', 'this', 'that', 'is', 'all', 'done', 'yes', 'yep', 'fine', 'awesome', 'excellent', 'beautiful', 'amazing', 'very', 'really', 'so', 'now', 'much', 'better', 'way', 'approved', 'ship', 'works', 'well', 'brilliant', 'neat', 'sweet', 'super',
  // "looks good to me", "nice work", "great job", "that's perfect", "it's great", "I love it", "exactly what I wanted", "thanks a lot", "nailed it", "good stuff", "happy with it"
  'to', 'me', 'i', 'a', 'lot', 'work', 'job', 'stuff', 'thats', 'its', 'im', 'exactly', 'what', 'wanted', 'like', 'nailed', 'again', 'happy', 'with'])
const CORE = new Set(['good', 'great', 'perfect', 'nice', 'lgtm', 'ok', 'okay', 'thanks', 'thank', 'thx', 'cool', 'love', 'awesome', 'excellent', 'beautiful', 'amazing', 'fine', 'approved', 'ship', 'works', 'brilliant', 'neat', 'sweet', 'super', 'better', 'done', 'yes', 'yep', 'exactly', 'nailed', 'happy'])
/** what answers a question ("Want me to do the footer too?" - "yes") */
const ANSWERS = new Set(['yes', 'yep', 'ok', 'okay', 'fine', 'sure'])
/** a note that opens like a question asks one, with or without its "?" */
const ASKING = new Set(['is', 'are', 'was', 'were', 'did', 'does', 'do', 'can', 'could', 'would', 'should', 'will', 'has', 'have', 'why', 'what', 'how', 'where', 'when', 'which'])

export function isApproval(text: string, reply?: string): boolean {
  if (text.includes('?')) return false
  const words = text.toLowerCase().replace(/@marver/g, ' ').replace(/[👍✅🙌🔥👌💯🎉]/gu, ' good ').replace(/[’‘]/g, "'").replace(/[^a-z\s']/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 10 || ASKING.has(words[0]!)) return false
  if (!words.every((w) => WORDS.has(w))) return false
  const core = words.filter((w) => CORE.has(w))
  // "I like it": liking is approval only as yours ("looks like a lot" is not)
  if (/\bi (really |so )?like\b/.test(words.join(' '))) core.push('like')
  if (!core.length) return false
  // the reply asked something: "yes" or "ok" alone answers it - that is work, not a verdict
  return !(reply?.includes('?') && core.every((w) => ANSWERS.has(w)))
}
