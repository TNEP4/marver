/**
 * Is a More-work note only an approval ("looks good", "perfect", "ok thanks", "looks good to me", "nice work")? Then it
 * settles the review as Looks good - typed into the More work box, it must never send the work back for a run. Every
 * word must be one of approval's own (a change, a negation or a request is never in the set); a question never is
 * ("is it done?"), and when the reply it follows asked one, no note is: "yes, thanks", "perfect" or "looks good" may
 * each be the answer that asks for more work - a request swallowed as approval is lost, one extra run is not.
 */
const WORDS = new Set(['looks', 'look', 'good', 'great', 'perfect', 'nice', 'lgtm', 'ok', 'okay', 'thanks', 'thank', 'you', 'thx', 'cool', 'love', 'it', 'this', 'that', 'is', 'all', 'done', 'yes', 'yep', 'fine', 'awesome', 'excellent', 'beautiful', 'amazing', 'very', 'really', 'so', 'now', 'much', 'better', 'way', 'approved', 'ship', 'works', 'well', 'brilliant', 'neat', 'sweet', 'super',
  // "looks good to me", "nice work", "great job", "that's perfect", "it's great", "I love it", "exactly what I wanted", "thanks a lot", "nailed it", "good stuff", "happy with it"
  'to', 'me', 'i', 'a', 'lot', 'work', 'job', 'stuff', 'thats', 'its', 'im', 'exactly', 'what', 'wanted', 'like', 'nailed', 'again', 'happy', 'with',
  // "looks good and works well" - joining only these words, never a request
  'and'])
const CORE = new Set(['good', 'great', 'perfect', 'nice', 'lgtm', 'ok', 'okay', 'thanks', 'thank', 'thx', 'cool', 'love', 'awesome', 'excellent', 'beautiful', 'amazing', 'fine', 'approved', 'ship', 'works', 'brilliant', 'neat', 'sweet', 'super', 'better', 'done', 'yes', 'yep', 'exactly', 'nailed', 'happy'])
/** a note that opens like a question asks one, with or without its "?" */
const ASKING = new Set(['is', 'are', 'was', 'were', 'did', 'does', 'do', 'can', 'could', 'would', 'should', 'will', 'has', 'have', 'why', 'what', 'how', 'where', 'when', 'which'])

export function isApproval(text: string, reply?: string): boolean {
  // the reply asked something: a note answers it - that is work, not a verdict
  if (text.includes('?') || reply?.includes('?')) return false
  const words = text.toLowerCase().replace(/@marver/g, ' ').replace(/[👍✅🙌🔥👌💯🎉]/gu, ' good ').replace(/[’‘]/g, "'").replace(/[^a-z\s']/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 10 || ASKING.has(words[0]!)) return false
  if (!words.every((w) => WORDS.has(w))) return false
  const core = words.filter((w) => CORE.has(w))
  // "I like it": liking is approval only as yours ("looks like a lot" is not)
  if (/\bi (really |so )?like\b/.test(words.join(' '))) core.push('like')
  return core.length > 0
}
