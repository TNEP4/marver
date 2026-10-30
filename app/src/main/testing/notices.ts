/**
 * The fake presenter (spec 28 A4.6 #22, #52): what a test build posts instead of macOS notices, so a run never makes
 * macOS ask about "Electron" on the owner's screen. Each call is journaled; hooks:
 * - `notices` - `{ journal, live }`: every create, post and badge in order, and the notices still held; `{ clear: true }`
 *   empties the journal after reading it;
 * - `notices:fire` - `{ n, event }`: a held notice's `show`, `failed`, `click` or `close`, as macOS would send it.
 */
import type { NoticeEvents, Presenter } from '../notify.ts'
import { note, provide } from './index.ts'

type Line = { op: 'create' } | { op: 'post'; n: number; title: string; body: string } | { op: 'badge'; n: number }

const journal: Line[] = []
const live = new Map<number, NoticeEvents>()
let count = 0
let hooked = false

export function fakePresenter(): Presenter {
  provideNoticeHooks()
  return {
    create() { journal.push({ op: 'create' }); note('notices', { op: 'create' }) },
    post(n, on) {
      const id = ++count
      journal.push({ op: 'post', n: id, title: n.title, body: n.body })
      live.set(id, on)
      note('notices', { op: 'post', n: id, title: n.title, body: n.body })
      return { n: id }
    },
    badge(n) { journal.push({ op: 'badge', n }); note('notices', { op: 'badge', n }) },
  }
}

/** The hooks, from the start of a test run: a case reads an empty journal before anything made the presenter. */
export function provideNoticeHooks(): void {
  if (hooked) return
  hooked = true
  provide('notices', (a) => {
    const out = { journal: journal.map((l) => ({ ...l })), live: [...live.keys()] }
    if ((a as { clear?: unknown } | null)?.clear === true) journal.length = 0
    return out
  })
  provide('notices:fire', (a) => {
    const { n, event } = (a ?? {}) as { n?: number; event?: string }
    const on = typeof n === 'number' ? live.get(n) : undefined
    if (!on) return false
    if (event === 'click' || event === 'close') live.delete(n!)
    switch (event) {
      case 'show': on.onShow(); return true
      case 'failed': on.onFailed(); return true
      case 'click': on.onClick(); return true
      case 'close': on.onClose(); return true
      default: return false
    }
  })
}
