/**
 * How a device shows in the shell (spec 31 Part F): its label and its icon, wherever a device name shows - the frame
 * toolbar, the device menu, Play, the Jam panel. The server resolved each configured viewport's look once
 * (device-icons.ts, `CONFIG.devices`); a name it did not resolve (a Jam step recorded under an older config) takes the
 * same rules from its name (src/shared/devices.ts).
 *
 * A device's own SVG is drawn as a CSS `mask-image` filled with the ink (`currentColor`): an image, never DOM, so
 * nothing in it can run or restyle the page. Only a base64 SVG data URI is ever drawn - anything else is the glyph.
 */
import type { CSSProperties } from 'react'
import { lookFromName, type DeviceLook } from '../../shared/devices.ts'
import { DEVICE_GLYPH_ICONS, DevicesIcon } from './icons.tsx'
import { CONFIG } from './store.ts'

/** The only mask a device wears: a base64 SVG data URI, as the server writes it (nothing can close the `url()`). */
export const SAFE_MASK = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/

/** A device's look: the server's, else its name's. */
export function deviceLook(name: string): DeviceLook {
  const d = CONFIG.devices
  return d && Object.hasOwn(d, name) ? d[name] : lookFromName(name)
}

/** A device's label ("iPad landscape"). */
export const deviceLabel = (name: string): string => deviceLook(name).label

/** A look's icon at `size` px. */
export function DeviceGlyph({ look, size = 14 }: { look: DeviceLook; size?: number }) {
  if (look.mask && SAFE_MASK.test(look.mask)) {
    const url = `url("${look.mask}")`
    const style: CSSProperties = { width: size, height: size, WebkitMaskImage: url, maskImage: url }
    // an <i>, not a <span>: menu rules that stretch and capitalise a button's span are for its words
    return <i className="sh-dev-mask" aria-hidden data-mv-device-mask="" style={style} />
  }
  const I = (look.glyph && DEVICE_GLYPH_ICONS[look.glyph]) || DevicesIcon
  return <I size={size} style={look.rotate ? { transform: 'rotate(90deg)' } : undefined} />
}

/** A device name's icon; null (no device: the default view) is the generic Devices glyph. */
export function deviceIcon(name: string | null, size = 14) {
  return name ? <DeviceGlyph look={deviceLook(name)} size={size} /> : <DevicesIcon size={size} />
}
