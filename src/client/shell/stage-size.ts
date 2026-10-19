/** The play stage's size as it is drawn - a device, the window when it fills, a slide's own stage, the reading
 *  width of a document - in the frame's CSS pixels. Play writes it as it lays the stage out; a capture reads it
 *  (what a frame seen on the stage is pictured at). */
export const stageSize: { at: string; w: number; h: number } = { at: '', w: 0, h: 0 }
