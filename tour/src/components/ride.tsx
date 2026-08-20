/**
 * The ride demo's shared parts: device chrome, the city, the sheet. Four scenes
 * chain through data-goto to make the tour's play-mode flow. The map is one
 * lean SVG - land, a river, a park, roads, buildings - drawn from theme map
 * tokens so it flips with light/dark.
 */
import type { ReactNode } from 'react'
import { cn } from './kit'

/**
 * Anything you can press wears this: the pointer cursor (the canvas is driven
 * by a mouse), a hover that answers, and a real press.
 */
export const tap = 'cursor-pointer transition duration-150 active:scale-[0.985] active:opacity-90'

/**
 * The device frame the whole flow lives in. Phone: a column - map on top, sheet
 * below. From tablet up (`md`) it becomes the desktop ride app: the map goes
 * full-bleed behind everything and the sheet floats as a docked panel. One
 * design, four devices - flip the device in play mode and it re-lays itself.
 */
export function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-full min-h-screen flex-col overflow-hidden bg-card text-card-foreground md:block">
      {children}
    </div>
  )
}

/** Hand-drawn status bar - icon fonts turn to mush, four rects and a fan stay crisp. Phone chrome only. */
export function StatusBar({ onDark }: { onDark?: boolean }) {
  return (
    <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-6 pt-4 md:hidden', onDark ? 'text-white' : 'text-card-foreground')}>
      <span className="text-[15px] font-semibold tnum">9:41</span>
      <svg viewBox="0 0 54 16" className="h-[14px] w-[48px] fill-current" aria-hidden>
        <rect x="0" y="10.4" width="3" height="5.6" rx="1" />
        <rect x="4.6" y="7.6" width="3" height="8.4" rx="1" />
        <rect x="9.2" y="4.8" width="3" height="11.2" rx="1" />
        <rect x="13.8" y="2" width="3" height="14" rx="1" />
        <path d="M27.2 16 20.8 7.4a10.8 10.8 0 0 1 12.8 0Z" />
        <rect x="37.2" y="2.8" width="12.8" height="10.4" rx="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".5" />
        <rect x="38.8" y="4.4" width="8" height="7.2" rx="1.8" />
        <rect x="51" y="6" width="2" height="4" rx="1" opacity=".5" />
      </svg>
    </div>
  )
}

export function HomeBar({ onDark }: { onDark?: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center md:hidden">
      <span className={cn('h-[5px] w-[134px] rounded-full', onDark ? 'bg-white/85' : 'bg-card-foreground/85')} />
    </div>
  )
}

/**
 * The city. One geometry, every screen - so the streets under the route on one
 * frame are the streets on the next. `route` overlays the trip in brand blue.
 */
export function CityMap({
  route, here, car, pins, className,
}: {
  route?: boolean
  /** The blue "you are here" puck, at the pickup corner. */
  here?: boolean
  /** The driver's car, in map coordinates (viewBox 390 x 460). */
  car?: { x: number; y: number; rot?: number }
  pins?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('relative overflow-hidden bg-map-land md:absolute md:inset-0 md:h-full md:w-full', className)}>
      <svg viewBox="0 0 390 460" className="absolute inset-0 size-full" preserveAspectRatio="xMidYMid slice" aria-hidden>
        {/* water */}
        <path d="M-10 40 C 90 70, 150 20, 250 55 S 380 45, 400 70 L 400 -10 L -10 -10 Z" className="fill-map-water" />
        {/* park */}
        <rect x="240" y="240" width="130" height="110" rx="14" className="fill-map-park" />
        {/* roads - the grid, then the two avenues */}
        <g className="stroke-map-road" strokeWidth="10" fill="none">
          <path d="M60 -10 V 470" />
          <path d="M150 -10 V 470" />
          <path d="M300 -10 V 470" />
          <path d="M-10 150 H 400" />
          <path d="M-10 300 H 400" />
          <path d="M-10 390 H 400" />
        </g>
        <g className="stroke-map-road" strokeWidth="16" fill="none">
          <path d="M225 -10 V 470" />
          <path d="M-10 220 H 400" />
        </g>
        {/* buildings */}
        <g className="fill-map-building">
          <rect x="76" y="164" width="58" height="42" rx="4" />
          <rect x="76" y="234" width="26" height="52" rx="4" />
          <rect x="110" y="234" width="26" height="52" rx="4" />
          <rect x="164" y="164" width="46" height="42" rx="4" />
          <rect x="164" y="236" width="46" height="50" rx="4" />
          <rect x="240" y="90" width="46" height="46" rx="4" />
          <rect x="312" y="90" width="58" height="46" rx="4" />
          <rect x="312" y="164" width="58" height="42" rx="4" />
          <rect x="76" y="316" width="58" height="58" rx="4" />
          <rect x="164" y="316" width="46" height="58" rx="4" />
          <rect x="240" y="404" width="60" height="50" rx="4" />
          <rect x="14" y="164" width="32" height="42" rx="4" />
          <rect x="14" y="316" width="32" height="58" rx="4" />
        </g>
        {/* the trip: Fern Street (bottom-left) to the studio by the park */}
        {route && (
          <g fill="none">
            <path d="M105 358 H 225 V 220 H 300" stroke="var(--brand)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />
            <circle cx="105" cy="358" r="8" fill="var(--card)" stroke="var(--brand)" strokeWidth="5" />
            <rect x="291" y="211" width="18" height="18" rx="5" fill="var(--brand)" />
          </g>
        )}
        {/* you, standing on the corner */}
        {here && (
          <g>
            <circle cx="105" cy="358" r="22" fill="var(--brand)" opacity="0.16" />
            <circle cx="105" cy="358" r="9" fill="var(--brand)" stroke="var(--card)" strokeWidth="3.5" />
          </g>
        )}
        {/* the car, nosing along the avenue */}
        {car && (
          <g transform={`translate(${car.x} ${car.y}) rotate(${car.rot ?? 0})`}>
            <rect x="-13" y="-13" width="26" height="26" rx="9" fill="var(--card-foreground)" opacity="0.92" />
            <g transform="translate(-9 -5.5) scale(0.45)" className="fill-card">
              <path d="M4 15c0-2 1-3.4 3-3.8l3.4-.7 3.2-4.1A4 4 0 0 1 16.7 5h7.9a4 4 0 0 1 3 1.4l3.7 4.2 3.1.7c1.8.4 2.6 1.7 2.6 3.5V18a1.5 1.5 0 0 1-1.5 1.5h-2.1a4.2 4.2 0 0 1-8.2 0H15.8a4.2 4.2 0 0 1-8.2 0H5.5A1.5 1.5 0 0 1 4 18Z" />
            </g>
          </g>
        )}
      </svg>
      {pins}
    </div>
  )
}

