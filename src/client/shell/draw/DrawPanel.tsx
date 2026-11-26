/**
 * The properties panel (spec 38, the approved 232 px layout): only what the selection - or the tool in hand - can
 * change, in Excalidraw's own sections. Every control runs Excalidraw's own action in the frame (adapter.ts), so its
 * rules (text re-measure, elbow routing, z-order) hold. Pickers open beside the panel, level with their row.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { DrawAction, DrawProps, DrawState } from '../../../shared/draw-protocol.ts'
import { ArrowKind, BGS, Corner, Distribute, EditPoints, FONTS, FillIcon, HEADS, HEAD_LABEL, HeadIcon, HoverTip, Ln, PALETTE, Ph, STROKES, Sw, VAlign, colorName, loadPreviewFonts, previewFamily, type Head } from './kit.tsx'
import { shadesOf } from '../../../shared/draw-colors.ts'
import { drawSend, type DrawLink } from './link.ts'

type Picker = 'stroke' | 'background' | 'font' | 'start' | 'end'

export function DrawPanel({ link, state, top, popSide = 'right', style, cam }: {
  link: DrawLink
  state: DrawState | undefined
  /** content placed at the top of the same glass (play's left panel: the drawing's name over its properties) */
  top?: ReactNode
  popSide?: 'right' | 'left'
  style?: CSSProperties
  cam?: boolean
}) {
  const [open, setOpen] = useState<Picker | null>(null)
  const [moreHeads, setMoreHeads] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const [popTop, setPopTop] = useState(0)
  const sections = state?.sections ?? []
  const p = state?.props
  useLayoutEffect(() => {
    const el = panel.current
    if (!el || !open) return
    const row = el.querySelector<HTMLElement>('[data-pop]')
    setPopTop(row ? row.offsetTop - 10 : 0)
  }, [open, sections.join()])
  // a picker closes on a click elsewhere or Escape; it also closes when its section goes away
  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => { if (!anchor.current?.contains(e.target as Node)) setOpen(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    addEventListener('pointerdown', off, true); addEventListener('keydown', key, true)
    return () => { removeEventListener('pointerdown', off, true); removeEventListener('keydown', key, true) }
  }, [open])
  useEffect(() => {
    if (open === 'stroke' && !sections.includes('stroke')) setOpen(null)
    if (open === 'background' && !sections.includes('background')) setOpen(null)
    if ((open === 'start' || open === 'end') && !sections.includes('arrowheads')) setOpen(null)
    if (open === 'font' && !sections.includes('font')) setOpen(null)
  }, [sections.join(), open])

  if (!state || (!sections.length && !top)) return null
  const act = (name: DrawAction, value?: unknown) => drawSend(link, { op: 'action', name, value })
  const has = (s: string) => sections.includes(s as never)

  const seg = (items: ReactNode[], values: unknown[], current: unknown, tips: (string | [string, string])[], onPick: (v: unknown, i: number) => void, openAt?: number) => (
    <div className="dk-seg">{items.map((it, i) => {
      const t = tips[i], [label, key] = Array.isArray(t) ? t : [t, undefined]
      return (
        <HoverTip key={i} label={label} keys={key} side="top">
          <button className={[values[i] === current ? 'on' : '', openAt === i ? 'open' : ''].join(' ').trim() || undefined} aria-label={label} onClick={() => onPick(values[i], i)}>{it}</button>
        </HoverTip>
      )
    })}</div>
  )
  const swatches = (lb: string, list: string[], cur: string | null, which: 'stroke' | 'background') => (
    <div className="sec" key={which} {...(open === which ? { 'data-pop': '' } : {})}>
      <div className="lb">{lb}</div>
      <div className="dk-sws">
        {list.map((c) => <Sw key={c} c={c} on={!!cur && cur.toLowerCase() === c && open !== which} onClick={() => setColor(which, c)} />)}
        <i className="vsep" />
        <Sw c={cur ?? 'transparent'} cls={` cur${open === which ? ' open' : ''}`} title={cur ? `${colorName(cur)} - more colours` : 'Mixed - more colours'} onClick={() => setOpen(open === which ? null : which)} />
      </div>
    </div>
  )
  const setColor = (which: 'stroke' | 'background', c: string) => {
    if (which === 'stroke') act('changeStrokeColor', { currentItemStrokeColor: c })
    else act('changeBackgroundColor', { currentItemBackgroundColor: c })
  }

  const out: ReactNode[] = []
  const textOnly = state.sel.types.length > 0 && state.sel.types.every((t) => t === 'text')
  if (has('stroke')) out.push(swatches(textOnly ? 'Text colour' : 'Stroke', STROKES, p!.strokeColor, 'stroke'))
  if (has('background')) out.push(swatches('Background', BGS, p!.backgroundColor, 'background'))
  if (has('fill')) out.push(
    <div className="sec solo" key="fill"><div className="lb">Fill</div>
      {seg([<FillIcon k="hachure" />, <FillIcon k="cross" />, <FillIcon k="solid" />], ['hachure', 'cross-hatch', 'solid'], p!.fillStyle, ['Hachure', 'Cross-hatch', 'Solid'], (v) => act('changeFillStyle', v))}
    </div>,
  )
  const pairs: [string, string][] = [['width', 'style'], ['sloppiness', 'edges'], ['sloppiness', 'arrowType'], ['font', 'fontSize'], ['align', 'valign']]
  const cells: Record<string, () => [string, ReactNode]> = {
    width: () => ['Stroke width', seg([<Ln w={1} />, <Ln w={2.2} />, <Ln w={4} />], [1, 2, 4], p!.strokeWidth, ['Thin', 'Bold', 'Extra bold'], (v) => act('changeStrokeWidth', v))],
    style: () => ['Stroke style', seg([<Ln w={2} />, <Ln w={2} dash="4 3" />, <Ln w={2} dash="0.5 3.5" />], ['solid', 'dashed', 'dotted'], p!.strokeStyle, ['Solid', 'Dashed', 'Dotted'], (v) => act('changeStrokeStyle', v))],
    sloppiness: () => ['Sloppiness', seg([<Ln w={1.6} />, <Ln w={1.6} wob={1.2} />, <Ln w={1.6} wob={2.4} />], [0, 1, 2], p!.roughness, ['Architect', 'Artist', 'Cartoonist'], (v) => act('changeSloppiness', v))],
    edges: () => ['Edges', seg([<Corner />, <Corner round />], ['sharp', 'round'], p!.roundness, ['Sharp', 'Round'], (v) => act('changeRoundness', v))],
    arrowType: () => ['Arrow type', seg([<ArrowKind k="sharp" />, <ArrowKind k="round" />, <ArrowKind k="elbow" />], ['sharp', 'round', 'elbow'], p!.arrowType, ['Sharp arrow', 'Curved arrow', 'Elbow arrow'], (v) => act('changeArrowType', v))],
    font: () => {
      const quick = [5, 6, 8]
      const cur = p!.fontFamily
      return ['Font', seg([<Ph n="PencilSimple" size={12} />, 'A', <Ph n="Code" size={12} />, <Ph n="CaretDown" size={10} />], [5, 6, 8, cur != null && !quick.includes(cur) ? cur : -1], cur,
        ['Hand-drawn', 'Normal', 'Code', 'More fonts'], (v, i) => { if (i === 3) setOpen(open === 'font' ? null : 'font'); else act('changeFontFamily', { currentItemFontFamily: v }) }, open === 'font' ? 3 : undefined)]
    },
    // a size between the presets (an agent's 24, a resized text) lights the nearest one - never none (Nic, 26 Nov)
    fontSize: () => ['Size', seg(['S', 'M', 'L', 'XL'], [16, 20, 28, 36], nearest([16, 20, 28, 36], p!.fontSize), ['Small', 'Medium', 'Large', 'Extra large'], (v) => act('changeFontSize', v))],
    align: () => ['Text align', seg([<Ph n="TextAlignLeft" size={13} />, <Ph n="TextAlignCenter" size={13} />, <Ph n="TextAlignRight" size={13} />], ['left', 'center', 'right'], p!.textAlign,
      [['Left', '⌘⇧L'], ['Centre', '⌘⇧E'], ['Right', '⌘⇧R']], (v) => act('changeTextAlign', v))],
    valign: () => ['Vertical', seg([<VAlign k="top" />, <VAlign k="mid" />, <VAlign k="bottom" />], ['top', 'middle', 'bottom'], p!.verticalAlign, ['Top', 'Middle', 'Bottom'], (v) => act('changeVerticalAlign', v))],
    arrowheads: () => ['Arrowheads', seg([<span style={{ display: 'flex', transform: 'scaleX(-1)' }}><HeadIcon k={(p!.startArrowhead ?? 'none') as Head} /></span>, <HeadIcon k={(p!.endArrowhead ?? 'none') as Head} />],
      ['start', 'end'], null, ['Start arrowhead', 'End arrowhead'], (v) => setOpen(open === v ? null : (v as Picker)), open === 'start' ? 0 : open === 'end' ? 1 : undefined)],
  }
  const segRows = ['width', 'style', 'sloppiness', 'edges', 'arrowType', 'arrowheads', 'font', 'fontSize', 'align', 'valign'].filter(has)
  for (let i = 0; i < segRows.length; i++) {
    const r = segRows[i], nx = segRows[i + 1]
    const pair = nx && pairs.some(([a, b]) => a === r && b === nx) ? [r, nx] : [r]
    if (pair.length === 2) i++
    const opened = pair.some((k) => (k === 'font' && open === 'font') || (k === 'arrowheads' && (open === 'start' || open === 'end')))
    out.push(
      <div className="sec pair" key={pair.join('-')} {...(opened ? { 'data-pop': '' } : {})}>
        {pair.map((k) => { const [lb, el] = cells[k](); return <div key={k}><div className="lb">{lb}</div>{el}</div> })}
      </div>,
    )
  }
  if (has('opacity')) out.push(<Opacity key="opacity" value={p!.opacity} onChange={(v) => act('changeOpacity', v)} />)
  if (has('layers')) {
    const lay = ([['Send to back', 'ArrowLineDown', '⌘⇧[', 'sendToBack'], ['Send backward', 'ArrowDown', '⌘[', 'sendBackward'], ['Bring forward', 'ArrowUp', '⌘]', 'bringForward'], ['Bring to front', 'ArrowLineUp', '⌘⇧]', 'bringToFront']] as const)
      .map(([t, n, k, a]) => <HoverTip key={t} label={t} keys={k}><button aria-label={t} onClick={() => act(a)}><Ph n={n} size={13} /></button></HoverTip>)
    out.push(<div className="sec" key="layers"><div className="lb">Layers</div><div className="dk-row">{lay}</div></div>)
  }
  if (has('actions')) {
    const A: [string, ReactNode, string, DrawAction, boolean?][] = [
      ['Duplicate', <Ph n="Copy" size={13} />, '⌘D', 'duplicateSelection'],
      ['Delete', <Ph n="Trash" size={13} />, '⌫', 'deleteSelectedElements', true],
    ]
    if (state.sel.count > 1) A.push(state.sel.grouped ? ['Ungroup', <Ph n="SelectionAll" size={13} />, '⇧⌘G', 'ungroup'] : ['Group', <Ph n="SelectionAll" size={13} />, '⌘G', 'group'])
    else A.push(['Link', <Ph n="Link" size={13} />, '⌘K', 'hyperlink'])
    if (state.sel.isLinear && state.sel.types.includes('arrow')) A.push(['Edit points', <EditPoints />, '⌘↵', 'toggleLinearEditor'])
    out.push(
      <div className="sec" key="actions"><div className="lb">Actions</div><div className="dk-row">
        {A.map(([t, ic, k, a, warn]) => <HoverTip key={t} label={t} keys={k}><button className={warn ? 'warn' : undefined} aria-label={t} onClick={() => act(a)}>{ic}</button></HoverTip>)}
      </div></div>,
    )
  }
  if (has('alignment')) {
    const row = (items: readonly (readonly [string, Parameters<typeof Ph>[0]['n'], string, DrawAction])[], dist: [string, 'h' | 'v', string, DrawAction]) => (
      <div className="dk-row" style={{ marginBottom: 2 }}>
        {items.map(([t, n, k, a]) => <HoverTip key={t} label={t} keys={k || undefined}><button aria-label={t} onClick={() => act(a)}><Ph n={n} size={13} /></button></HoverTip>)}
        <span className="gap" />
        {state.sel.count > 2 && <HoverTip label={dist[0]} keys={dist[2]}><button aria-label={dist[0]} onClick={() => act(dist[3])}><Distribute k={dist[1]} /></button></HoverTip>}
      </div>
    )
    // several selected: Align / Distribute first - the main thing a multi-selection is for (the kit)
    out.unshift(
      <div className="sec" key="alignment"><div className="lb"><span>Align</span>{state.sel.count > 2 && <span>Distribute</span>}</div>
        {row([['Align left', 'AlignLeft', '⌘⇧←', 'alignLeft'], ['Centre horizontally', 'AlignCenterHorizontal', '', 'alignHorizontallyCentered'], ['Align right', 'AlignRight', '⌘⇧→', 'alignRight']] as const, ['Distribute horizontally', 'h', '⌥H', 'distributeHorizontally'])}
        {row([['Align top', 'AlignTop', '⌘⇧↑', 'alignTop'], ['Centre vertically', 'AlignCenterVertical', '', 'alignVerticallyCentered'], ['Align bottom', 'AlignBottom', '⌘⇧↓', 'alignBottom']] as const, ['Distribute vertically', 'v', '⌥V', 'distributeVertically'])}
      </div>,
    )
  }

  const popPos: CSSProperties = popSide === 'right' ? { left: 'calc(100% + 10px)', top: popTop } : { right: 'calc(100% + 10px)', top: popTop }
  return (
    <div ref={anchor} className={`dk-anchor${cam ? ' dk-cam' : ''}`} style={{ zIndex: open ? 46 : 31, ...style }}>
      <div ref={panel} className="dk-glass dk-props dk-draw" style={{ position: 'relative' }}>{top}{out}</div>
      {(open === 'stroke' || open === 'background') && (
        <ColorPicker current={(open === 'stroke' ? p?.strokeColor : p?.backgroundColor) ?? 'transparent'} mostUsed={state.used?.[open] ?? []} style={{ position: 'absolute', ...popPos }}
          onPick={(c) => setColor(open, c)} />
      )}
      {open === 'font' && <FontPicker current={p?.fontFamily ?? null} inDrawing={state.used?.fonts ?? []} style={{ position: 'absolute', ...popPos }} onPick={(id) => { act('changeFontFamily', { currentItemFontFamily: id }); setOpen(null) }} />}
      {(open === 'start' || open === 'end') && (
        <ArrowheadPicker side={open} current={((open === 'start' ? p?.startArrowhead : p?.endArrowhead) ?? 'none') as Head} more={moreHeads} onMore={() => setMoreHeads((m) => !m)}
          style={{ position: 'absolute', ...popPos }} onPick={(h) => act('changeArrowhead', { position: open, type: h === 'none' ? null : h })} />
      )}
    </div>
  )
}

