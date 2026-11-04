/** R16's negative fixture: a dialog whose answer nothing records. The walk must report it. */
declare const dialog: { showMessageBox(o: object): Promise<{ response: number }> }
export async function askNobody(): Promise<boolean> {
  const r = await dialog.showMessageBox({ message: 'Sure?', buttons: ['Yes', 'No'] })
  return r.response === 0
}
