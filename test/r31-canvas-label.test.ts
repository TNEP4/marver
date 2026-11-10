import { describe, expect, it } from 'vitest'
import { canvasLabel } from '../src/shared/board-tree.ts'

describe('the canvas name on screen (spec 31 G)', () => {
  it('keeps a written name exactly, humanizes a slug', () => {
    expect(canvasLabel('iPad Lab')).toBe('iPad Lab')
    expect(canvasLabel('Starbucks CTO Brief')).toBe('Starbucks CTO Brief')
    expect(canvasLabel('Aperture')).toBe('Aperture')
    expect(canvasLabel('my-repo')).toBe('My Repo')
    expect(canvasLabel('calepin-surfaces')).toBe('Calepin Surfaces')
  })
})
