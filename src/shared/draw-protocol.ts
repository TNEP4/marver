/**
 * The drawing frame's protocol (spec 38) - the one vocabulary the shell (bar, panel, view controls), the draw host
 * (Excalidraw in its iframe) and the dev server share. Plain types and pure helpers: no DOM, no Excalidraw import.
 *
 *   shell ──sh:draw-cmd──▶ draw host        draw host ──sh:draw-state──▶ shell (one per animation frame at most)
 *   dev server ──HMR 'sh:draw' (a merged rev)──▶ every open draw host of that drawing
 */

/** Excalidraw 0.18.1's tools (spec 38: its own tools only). */
export const DRAW_TOOLS = ['selection', 'hand', 'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'eraser', 'image', 'frame', 'embeddable', 'laser'] as const
export type DrawTool = typeof DRAW_TOOLS[number]

/** The panel's sections, in the approved order (frame `00b-kit-properties`). */
export type DrawSection =
  | 'stroke' | 'background' | 'fill' | 'width' | 'style' | 'sloppiness' | 'edges' | 'arrowType' | 'arrowheads'
  | 'font' | 'fontSize' | 'align' | 'valign' | 'opacity' | 'layers' | 'actions' | 'alignment'

/** What the panel shows: the values of what is selected, else of the tool in hand (Excalidraw's `currentItem*`).
 *  `null` = mixed across the selection. */
export interface DrawProps {
  strokeColor: string | null
  backgroundColor: string | null
  fillStyle: 'hachure' | 'cross-hatch' | 'solid' | 'zigzag' | null
  strokeWidth: number | null
  strokeStyle: 'solid' | 'dashed' | 'dotted' | null
  roughness: number | null
  roundness: 'sharp' | 'round' | null
  arrowType: 'sharp' | 'round' | 'elbow' | null
  startArrowhead: string | null
  endArrowhead: string | null
  fontFamily: number | null
  fontSize: number | null
  textAlign: 'left' | 'center' | 'right' | null
  verticalAlign: 'top' | 'middle' | 'bottom' | null
  opacity: number | null
}

/** The draw host's state, posted to the shell on every change that matters (rAF-batched, deduped). */
/** A drawing's own custom colours (most used first, at most 5) and its fonts (most used first). */
export interface DrawUsed { stroke: string[]; background: string[]; fonts: number[] }

export interface DrawState {
  type: 'sh:draw-state'
  id: string
  boot?: string
  /** `edit` = drawing mode (tools live); `view` = at rest or published */
  mode: 'view' | 'edit'
  /** false on a published canvas (or a file that failed to load): no tools, no panel */
  editable: boolean
  tool: DrawTool
  locked: boolean
  /** selected elements: how many, and their types (deduped) */
  sel: { count: number; types: string[]; hasLink: boolean; isLinear: boolean; grouped: boolean }
  sections: DrawSection[]
  props: DrawProps
  /** the paper as it is drawn now (the theme applied): play paints the whole tab with it - the app's strip too */
  paper?: string
  /** what the drawing uses: its custom colours by kind (the pickers' Most used) and its fonts (In this drawing) */
  used?: DrawUsed
  zoom: number
  canUndo: boolean
  canRedo: boolean
  /** true while the drawing's own view is moving (wheel, hand, fit) - the mini-map shows only then */
  panning: boolean
  /** the drawing's content box and the view, in scene units, for the mini-map */
  map: { content: Box | null; view: Box }
  /** the view differs from the frame's saved view */
  offFrameView: boolean
  rev: number
  /** saves in flight or queued: the bar can say "saving" (never blocks) */
  pending: number
  /** a load failure, said in the frame and here */
  error?: string
  /** spec 39: comment mode is picking in this drawing - the tool is paused, not changed */
  picking?: boolean
}
export interface Box { x: number; y: number; w: number; h: number }

export type DrawViewOp = 'in' | 'out' | 'fit' | 'selection' | 'frame' | 'save' | 'reset'
/** Commands from the shell. `action` runs Excalidraw's own action by name (adapter.ts), with its own value shape. */
export type DrawCmd =
  | { type: 'sh:draw-cmd'; op: 'tool'; tool: DrawTool }
  | { type: 'sh:draw-cmd'; op: 'lock' }
  | { type: 'sh:draw-cmd'; op: 'action'; name: DrawAction; value?: unknown }
  | { type: 'sh:draw-cmd'; op: 'view'; v: DrawViewOp }
  | { type: 'sh:draw-cmd'; op: 'undo' | 'redo' }
  | { type: 'sh:draw-cmd'; op: 'mode'; edit: boolean }
  /** `rid`: the request's own id, echoed in its answer - two exports at once never take each other's (release review) */
  | { type: 'sh:draw-cmd'; op: 'export'; format: 'png' | 'svg' | 'clipboard'; dark?: boolean; rid?: string }
  | { type: 'sh:draw-cmd'; op: 'insert-image' }
  | { type: 'sh:draw-cmd'; op: 'flush' }
  /** play's Hide all UI: while hidden, the host takes H (it reveals) instead of Excalidraw's hand */
  | { type: 'sh:draw-cmd'; op: 'ui'; hidden: boolean }
  /** spec 39: scroll the drawing to a comment's element or paper point, once (a thread opened on purpose) */
  | { type: 'sh:draw-cmd'; op: 'reveal'; anchor: unknown }
  /** spec 39: give the keyboard back to the drawing (after a comment is sent in drawing mode) */
  | { type: 'sh:draw-cmd'; op: 'focus' }
  /** spec 39: a shell menu over the drawing is open - the host forwards arrows, Enter and Escape to it */
  | { type: 'sh:draw-cmd'; op: 'menu'; open: boolean }

/** The commands a published (view-only) drawing runs - none of them changes the drawing (spec 39 B2). */
export const READ_ONLY_OPS: ReadonlySet<DrawCmd['op']> = new Set(['view', 'export', 'reveal', 'focus', 'menu', 'flush', 'ui'])

/** spec 39 B2: the drawing's camera, posted (at most once a frame) while it pans or zooms - the shell moves pins with CSS
 *  variables, never a render. `moving`: a camera or element gesture is under way (pins are placed again when it ends). */
export interface DrawCamera { type: 'sh:draw-camera'; id: string; scrollX: number; scrollY: number; zoom: number; moving: boolean }

/** The Excalidraw actions the shell may run - the allow-list the adapter checks (a test runs each one). */
export const DRAW_ACTIONS = [
  'changeStrokeColor', 'changeBackgroundColor', 'changeFillStyle', 'changeStrokeWidth', 'changeSloppiness',
  'changeStrokeStyle', 'changeOpacity', 'changeFontSize', 'changeFontFamily', 'changeTextAlign', 'changeVerticalAlign',
  'changeRoundness', 'changeArrowhead', 'changeArrowType',
  'sendBackward', 'bringForward', 'sendToBack', 'bringToFront',
  'duplicateSelection', 'deleteSelectedElements', 'hyperlink', 'group', 'ungroup', 'toggleLinearEditor',
  'alignLeft', 'alignHorizontallyCentered', 'alignRight', 'alignTop', 'alignVerticallyCentered', 'alignBottom',
  'distributeHorizontally', 'distributeVertically', 'selectAll',
] as const
export type DrawAction = typeof DRAW_ACTIONS[number]

// ---- the file and its revs -------------------------------------------------------------------------------------

/** An Excalidraw element as the file stores it - typed loosely: Excalidraw owns the shape, we read a few fields. */
export interface DrawElement {
  id: string
  type: string
  version: number
  versionNonce: number
  isDeleted?: boolean
  index?: string | null
  updated?: number
  customData?: Record<string, unknown> & { mv?: { by?: string; at?: number } }
  [k: string]: unknown
}

/** The `marver` header of a `.excalidraw` file. */
export interface DrawHeader {
  rev: number
  /** a random id per drawing history (spec 38 decision 2): a base is trusted only within one epoch */
  epoch?: string
  title?: string
  description?: string
  size?: { w: number; h: number }
  /** the frame's own view of the drawing (absent: fit to content) */
  view?: { x: number; y: number; zoom: number }
}

/** A merged rev, as the server broadcasts it (HMR `sh:draw`) and answers a save with. */
export interface DrawPatch {
  frame: string
  rev: number
  by: string
  /** elements added or changed in this rev, at their merged version */
  upserts: DrawElement[]
  /** ids deleted in this rev, with the version of the delete (a late write below it is refused) */
  deletes: { id: string; version: number }[]
  /** header changes in this rev (title, size, view) */
  header?: Partial<DrawHeader>
  /** image data added in this rev, by file id (Excalidraw's `files`) */
  files?: Record<string, unknown>
  /** the whole state (the log did not reach back that far): applied as one replacement */
  full?: boolean
}

/** A save from the frame: only what the person changed since `baseRev`. */
export interface DrawSave {
  baseRev: number
  upserts: DrawElement[]
  deletes: { id: string; version: number }[]
  header?: Partial<Pick<DrawHeader, 'view' | 'title' | 'size'>>
  /** image data for image elements in this save, by file id */
  files?: Record<string, unknown>
}

/** Who wrote a change - `owner` (the person in the frame), `agent` (a file edit or `marver draw`), or a named agent. */
export type DrawBy = 'owner' | 'agent' | `agent:${string}`

/** Excalidraw's own rule for two versions of one element (its `reconcileElements`): the higher version wins; on a
 *  tie the lower versionNonce wins. True when `a` should replace `b`. */
export function wins(a: Pick<DrawElement, 'version' | 'versionNonce'>, b: Pick<DrawElement, 'version' | 'versionNonce'>): boolean {
  return a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce)
}
