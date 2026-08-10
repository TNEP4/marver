import type { ReactNode, SVGProps } from 'react'

/**
 * Inline icon set, lucide/shadcn-style strokes. Deliberately NOT an icon package:
 * the shell ships as source into unknown hosts, and every runtime dep must resolve
 * through the host's package manager layout (see DECISIONS.md).
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number }

const icon = (children: ReactNode) =>
  function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
        aria-hidden {...rest}
      >
        {children}
      </svg>
    )
  }

export const SidebarIcon = icon(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9.5 4v16" /></>)
export const SunIcon = icon(<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></>)
export const MoonIcon = icon(<path d="M20.9 13.1A8.6 8.6 0 1 1 10.9 3.1a6.9 6.9 0 0 0 10 10Z" />)
export const CaretIcon = icon(<path d="m6.5 9.5 5.5 5.5 5.5-5.5" />)
export const PlayIcon = icon(<path d="M7.5 5.2v13.6a.7.7 0 0 0 1.1.6l10.8-6.8a.7.7 0 0 0 0-1.2L8.6 4.6a.7.7 0 0 0-1.1.6Z" />)
export const GridIcon = icon(<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>)
export const CopyIcon = icon(<><rect x="8" y="8" width="13" height="13" rx="2.5" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>)
export const PlusIcon = icon(<path d="M12 5.5v13M5.5 12h13" />)
export const XIcon = icon(<path d="m17.5 6.5-11 11M6.5 6.5l11 11" />)
export const ReloadIcon = icon(<><path d="M20.5 12a8.5 8.5 0 1 1-2.7-6.2" /><path d="M21 3.5V8h-4.5" /></>)
export const CheckIcon = icon(<path d="m5 12.5 4.5 4.5L19 7.5" />)
