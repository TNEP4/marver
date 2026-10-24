/**
 * The shell's tokens for the app pages (spec 28 A2.2, A2.9): the token block of the marver package's
 * `src/client/shell/styles.css`, rewritten from `.sh-app` / `.sh-app.dark` to `:root` / `:root.dark`, so the
 * strip and the app pages wear exactly the shell's glass, ground and ink.
 *
 * The block is what lies between `/* @tokens *\/` and `/* @end-tokens *\/` (0.27.1 adds the markers, with the
 * Reduce Transparency and Increase Contrast rules inside). Until then: the first `.sh-app { }` and
 * `.sh-app.dark { }` rules and every `@property` rule. Fails when neither is found - the pages would lose
 * their look silently otherwise.
 */
import { readFileSync } from 'node:fs'

/** The rule starting at `open` (the index of its `{`), braces matched, as [start, end) of the whole rule. */
function ruleAt(css, selectorIndex) {
  const open = css.indexOf('{', selectorIndex)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return [selectorIndex, i + 1]
  }
  return null
}

export function extractTokens(css) {
  let block
  const a = css.indexOf('/* @tokens */')
  const b = css.indexOf('/* @end-tokens */')
  if (a >= 0 && b > a) block = css.slice(a + '/* @tokens */'.length, b)
  else {
    const light = /^\.sh-app\s*\{/m.exec(css)
    const dark = /^\.sh-app\.dark\s*\{/m.exec(css)
    if (!light || !dark) throw new Error('styles.css: no /* @tokens */ block and no .sh-app / .sh-app.dark rules - the app pages would lose their tokens')
    const parts = [ruleAt(css, light.index), ruleAt(css, dark.index)].map((r) => r && css.slice(r[0], r[1]))
    if (parts.some((p) => !p)) throw new Error('styles.css: an unbalanced token rule')
    const props = css.match(/^@property [^\n]*\}$/gm) ?? []
    block = [...parts, ...props].join('\n')
  }
  return '/* The shell\'s tokens, copied at build time from src/client/shell/styles.css (scripts/tokens.mjs). */\n' +
    block.replace(/\.sh-app\.dark\b/g, ':root.dark').replace(/\.sh-app\b/g, ':root').trim() + '\n'
}

export function tokensFrom(stylesPath) {
  return extractTokens(readFileSync(stylesPath, 'utf8'))
}
