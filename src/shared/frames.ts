/** A canvas made of content frames alone (Doc, Md, Diagram ship their own styling) needs no theme -
 *  only an app frame does (#4). Empty counts as not content-only: the warning still helps there. */
export const contentOnly = (frames: readonly { intent?: string }[]): boolean => frames.length > 0 && frames.every((f) => !!f.intent)
