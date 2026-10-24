/** The shell's tokens for the app pages (scripts/tokens.mjs; spec 28 A2.2, A2.9). */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractTokens } from '../../scripts/tokens.mjs'

const STYLES = resolve(import.meta.dirname, '..', '..', '..', 'src', 'client', 'shell', 'styles.css')

describe('extractTokens', () => {
  it('copies the shell\'s token rules as :root and :root.dark', () => {
    const css = extractTokens(readFileSync(STYLES, 'utf8'))
    expect(css).toMatch(/^:root \{/m)
    expect(css).toMatch(/^:root\.dark \{/m)
    expect(css).toContain('--ground')
    expect(css).toContain('--glass-brd')
    expect(css).not.toContain('.sh-app')
  })

  it('takes exactly the marked block once 0.27.1 marks it', () => {
    const css = '.x { color: red }\n/* @tokens */\n.sh-app { --a: 1 }\n.sh-app.dark { --a: 2 }\n@media (prefers-contrast: more) { .sh-app { --a: 3 } }\n/* @end-tokens */\n.sh-app .y { }\n'
    const out = extractTokens(css)
    expect(out).toContain(':root { --a: 1 }')
    expect(out).toContain(':root.dark { --a: 2 }')
    expect(out).toContain('@media (prefers-contrast: more) { :root { --a: 3 } }')
    expect(out).not.toContain('.x')
    expect(out).not.toContain('.y')
  })

  it('refuses a stylesheet with neither the markers nor the rules', () => {
    expect(() => extractTokens('.other { }')).toThrow(/tokens/)
  })
})

// the source the build reads is where the test says it is
it('reads the package\'s own styles.css', () => {
  expect(readFileSync(join(STYLES), 'utf8').length).toBeGreaterThan(1000)
})
