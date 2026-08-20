import { useState } from 'react'
import { CarGlyph, CityMap, HomeBar, MapBack, Screen, Sheet, StatusBar, tap } from '../../../src/components/ride'
import { cn } from '../../../src/components/kit'

export const meta = { title: 'Ride - choose', viewport: 'mobile' }

const OPTIONS = [
  { name: 'Solo', eta: '3 min away', price: '$11.20', seats: 1 },
  { name: 'Comfort', eta: '4 min away', price: '$14.80', seats: 4 },
  { name: 'XL', eta: '7 min away', price: '$19.40', seats: 6 },
]

export default function Choose() {
  /** Nothing is chosen for you. The CTA stays dead until a row wins. */
  const [picked, setPicked] = useState<string | null>(null)
  const [nudge, setNudge] = useState(false)

  return (
    <Screen>
      <StatusBar />
      <CityMap
        route
        car={{ x: 150, y: 358 }}
        className="h-[340px] shrink-0"
        pins={<MapBack to="ride/where-to" label="Back to destinations" />}
      />
      <Sheet>
        <h1 className="text-[20px] font-bold tracking-[-0.02em]">Choose your ride</h1>
        <div className="mt-3 space-y-2.5">
          {OPTIONS.map((o) => {
            const on = picked === o.name
            return (
              <button
                key={o.name}
                aria-pressed={on}
                onClick={() => {
                  setPicked(o.name)
                  setNudge(false)
                }}
                className={cn(
                  'flex w-full items-center gap-4 rounded-[16px] border-2 px-4 py-3 text-left transition-colors duration-150',
                  on
                    ? 'border-brand bg-brand-wash'
                    : 'border-transparent bg-muted hover:border-border hover:bg-muted/70',
                  tap,
                )}
              >
                <CarGlyph className={cn('w-[44px] shrink-0 transition-colors', on ? 'text-brand-ink' : 'text-muted-foreground')} />
                <div className="min-w-0">
                  <p className="text-[16px] leading-tight font-semibold">
                    {o.name} <span className="ml-1 text-[12.5px] font-medium text-muted-soft">· {o.seats} seats</span>
                  </p>
                  <p className={cn('mt-0.5 text-[13.5px]', on ? 'font-medium text-brand-ink' : 'text-muted-foreground')}>{o.eta}</p>
                </div>
                <p className="ml-auto text-[17px] font-bold tnum">{o.price}</p>
                {/* the tick only exists once the row is yours */}
                <span
                  className={cn(
                    'flex size-[22px] shrink-0 items-center justify-center rounded-full transition duration-150',
                    on ? 'scale-100 bg-brand text-white opacity-100' : 'scale-75 opacity-0',
                  )}
                  aria-hidden
                >
                  <svg viewBox="0 0 20 20" className="size-[13px]" fill="none">
                    <path d="m4.5 10.5 3.6 3.5L15.5 6.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-3.5 flex items-center gap-3 border-t border-border pt-3.5 text-[13.5px] text-muted-foreground">
          <svg viewBox="0 0 20 20" className="size-[18px]" fill="none" aria-hidden>
            <rect x="1.5" y="4" width="17" height="12.5" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
            <path d="M1.5 8h17" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Personal · Visa ··4242
          <span className="ml-auto text-[12.5px] text-muted-soft">Arrives 9:53</span>
        </div>
        <div className="group relative mt-auto mb-8 md:mt-7 md:mb-0">
          {/* the nudge: on hover of the dead button, and pinned for a beat if it gets pressed */}
          <div
            role="tooltip"
            className={cn(
              'pointer-events-none absolute bottom-[calc(100%+10px)] left-1/2 -translate-x-1/2 rounded-[10px] bg-card-foreground px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap text-card shadow-[0_6px_18px_-6px_rgba(0,0,0,0.45)] transition duration-150',
              picked
                ? 'invisible opacity-0'
                : nudge
                  ? 'translate-y-0 opacity-100'
                  : 'translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100',
            )}
          >
            Select a ride type first
            <span className="absolute top-full left-1/2 -ml-[5px] border-[5px] border-transparent border-t-card-foreground" />
          </div>
          <button
            {...(picked ? { 'data-goto': 'ride/arriving' } : {})}
            aria-disabled={!picked}
            onClick={() => {
              if (!picked) setNudge(true)
            }}
            className={cn(
              'h-[54px] w-full rounded-full text-[16.5px] font-bold transition-colors duration-150',
              picked
                ? cn('bg-brand text-white hover:bg-brand-ink', tap)
                : 'cursor-not-allowed bg-muted text-muted-soft',
            )}
          >
            {picked ? `Choose ${picked}` : 'Choose your ride'}
          </button>
        </div>
      </Sheet>
      <HomeBar />
    </Screen>
  )
}
