/**
 * What the shell's panel shows for a drawing (spec 38): which sections, and their values - Excalidraw's own rules for
 * which properties a type has (its SelectedShapeActions), read from the selection, else from the tool in hand
 * (`currentItem*`). Pure: no DOM, no Excalidraw import.
 */
import type { DrawProps, DrawSection, DrawTool, DrawUsed } from '../../shared/draw-protocol.ts'
import { mostUsedCustom } from '../../shared/draw-colors.ts'

const STROKE_COLOR = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'embeddable', 'iframe'])
const BACKGROUND = new Set(['rectangle', 'diamond', 'ellipse', 'line', 'freedraw', 'embeddable', 'iframe'])
const STROKE_WIDTH = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'embeddable', 'iframe'])
const STROKE_STYLE = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'embeddable', 'iframe'])
const SLOPPINESS = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'embeddable', 'iframe'])
const ROUNDNESS = new Set(['rectangle', 'diamond', 'line', 'image', 'embeddable', 'iframe'])
const SHAPE_TOOLS = new Set<DrawTool>(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text'])

interface El { id: string; type: string; isDeleted?: boolean; containerId?: string | null; boundElements?: { id: string; type: string }[] | null; groupIds?: string[]; link?: string | null; [k: string]: unknown }

/** One value across the targets, or null when they differ. */
function common<T>(targets: El[], read: (e: El) => T | undefined): T | null {
  let v: T | undefined
  for (const t of targets) {
    const x = read(t)
    if (x === undefined) continue
    if (v === undefined) v = x
    else if (v !== x) return null
  }
  return v ?? null
}

export interface PanelModel { sections: DrawSection[]; props: DrawProps; used: DrawUsed; sel: { count: number; types: string[]; hasLink: boolean; isLinear: boolean; grouped: boolean } }

export function panelModel(elements: readonly El[], appState: any, editable: boolean): PanelModel {
  const live = elements.filter((e) => !e.isDeleted)
  const byId = new Map(live.map((e) => [e.id, e]))
  const selectedIds = Object.keys(appState?.selectedElementIds ?? {}).filter((id) => appState.selectedElementIds[id])
  // typing in a text (a label inside a shape too): Excalidraw clears the selection while it edits, yet keeps the text's
  // panel up - the text being edited is what the panel shows (Nic, 26 Nov)
  const editing = appState?.editingTextElement as El | null | undefined
  const editEl = editing?.id ? (byId.get(editing.id) ?? editing) : null
  const selected = editEl ? [editEl] : selectedIds.map((id) => byId.get(id)).filter((e): e is El => !!e)
  // a bound text belongs to its container: text properties come from the text, shape ones from the container
  const boundTexts = selected.flatMap((c) => (c.boundElements ?? []).filter((b) => b.type === 'text').map((b) => byId.get(b.id)).filter((e): e is El => !!e))
  const tool: DrawTool = appState?.activeTool?.type ?? 'selection'
  const virtual: El[] = !selected.length && SHAPE_TOOLS.has(tool) ? [{ id: '', type: tool }] : []
  const targets = selected.length ? selected : virtual
  const types = [...new Set(targets.map((t) => t.type))]
  const has = (set: Set<string>) => targets.some((t) => set.has(t.type))
  const texts = [...targets.filter((t) => t.type === 'text'), ...boundTexts]
  const hasText = texts.length > 0 || types.includes('text')

  const ai = appState ?? {}
  const pick = <T,>(read: (e: El) => T | undefined, current: T): T | null => (selected.length ? common(targets, read) : current)
  // the text tool with nothing selected shows the tool's own values (the placeholder target has no font, size or align)
  const selectedTexts = [...selected.filter((t) => t.type === 'text'), ...boundTexts]
  const textPick = <T,>(read: (e: El) => T | undefined, current: T): T | null => (selectedTexts.length ? common(selectedTexts, read) : current)
  const props: DrawProps = {
    strokeColor: pick((e) => e.strokeColor as string, ai.currentItemStrokeColor ?? '#1e1e1e'),
    backgroundColor: pick((e) => (BACKGROUND.has(e.type) ? e.backgroundColor as string : undefined), ai.currentItemBackgroundColor ?? 'transparent'),
    fillStyle: pick((e) => (BACKGROUND.has(e.type) ? e.fillStyle as DrawProps['fillStyle'] : undefined), ai.currentItemFillStyle ?? 'solid') as DrawProps['fillStyle'],
    strokeWidth: pick((e) => (STROKE_WIDTH.has(e.type) ? e.strokeWidth as number : undefined), ai.currentItemStrokeWidth ?? 2),
    strokeStyle: pick((e) => (STROKE_STYLE.has(e.type) ? e.strokeStyle as DrawProps['strokeStyle'] : undefined), ai.currentItemStrokeStyle ?? 'solid') as DrawProps['strokeStyle'],
    roughness: pick((e) => (SLOPPINESS.has(e.type) ? e.roughness as number : undefined), ai.currentItemRoughness ?? 1),
    roundness: pick((e) => (ROUNDNESS.has(e.type) ? (e.roundness ? 'round' : 'sharp') : undefined), ai.currentItemRoundness ?? 'round') as DrawProps['roundness'],
    arrowType: pick((e) => (e.type === 'arrow' ? (e.elbowed ? 'elbow' : e.roundness ? 'round' : 'sharp') : undefined), ai.currentItemArrowType ?? 'round') as DrawProps['arrowType'],
    startArrowhead: pick((e) => (e.type === 'arrow' ? (e.startArrowhead as string | null) ?? 'none' : undefined), ai.currentItemStartArrowhead ?? 'none'),
    endArrowhead: pick((e) => (e.type === 'arrow' ? (e.endArrowhead as string | null) ?? 'none' : undefined), ai.currentItemEndArrowhead ?? 'arrow'),
    fontFamily: textPick((e) => e.fontFamily as number, ai.currentItemFontFamily ?? 5),
    fontSize: textPick((e) => e.fontSize as number, ai.currentItemFontSize ?? 20),
    textAlign: textPick((e) => e.textAlign as DrawProps['textAlign'], ai.currentItemTextAlign ?? 'left') as DrawProps['textAlign'],
    verticalAlign: textPick((e) => e.verticalAlign as DrawProps['verticalAlign'], 'middle') as DrawProps['verticalAlign'],
    opacity: pick((e) => e.opacity as number, ai.currentItemOpacity ?? 100),
  }

  const sections: DrawSection[] = []
  if (editable && targets.length) {
    if (has(STROKE_COLOR)) sections.push('stroke')
    if (has(BACKGROUND)) {
      sections.push('background')
      if (props.backgroundColor && props.backgroundColor !== 'transparent') sections.push('fill')
    }
    if (has(STROKE_WIDTH)) sections.push('width')
    if (has(STROKE_STYLE)) sections.push('style')
    if (has(SLOPPINESS)) sections.push('sloppiness')
    if (has(ROUNDNESS)) sections.push('edges')
    if (types.includes('arrow')) sections.push('arrowType', 'arrowheads')
    if (hasText) {
      sections.push('font', 'fontSize', 'align')
      if (boundTexts.length || (selected.some((s) => s.type === 'text' && s.containerId))) sections.push('valign')
    }
    sections.push('opacity')
    // while typing: Layers, as Excalidraw - no Duplicate or Delete under the caret
    if (selected.length) sections.push(...(editEl ? ['layers' as const] : ['layers' as const, 'actions' as const]))
    if (selected.length >= 2) sections.push('alignment')
  }
  // what the drawing itself uses: its custom colours (the pickers' Most used) and its fonts (the font picker's In this drawing)
  const fontCount = new Map<number, number>()
  for (const e of live) if (e.type === 'text' && typeof e.fontFamily === 'number') fontCount.set(e.fontFamily as number, (fontCount.get(e.fontFamily as number) ?? 0) + 1)
  const used: DrawUsed = {
    stroke: mostUsedCustom(live.map((e) => e.strokeColor as string)),
    background: mostUsedCustom(live.filter((e) => BACKGROUND.has(e.type)).map((e) => e.backgroundColor as string)),
    fonts: [...fontCount].sort((a, b) => b[1] - a[1]).map(([f]) => f),
  }
  return {
    sections,
    props,
    used,
    sel: {
      count: selected.length,
      types,
      hasLink: selected.length === 1 && !!selected[0].link,
      isLinear: selected.length === 1 && (selected[0].type === 'arrow' || selected[0].type === 'line'),
      grouped: selected.some((s) => (s.groupIds ?? []).length > 0),
    },
  }
}
