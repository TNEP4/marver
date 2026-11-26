/**
 * The drawing panel's model (spec 38): what each section shows as its current value - the selection's, else the active
 * tool's own (Nic, 26 Nov: the text tool showed no font, size or align picked).
 */
import { describe, expect, it } from 'vitest'
import { panelModel } from '../src/client/draw-host/state.ts'
import { mostUsedCustom, shadesOf } from '../src/shared/draw-colors.ts'

const text = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'text', fontFamily: 5, fontSize: 20, textAlign: 'left', verticalAlign: 'top', strokeColor: '#1e1e1e', opacity: 100, ...extra })

describe('the drawing panel model', () => {
  it("the text tool with nothing selected shows the tool's own font, size and align", () => {
    const m = panelModel([], { activeTool: { type: 'text' }, selectedElementIds: {}, currentItemFontFamily: 6, currentItemFontSize: 28, currentItemTextAlign: 'center' }, true)
    expect(m.sections).toEqual(expect.arrayContaining(['font', 'fontSize', 'align']))
    expect(m.props).toMatchObject({ fontFamily: 6, fontSize: 28, textAlign: 'center' })
  })

  it("Excalidraw's defaults when the tool has none of its own yet", () => {
    const m = panelModel([], { activeTool: { type: 'text' }, selectedElementIds: {} }, true)
    expect(m.props).toMatchObject({ fontFamily: 5, fontSize: 20, textAlign: 'left' })
  })

  it("a selected text shows its own values; two that differ show none (mixed)", () => {
    const one = panelModel([text('a', { fontSize: 36, textAlign: 'right' })], { activeTool: { type: 'selection' }, selectedElementIds: { a: true } }, true)
    expect(one.props).toMatchObject({ fontFamily: 5, fontSize: 36, textAlign: 'right' })
    const two = panelModel([text('a'), text('b', { fontSize: 28 })], { activeTool: { type: 'selection' }, selectedElementIds: { a: true, b: true } }, true)
    expect(two.props.fontSize).toBeNull()
    expect(two.props.fontFamily).toBe(5)
  })

  it("a shape's bound label gives the text values; the shape gives the stroke", () => {
    const els = [{ id: 'box', type: 'rectangle', strokeColor: '#e03131', boundElements: [{ id: 'lab', type: 'text' }] }, text('lab', { containerId: 'box', fontSize: 16, textAlign: 'center', verticalAlign: 'middle' })]
    const m = panelModel(els, { activeTool: { type: 'selection' }, selectedElementIds: { box: true } }, true)
    expect(m.props).toMatchObject({ strokeColor: '#e03131', fontSize: 16, textAlign: 'center', verticalAlign: 'middle' })
    expect(m.sections).toContain('valign')
  })

  it("reports the drawing's own custom colours (most used first, palette ones left out) and its fonts", () => {
    const els = [
      { id: 'a', type: 'rectangle', strokeColor: '#123456', backgroundColor: '#ffec99' },
      { id: 'b', type: 'ellipse', strokeColor: '#123456', backgroundColor: '#abcdef' },
      { id: 'c', type: 'arrow', strokeColor: '#e03131', backgroundColor: '#999999' },
      text('t1', { fontFamily: 8 }), text('t2', { fontFamily: 8 }), text('t3', { fontFamily: 5 }),
    ]
    const m = panelModel(els, { activeTool: { type: 'selection' }, selectedElementIds: {} }, true)
    expect(m.used.stroke).toEqual(['#123456'])                 // #e03131 and the text black are the palette's
    expect(m.used.background).toEqual(['#abcdef'])             // #ffec99 is a palette shade; an arrow has no background
    expect(m.used.fonts).toEqual([8, 5])
  })

  it('a colour of the palette has its hue\'s five shades; black, white and custom ones have none', () => {
    expect(shadesOf('#FFEC99')).toEqual(['#fff9db', '#ffec99', '#ffd43b', '#fab005', '#f08c00'])
    expect(shadesOf('#1e1e1e')).toBeNull()
    expect(shadesOf('#123456')).toBeNull()
    expect(mostUsedCustom(['#111', '#222', '#222', 'transparent', null], 1)).toEqual(['#222'])
  })
})
