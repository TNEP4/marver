import type { ReactNode, SVGProps } from 'react'

/**
 * Phosphor icons (regular weight), path data inlined from @phosphor-icons/core
 * (MIT (c) Phosphor Icons - phosphoricons.com). Deliberately NOT an icon package
 * dependency: the shell ships as source into unknown hosts, and every runtime dep
 * must resolve through the host's package-manager layout (see DECISIONS.md).
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number }

const icon = (children: ReactNode) =>
  function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden {...rest}>
        {children}
      </svg>
    )
  }

export const SunIcon = icon(<path d="M120,40V16a8,8,0,0,1,16,0V40a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-16-16A8,8,0,0,0,42.34,53.66Zm0,116.68-16,16a8,8,0,0,0,11.32,11.32l16-16a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l16-16a8,8,0,0,0-11.32-11.32l-16,16A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l16,16a8,8,0,0,0,11.32-11.32ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Zm80,80a8,8,0,0,0-8,8v24a8,8,0,0,0,16,0V216A8,8,0,0,0,128,208Zm112-88H216a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16Z" />)
export const MoonIcon = icon(<path d="M233.54,142.23a8,8,0,0,0-8-2,88.08,88.08,0,0,1-109.8-109.8,8,8,0,0,0-10-10,104.84,104.84,0,0,0-52.91,37A104,104,0,0,0,136,224a103.09,103.09,0,0,0,62.52-20.88,104.84,104.84,0,0,0,37-52.91A8,8,0,0,0,233.54,142.23ZM188.9,190.34A88,88,0,0,1,65.66,67.11a89,89,0,0,1,31.4-26A106,106,0,0,0,96,56,104.11,104.11,0,0,0,200,160a106,106,0,0,0,14.92-1.06A89,89,0,0,1,188.9,190.34Z" />)
export const CaretIcon = icon(<path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />)
export const PlayIcon = icon(<path d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.94V40l143.83,88Z" />)
export const GridIcon = icon(<path d="M104,40H56A16,16,0,0,0,40,56v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,104,40Zm0,64H56V56h48v48Zm96-64H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,64H152V56h48v48Zm-96,32H56a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,104,136Zm0,64H56V152h48v48Zm96-64H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,200,136Zm0,64H152V152h48v48Z" />)
export const CopyIcon = icon(<path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z" />)
export const PlusIcon = icon(<path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z" />)
export const XIcon = icon(<path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z" />)
export const ReloadIcon = icon(<path d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z" />)
export const CheckIcon = icon(<path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />)
export const ColumnsIcon = icon(<path d="M104,32H64A16,16,0,0,0,48,48V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,104,32Zm0,176H64V48h40ZM192,32H152a16,16,0,0,0-16,16V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,192,32Zm0,176H152V48h40Z" />)
export const CommentIcon = icon(<path d="M132,24A100.11,100.11,0,0,0,32,124v84a16,16,0,0,0,16,16h84a100,100,0,0,0,0-200Zm0,184H48V124a84,84,0,1,1,84,84Z" />)
export const CheckSquareOffsetIcon = icon(<path d="M224,48V208a16,16,0,0,1-16,16H136a8,8,0,0,1,0-16h72V48H48v96a8,8,0,0,1-16,0V48A16,16,0,0,1,48,32H208A16,16,0,0,1,224,48ZM125.66,154.34a8,8,0,0,0-11.32,0L64,204.69,45.66,186.34a8,8,0,0,0-11.32,11.32l24,24a8,8,0,0,0,11.32,0l56-56A8,8,0,0,0,125.66,154.34Z" />)
export const DevicesIcon = icon(<path d="M224,72H208V64a24,24,0,0,0-24-24H40A24,24,0,0,0,16,64v96a24,24,0,0,0,24,24H152v8a24,24,0,0,0,24,24h48a24,24,0,0,0,24-24V96A24,24,0,0,0,224,72ZM40,168a8,8,0,0,1-8-8V64a8,8,0,0,1,8-8H184a8,8,0,0,1,8,8v8H176a24,24,0,0,0-24,24v72Zm192,24a8,8,0,0,1-8,8H176a8,8,0,0,1-8-8V96a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8Zm-96,16a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h40A8,8,0,0,1,136,208Zm80-96a8,8,0,0,1-8,8H192a8,8,0,0,1,0-16h16A8,8,0,0,1,216,112Z" />)
export const DeviceMobileIcon = icon(<path d="M176,16H80A24,24,0,0,0,56,40V216a24,24,0,0,0,24,24h96a24,24,0,0,0,24-24V40A24,24,0,0,0,176,16ZM72,64H184V192H72Zm8-32h96a8,8,0,0,1,8,8v8H72V40A8,8,0,0,1,80,32Zm96,192H80a8,8,0,0,1-8-8v-8H184v8A8,8,0,0,1,176,224Z" />)
export const DeviceTabletIcon = icon(<path d="M192,24H64A24,24,0,0,0,40,48V208a24,24,0,0,0,24,24H192a24,24,0,0,0,24-24V48A24,24,0,0,0,192,24ZM56,72H200V184H56Zm8-32H192a8,8,0,0,1,8,8v8H56V48A8,8,0,0,1,64,40ZM192,216H64a8,8,0,0,1-8-8v-8H200v8A8,8,0,0,1,192,216Z" />)
export const LaptopIcon = icon(<path d="M232,168h-8V72a24,24,0,0,0-24-24H56A24,24,0,0,0,32,72v96H24a8,8,0,0,0-8,8v16a24,24,0,0,0,24,24H216a24,24,0,0,0,24-24V176A8,8,0,0,0,232,168ZM48,72a8,8,0,0,1,8-8H200a8,8,0,0,1,8,8v96H48ZM224,192a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8v-8H224ZM152,88a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h32A8,8,0,0,1,152,88Z" />)
export const MonitorIcon = icon(<path d="M208,40H48A24,24,0,0,0,24,64V176a24,24,0,0,0,24,24H208a24,24,0,0,0,24-24V64A24,24,0,0,0,208,40Zm8,136a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V64a8,8,0,0,1,8-8H208a8,8,0,0,1,8,8Zm-48,48a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,224Z" />)
export const TvIcon = icon(<path d="M216,64H147.31l34.35-34.34a8,8,0,1,0-11.32-11.32L128,60.69,85.66,18.34A8,8,0,0,0,74.34,29.66L108.69,64H40A16,16,0,0,0,24,80V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V80A16,16,0,0,0,216,64Zm0,136H40V80H216V200Z" />)
export const SignpostIcon = icon(<path d="M246,106.65,212.33,69.3A16,16,0,0,0,200.44,64H136V32a8,8,0,0,0-16,0V64H40A16,16,0,0,0,24,80v64a16,16,0,0,0,16,16h80v64a8,8,0,0,0,16,0V160h64.44a16,16,0,0,0,11.89-5.3L246,117.35A8,8,0,0,0,246,106.65ZM200.44,144H40V80H200.44l28.8,32Z" />)
export const ParallelogramDuoIcon = icon(<><path d="M239.29,59.28l-64.8,144a8,8,0,0,1-7.3,4.72H24a8,8,0,0,1-7.3-11.28l64.8-144A8,8,0,0,1,88.81,48H232A8,8,0,0,1,239.29,59.28Z" opacity=".1" /><path d="M245.43,47.31A15.94,15.94,0,0,0,232,40H88.81a16,16,0,0,0-14.59,9.43l-64.8,144A16,16,0,0,0,24,216H167.19a16,16,0,0,0,14.59-9.43l64.8-144A16,16,0,0,0,245.43,47.31ZM167.19,200H24L88.81,56H232Z" /></>)
/** Sidebar trigger, custom in Phosphor 256-space: outer frame + panel pill -
 *  pill filled while the sidebar is open, hollow while collapsed. */
