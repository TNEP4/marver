// Negative fixture (R16): a dispatcher's key branch that records nothing fails, though another branch records.
declare function cmd(name: string, o: object): void
declare function undo(): void
export function onKey(e: KeyboardEvent) {
  if (e.key === 'c') { cmd('comments', { via: 'key', in: 'shell' }) }
  if (e.key === 'z') { undo() }
}
