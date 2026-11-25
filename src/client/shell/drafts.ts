/**
 * The words in a composer, kept (spec 36 §3). A reply typed into a thread, or a first comment on an element, survives
 * whatever closes its composer before it is sent - a click outside, a board switch, a reload, the sign-in pages - and
 * comes back when that composer opens again. Per canvas, in localStorage; storage that throws keeps them in memory.
 */
import { useCallback, useEffect, useState } from 'react'
import { scoped } from './api.ts'

const PREFIX = 'mv-draft:'
const mem = new Map<string, string>()
const storageKey = (key: string) => scoped(PREFIX + key)

/** Drafts storage would not take: only this page holds them, so leaving would lose them. */
const unsaved = new Set<string>()

export function readDraft(key: string): string {
  // storage is the record - another tab may have written newer words there; only words storage would not take are
  // newer in this page
  if (unsaved.has(key)) return mem.get(key) ?? ''
  // storage answered: its answer is the record, nothing there included (memory only when storage cannot be read)
  try { return localStorage.getItem(storageKey(key)) ?? '' } catch { return mem.get(key) ?? '' }
}
export function writeDraft(key: string, words: string) {
  // on disk when storage takes them; this page keeps its own copy only of words storage refused
  try {
    if (words.trim()) localStorage.setItem(storageKey(key), words); else localStorage.removeItem(storageKey(key))
    mem.delete(key); unsaved.delete(key)
  } catch {
    if (words.trim()) { mem.set(key, words); unsaved.add(key) } else { mem.delete(key); unsaved.delete(key) }
  }
}
/** These words were sent: every copy of them goes - on disk and in this page - and only of them. Newer words in
 *  the same place (another tab's, or typed here while storage refused them) stay. */
export function clearSent(key: string, words: string) {
  if (mem.get(key)?.trim() === words) { mem.delete(key); unsaved.delete(key) }
  try { if (localStorage.getItem(storageKey(key))?.trim() === words) localStorage.removeItem(storageKey(key)) } catch { /* nothing on disk */ }
}
/** Does this page hold a draft storage would not take? Then leaving would lose it - the only draft the leave question asks about. */
export const draftsVolatile = () => unsaved.size > 0

/** A composer's text, kept under `key` as it is typed. The setter takes a value or an update, like useState's. */
export function useDraft(key: string): [string, (next: string | ((cur: string) => string)) => void] {
  const [text, setText] = useState(() => readDraft(key))
  useEffect(() => { setText(readDraft(key)) }, [key])   // the same composer, another thread: its own words
  const set = useCallback((next: string | ((cur: string) => string)) => {
    setText((cur) => {
      const v = typeof next === 'function' ? next(cur) : next
      writeDraft(key, v)
      return v
    })
  }, [key])
  return [text, set]
}