export const PanelFilledIcon = icon(<><rect x="32" y="48" width="192" height="160" rx="32" fill="none" stroke="currentColor" strokeWidth="16" /><rect x="72" y="88" width="48" height="80" rx="24" /></>)

/** Plain UI frame - the rectangle every non-content sidebar row leads with. */
export const FrameRectIcon = icon(<rect x="40" y="52" width="176" height="152" rx="20" fill="none" stroke="currentColor" strokeWidth="16" />)
export const LinkIcon = icon(<path d="M137.54,186.36a8,8,0,0,1,0,11.31l-9.94,10A56,56,0,0,1,48.38,128.4L72.5,104.28A56,56,0,0,1,149.31,102a8,8,0,1,1-10.64,12,40,40,0,0,0-54.85,1.63L59.7,139.72a40,40,0,0,0,56.58,56.58l9.94-9.94A8,8,0,0,1,137.54,186.36Zm70.08-138a56.08,56.08,0,0,0-79.22,0l-9.94,9.95a8,8,0,0,0,11.32,11.31l9.94-9.94a40,40,0,0,1,56.58,56.58L172.18,140.4a40,40,0,0,1-54.85,1.6,8,8,0,1,0-10.64,12,56,56,0,0,0,76.81-2.26l24.12-24.12A56.08,56.08,0,0,0,207.62,48.38Z" />)
export const LaserIcon = icon(<><circle cx="128" cy="128" r="56" fill="none" stroke="currentColor" strokeWidth="16" /><path d="M128 24 V56 M128 200 V232 M24 128 H56 M200 128 H232" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" /><circle cx="128" cy="128" r="12" /></>)

/* Content-frame intent glyphs (SPEC-026), custom in the same 256-space. */
export const DiagramShapeIcon = icon(<><rect x="28" y="36" width="88" height="64" rx="14" fill="none" stroke="currentColor" strokeWidth="16" /><rect x="140" y="156" width="88" height="64" rx="14" fill="none" stroke="currentColor" strokeWidth="16" /><path d="M116 68 H184 V156" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" /></>)
export const SpecDocIcon = icon(<><path d="M44 48 H180 M44 96 H212 M44 144 H212 M44 192 H140" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" /></>)
export const MoodboardIcon = icon(<><rect x="32" y="48" width="192" height="160" rx="20" fill="none" stroke="currentColor" strokeWidth="16" /><circle cx="96" cy="104" r="18" /><path d="M56 192 L112 128 L150 168 L178 140 L200 164 V192 Z" /></>)
export const NoteStickyIcon = icon(<><path d="M52 40 H204 a16 16 0 0 1 16 16 V152 L156 216 H52 a16 16 0 0 1 -16 -16 V56 a16 16 0 0 1 16 -16 Z" fill="none" stroke="currentColor" strokeWidth="16" strokeLinejoin="round" /><path d="M156 216 V168 a16 16 0 0 1 16 -16 h48" fill="none" stroke="currentColor" strokeWidth="16" strokeLinejoin="round" /></>)
export const ContentBlocksIcon = icon(<><rect x="36" y="36" width="80" height="80" rx="14" fill="none" stroke="currentColor" strokeWidth="16" /><circle cx="180" cy="180" r="44" fill="none" stroke="currentColor" strokeWidth="16" /><path d="M180 36 L224 116 H136 Z" fill="none" stroke="currentColor" strokeWidth="16" strokeLinejoin="round" /></>)

/** intent -> glyph; unknown intents fall to the generic content icon (forward-compatible).
 *  Accessible by default: role img + label + tooltip carry the intent name (the base
 *  icon() is aria-hidden; the spread below overrides it). */
export function IntentGlyph({ intent, size = 14, ...rest }: IconProps & { intent: string }) {
  const I = intent === 'diagram' ? DiagramShapeIcon
    : intent === 'spec' ? SpecDocIcon
    : intent === 'moodboard' ? MoodboardIcon
    : intent === 'notes' ? NoteStickyIcon
    : ContentBlocksIcon
  return <I size={size} role="img" aria-hidden={false} aria-label={intent} {...({ title: intent } as object)} {...rest} />
}
export const PanelHollowIcon = icon(<><rect x="32" y="48" width="192" height="160" rx="32" fill="none" stroke="currentColor" strokeWidth="16" /><rect x="72" y="88" width="48" height="80" rx="24" fill="none" stroke="currentColor" strokeWidth="14" /></>)
/** Board glyphs: CardsThree = the built-in `all-scenes` board; Cards = curated boards. */
export const CardsThreeIcon = icon(<path d="M208,88H48a16,16,0,0,0-16,16v96a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V104A16,16,0,0,0,208,88Zm0,112H48V104H208v96ZM48,64a8,8,0,0,1,8-8H200a8,8,0,0,1,0,16H56A8,8,0,0,1,48,64ZM64,32a8,8,0,0,1,8-8H184a8,8,0,0,1,0,16H72A8,8,0,0,1,64,32Z" />)
export const FrameCornersIcon = icon(<path d="M160 48h40a8 8 0 0 1 8 8v40M208 160v40a8 8 0 0 1-8 8h-40M96 208H56a8 8 0 0 1-8-8v-40M48 96V56a8 8 0 0 1 8-8h40" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" />)
export const ArrowLeftIcon = icon(<path d="M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z" />)
export const ArrowRightIcon = icon(<path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" />)
/** Variants/experimentation mark: the flask (Phosphor). */
export const VariantsIcon = icon(<path d="M223.45,208.19,168,101.11V40h8a8,8,0,0,0,0-16H80a8,8,0,0,0,0,16h8v61.11L32.55,208.19A16,16,0,0,0,46.86,232H209.14a16,16,0,0,0,14.31-23.81ZM102.13,108.5A8,8,0,0,0,104,103.35V40h48v63.35a8,8,0,0,0,1.87,5.15L179.36,157c-11.71,2.87-26.5.66-44.16-6.64-14.08-5.82-27.34-8.53-39.66-8.16ZM46.86,216,84.36,143.6c11.68-2.9,26.47-.68,44.13,6.61,13.09,5.42,25.36,8.11,36.65,8.11a67.86,67.86,0,0,0,22.53-3.72L209.14,216Z" />)
export const CardsIcon = icon(<path d="M184,72H40A16,16,0,0,0,24,88V200a16,16,0,0,0,16,16H184a16,16,0,0,0,16-16V88A16,16,0,0,0,184,72Zm0,128H40V88H184V200ZM232,56V176a8,8,0,0,1-16,0V56H64a8,8,0,0,1,0-16H216A16,16,0,0,1,232,56Z" />)
/** Viewport-name -> device glyph; unknown custom names fall back to the generic Devices. */
export function deviceIcon(name: string | null, size = 14) {
  const Icon = ({ mobile: DeviceMobileIcon, tablet: DeviceTabletIcon, laptop: LaptopIcon, monitor: MonitorIcon, tv: TvIcon } as Record<string, typeof DevicesIcon>)[name ?? ''] ?? DevicesIcon
  return <Icon size={size} />
}