/**
 * The circular control that floats over the map - back, always wired somewhere.
 * On phones it sits over the map's top-left; from tablet up the sheet owns that
 * corner, so it crosses to the right.
 */
export function MapBack({ to, label = 'Back' }: { to: string; label?: string }) {
  return (
    <button
      data-goto={to}
      aria-label={label}
      className={cn(
        'absolute top-14 left-5 z-20 flex size-10 items-center justify-center rounded-full bg-card text-card-foreground shadow-[0_2px_12px_-2px_rgba(0,0,0,0.35)] hover:bg-muted',
        'md:top-6 md:left-auto md:right-6 lg:top-8 lg:right-8',
        tap,
      )}
    >
      <svg viewBox="0 0 20 20" className="size-[18px]" fill="none" aria-hidden>
        <path d="m12 4.5-5.5 5.5 5.5 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/** The ride's car mark - the option rows and the map marker share one silhouette. */
export function CarGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 24" className={className} fill="currentColor" aria-hidden>
      <path d="M4 15c0-2 1-3.4 3-3.8l3.4-.7 3.2-4.1A4 4 0 0 1 16.7 5h7.9a4 4 0 0 1 3 1.4l3.7 4.2 3.1.7c1.8.4 2.6 1.7 2.6 3.5V18a1.5 1.5 0 0 1-1.5 1.5h-2.1a4.2 4.2 0 0 1-8.2 0H15.8a4.2 4.2 0 0 1-8.2 0H5.5A1.5 1.5 0 0 1 4 18Zm10.6-4.7h5V7h-2.7a1.6 1.6 0 0 0-1.3.7Zm7.4 0h6l-2.9-3.3H22Z" />
      <circle cx="11.7" cy="19.2" r="2.4" />
      <circle cx="28.3" cy="19.2" r="2.4" />
    </svg>
  )
}

/**
 * The sheet the whole flow reads from. On a phone it is the bottom sheet: card
 * language, a real shadow, the grabber. From tablet up it lifts off the floor
 * and docks as a floating panel over a full-bleed map - same content, same
 * order, laid out for the device it landed on.
 */
export function Sheet({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'relative z-10 -mt-5 flex flex-1 flex-col rounded-t-[22px] bg-card px-6 pt-3 shadow-[0_-8px_30px_-10px_rgba(0,0,0,0.25)]',
        'md:absolute md:inset-y-6 md:left-6 md:mt-0 md:w-[382px] md:flex-none md:overflow-y-auto md:rounded-[26px] md:px-7 md:pt-7 md:pb-7 md:shadow-[0_20px_54px_-14px_rgba(0,0,0,0.38)]',
        'lg:inset-y-9 lg:left-9 lg:w-[420px] lg:px-8',
        className,
      )}
    >
      <div className="mx-auto mb-4 h-[5px] w-[40px] rounded-full bg-muted-foreground/25 md:hidden" />
      {children}
    </div>
  )
}

/**
 * Moss, for real - a free-licence Unsplash portrait, cropped to the face.
 * The initials disc sits underneath, so a cold cache still reads as a driver.
 */
const MOSS_PHOTO =
  'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=240&h=240&fit=crop&crop=faces&q=75'

export function DriverFace({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'relative flex size-[52px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#5856d6] text-[19px] font-bold text-white ring-1 ring-black/5',
        className,
      )}
    >
      MO
      <img src={MOSS_PHOTO} alt="" className="absolute inset-0 size-full object-cover" />
    </span>
  )
}