function Opacity({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  const [v, setV] = useState(value ?? 100)
  const cur = useRef(v)
  cur.current = v
  useEffect(() => { if (value !== null) setV(value) }, [value])
  // dragged by hand, never focused: a focused slider would take the caret from a text being typed in the drawing, and
  // Excalidraw ends the edit on that blur - the panel then went away (Nic, 26 Nov). Keys still work once it has focus.
  const drag = (e: React.PointerEvent<HTMLInputElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const set = (x: number) => {
      const r = el.getBoundingClientRect()
      const n = Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * 10) * 10
      if (n === cur.current) return
      cur.current = n
      setV(n)
      onChange(n)
    }
    set(e.clientX)
    el.setPointerCapture(e.pointerId)
    const move = (m: PointerEvent) => set(m.clientX)
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up) }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
  }
  return (
    <div className="sec">
      <div className="lb">Opacity</div>
      <div className="dk-slider">
        <input type="range" min={0} max={100} step={10} value={v} aria-label="Opacity" style={{ ['--v' as string]: `${v}%` }} onPointerDown={drag}
          onChange={(e) => { const n = Number(e.target.value); setV(n); onChange(n) }} />
        <span>{value === null ? '-' : v}</span>
      </div>
    </div>
  )
}

/** Excalidraw's colour popover (the kit): Most used (the drawing's own custom colours), the 15 colours, the current colour's
 *  five shades, its hex - editable - with the eyedropper where the browser has one. */
