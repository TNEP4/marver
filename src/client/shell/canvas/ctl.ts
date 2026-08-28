/**
 * The canvas control channel, in its own dependency-free module.
 *
 * Play, Comments and App steer the camera through this object; Canvas assigns
 * the real implementations when it mounts. Living here rather than inside
 * Canvas.tsx keeps the play/focus surfaces importable WITHOUT the canvas - a
 * locked-shell bundle mounts the stage chrome and the canvas code never enters
 * it (01-sharing §5.1's all-boards rule). Before Canvas mounts (or when it
 * never does), every call is a harmless no-op.
 */

/** B0.2: one wheel event, whatever its origin - a shell-document wheel over the canvas, or
 *  a wheel forwarded from a passive frame's iframe. clientX/Y are shell-viewport pixels. */
export interface CanvasWheelInput {
  deltaX: number; deltaY: number; deltaMode: number
  ctrlKey: boolean; metaKey: boolean; clientX: number; clientY: number
}

export const canvasCtl = {
  fitNode(_key: string) {},
  fitNodes(_keys: string[]) {},
  fitAll() {},
  zoomTo(_scale: number) {},
  zoom100() { canvasCtl.zoomTo(1) },
  wheel(_input: CanvasWheelInput) {},
}
