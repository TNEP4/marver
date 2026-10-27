/**
 * Is a More-work note only an approval ("looks good", "perfect", "ok thanks")? Then it settles the
 * review as Looks good - typed into the More work box, it must never send the work back for a run.
 */
const WORDS = new Set(['looks', 'look', 'good', 'great', 'perfect', 'nice', 'lgtm', 'ok', 'okay', 'thanks', 'thank', 'you', 'thx', 'cool', 'love', 'it', 'this', 'that', 'is', 'all', 'done', 'yes', 'yep', 'fine', 'awesome', 'excellent', 'beautiful', 'amazing', 'very', 'really', 'so', 'now', 'much', 'better', 'way', 'approved', 'ship', 'works', 'well', 'excellent', 'brilliant', 'neat', 'sweet', 'super'])
const CORE = new Set(['good', 'great', 'perfect', 'nice', 'lgtm', 'ok', 'okay', 'thanks', 'thank', 'thx', 'cool', 'love', 'awesome', 'excellent', 'beautiful', 'amazing', 'fine', 'approved', 'ship', 'works', 'brilliant', 'neat', 'sweet', 'super', 'better', 'done', 'yes', 'yep'])

export function isApproval(text: string): boolean {
  const words = text.toLowerCase().replace(/@marver/g, ' ').replace(/[^a-z\s']/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 6) return false
  return words.every((w) => WORDS.has(w)) && words.some((w) => CORE.has(w))
}