function ColorPicker({ current, mostUsed, onPick, style }: { current: string; mostUsed: string[]; onPick: (c: string) => void; style?: CSSProperties }) {
  const cur = current.toLowerCase()
  const [hex, setHex] = useState(cur.startsWith('#') ? cur.slice(1) : '')
  useEffect(() => { setHex(cur.startsWith('#') ? cur.slice(1) : '') }, [cur])
  const commit = () => { const h = hex.trim().replace(/^#/, ''); if (/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) onPick(`#${h.toLowerCase()}`) }
  const shades = shadesOf(cur)
  const Dropper = (globalThis as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper
  const pickFromScreen = () => { if (Dropper) void new Dropper().open().then((r) => onPick(r.sRGBHex.toLowerCase()), () => { /* cancelled */ }) }
  return (
    <div className="dk-glass dk-pop dk-draw" style={{ width: 148, ...style }}>
      {mostUsed.length > 0 && <div className="sec"><div className="lb">Most used</div>
        <div className="grid">{mostUsed.map((c) => <Sw key={c} c={c} on={c === cur} onClick={() => onPick(c)} />)}</div></div>}
      <div className="sec"><div className="lb">Colours</div>
        <div className="grid">{PALETTE.map((c) => <Sw key={c} c={c} on={c === cur} onClick={() => onPick(c)} />)}</div></div>
      <div className="sec"><div className="lb">Shades</div>
        <div className="grid">{shades ? shades.map((c) => <Sw key={c} c={c} on={c === cur} onClick={() => onPick(c)} />) : [0, 1, 2, 3, 4].map((i) => <i key={i} className="dk-sw nil" />)}</div></div>
      <div className="sec"><div className="lb">Hex</div>
        <div className="hex"><span className="h">#</span>
          <input value={hex} aria-label="Hex colour" spellCheck={false} maxLength={8} onChange={(e) => setHex(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit() }} onBlur={commit} />
          {Dropper && <HoverTip label="Pick from the screen" side="bottom"><button aria-label="Eyedropper" onClick={pickFromScreen}><Ph n="Eyedropper" size={13} /></button></HoverTip>}
        </div></div>
    </div>
  )
}

/** The font picker (the kit): search, the fonts this drawing uses, then the others - each name in its own face. */
function FontPicker({ current, inDrawing, onPick, style }: { current: number | null; inDrawing: number[]; onPick: (id: number) => void; style?: CSSProperties }) {
  const [q, setQ] = useState('')
  useEffect(() => { loadPreviewFonts() }, [])
  const match = (f: (typeof FONTS)[number]) => f.name.toLowerCase().includes(q.toLowerCase())
  const here = inDrawing.map((id) => FONTS.find((f) => f.id === id)).filter((f): f is (typeof FONTS)[number] => !!f && match(f))
  const more = FONTS.filter((f) => match(f) && !inDrawing.includes(f.id))
  const row = (f: (typeof FONTS)[number]) => (
    <button key={f.id} className={`font${f.id === current ? ' on' : ''}`} onClick={() => onPick(f.id)}>
      <Ph n={f.kind === 'hand' ? 'PencilSimple' : f.kind === 'code' ? 'Code' : 'TextT'} size={13} /><span style={{ fontFamily: previewFamily(f.id) }}>{f.name}</span>
    </button>
  )
  return (
    <div className="dk-glass dk-pop dk-draw" style={{ width: 188, ...style }}>
      <div className="search"><Ph n="MagnifyingGlass" size={13} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fonts" aria-label="Search fonts"
        style={{ flex: 1, border: 0, background: 'none', outline: 'none', font: 'inherit', color: 'var(--glass-ink)' }} /></div>
      {here.length > 0 && <div className="sec" style={{ marginTop: 8 }}><div className="lb">In this drawing</div>{here.map(row)}</div>}
      {more.length > 0 && <div className="sec" style={here.length ? undefined : { marginTop: 8 }}><div className="lb">{here.length ? 'More fonts' : 'Fonts'}</div>{more.map(row)}</div>}
    </div>
  )
}

/** The preset closest to a value (null stays null: a mixed selection lights none). */
function nearest(presets: number[], v: number | null): number | null {
  if (v == null) return null
  return presets.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), presets[0])
}

function ArrowheadPicker({ side, current, more, onMore, onPick, style }: { side: 'start' | 'end'; current: Head; more: boolean; onMore: () => void; onPick: (h: Head) => void; style?: CSSProperties }) {
  const b = (h: Head) => (
    <HoverTip key={h} label={HEAD_LABEL[h]} side="top">
      <button className={h === current ? 'on' : undefined} aria-label={HEAD_LABEL[h]} style={side === 'start' ? { transform: 'scaleX(-1)' } : undefined} onClick={() => onPick(h)}><HeadIcon k={h} /></button>
    </HoverTip>
  )
  return (
    <div className="dk-glass dk-pop dk-draw" style={{ width: 148, ...style }}>
      <div className="heads">{HEADS.basic.map(b)}</div>
      <button className="more" onClick={onMore}><span>More options</span><Ph n={more ? 'CaretUp' : 'CaretDown'} size={11} /></button>
      {more && <Fragment>
        <div className="heads">{HEADS.more.map(b)}</div>
        <div className="lb" style={{ marginTop: 9 }}>Cardinality</div>
        <div className="heads">{HEADS.cardinality.map(b)}</div>
      </Fragment>}
    </div>
  )
}

export type { DrawProps }
