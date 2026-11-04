/** R16's negative fixture: a dispatcher whose one branch never ends the command it started. The walk must report it. */
declare function appCmd(name: string, o: object): { done(): void }
declare function doSomething(): void
export function runCommand(c: 'covered' | 'uncovered'): void {
  const h = appCmd(c, {})
  switch (c) {
    case 'covered': h.done(); return
    case 'uncovered': doSomething(); return
  }
}
