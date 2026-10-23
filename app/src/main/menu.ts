/**
 * The menu bar (spec 28 A2.7, A2.14 #25). Owner: the window stream (with commands.ts and keys.ts).
 *
 * SKELETON (ship stream): the native roles only - the app menu, Edit (text fields need its roles) and Window.
 * To build: A2.7's menus from one command table, the canvas's own items from its `mv:menu`, rebuilt
 * (debounced) when the active tab, its items or a tab's state change; stale callbacks refused.
 */
import { Menu } from 'electron'

export function buildMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
}
