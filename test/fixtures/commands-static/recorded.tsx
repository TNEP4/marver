// The walk's positive control (R16): each of these is covered, by a command or by its shape, and needs no entry.
import { useState } from 'react'
declare function cmd(name: string, o: object): void
declare function act(): void
declare const cm: { open(e: unknown, items: object[]): void }
const named = () => { cmd('tidy', { via: 'click', in: 'pill' }); act() }
export function Good({ onPick }: { onPick: () => void }) {
  const [text, setText] = useState('')
  const local = () => named()
  return (
    <div>
      <button onClick={() => { cmd('panel', { via: 'click', in: 'shell' }); act() }}>a recorded click</button>
      <button onClick={named}>a named function that records</button>
      <button onClick={local}>a function that reaches one that records</button>
      <button onClick={onPick}>a prop: its caller is the site</button>
      <div onPointerDown={(e) => e.stopPropagation()}>a guard</div>
      <input value={text} onChange={(e) => setText(e.target.value)} aria-label="typing" />
      <div onContextMenu={(e) => cm.open(e, [{ label: 'Copy', onClick: () => cmd('copy-path', { via: 'context', in: 'shell' }) }])}>an opener; its item records</div>
    </div>
  )
}
export function onKey(e: KeyboardEvent) {
  if (e.key === 'c') { cmd('comments', { via: 'key', in: 'shell' }) }
  if (e.metaKey) return
  if (e.code === 'Digit1') named()
}
