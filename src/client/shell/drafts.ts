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

export function readDraft(key: string): string {
  try { return localStorage.getItem(storageKey(key)) ?? mem.get(key) ?? '' } catch { return mem.get(key) ?? '' }
}
export function writeDraft(key: string, words: string) {
  if (words.trim()) mem.set(key, words); else mem.delete(key)
  try { if (words.trim()) localStorage.setItem(storageKey(key), words); else localStorage.removeItem(storageKey(key)) } catch { /* memory holds it */ }
}

/** Does a composer on this page hold words not sent? The leave-page question asks it. (Words kept from an earlier
 *  visit are on disk already and wait for their composer - they ask nothing.) */
export function hasDraftWords(): boolean {
  return [...mem.values()].some((w) => w.trim())
}

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
