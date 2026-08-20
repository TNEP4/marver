import { CityMap, DriverFace, HomeBar, MapBack, Screen, Sheet, StatusBar, tap } from '../../../src/components/ride'
import { cn } from '../../../src/components/kit'

export const meta = { title: 'Ride - arriving', viewport: 'mobile' }

function RoundBtn({ children, label, goto }: { children: React.ReactNode; label: string; goto?: string }) {
  return (
    <button data-goto={goto} className={cn('flex flex-col items-center gap-1.5', tap)}>
      <span className="flex size-11 items-center justify-center rounded-full bg-muted text-foreground hover:bg-border/70">
        {children}
      </span>
      <span className="text-[11.5px] font-medium text-muted-foreground">{label}</span>
    </button>
  )
}

export default function Arriving() {
  return (
    <Screen>
      <StatusBar />
      <CityMap
        route
        car={{ x: 225, y: 300, rot: -90 }}
        className="h-[360px] shrink-0"
        pins={<MapBack to="ride/choose" label="Back to ride options" />}
      />
      <Sheet>
        <div className="flex items-baseline justify-between">
          <h1 className="text-[20px] font-bold tracking-[-0.02em]">Moss is on the way</h1>
          <p className="text-[26px] font-bold text-brand-ink tnum">4 min</p>
        </div>
        <p className="mt-1 text-[13.5px] text-muted-foreground">Meeting you at Calder &amp; 3rd, by the corner shop</p>
        <div className="mt-3.5 flex items-center gap-4 rounded-[16px] bg-muted px-4 py-3.5">
          <DriverFace />
          <div className="min-w-0">
            <p className="text-[16px] font-semibold">Moss O.</p>
            <p className="mt-0.5 flex items-center gap-1 text-[13.5px] text-muted-foreground">
              <svg viewBox="0 0 20 20" className="size-[13px] fill-amber-500" aria-hidden>
                <path d="m10 1.7 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8Z" />
              </svg>
              4.96 · Comfort
            </p>
          </div>
          <div className="ml-auto text-right">
            <p className="rounded-[8px] border border-border bg-card px-2.5 py-1 text-[15px] font-bold tracking-[0.04em]">8XK 442</p>
            <p className="mt-1 text-[12px] text-muted-soft">Silver Polestar 2</p>
          </div>
        </div>
        <div className="mt-5 flex justify-center gap-8">
          <RoundBtn label="Call">
            <svg viewBox="0 0 20 20" className="size-5" fill="currentColor" aria-hidden>
              <path d="M6.6 2.8c.5-.5 1.3-.4 1.7.1l1.6 2.1c.4.5.3 1.2-.1 1.6l-1 1a11.6 11.6 0 0 0 3.6 3.6l1-1c.4-.4 1.1-.5 1.6-.1l2.1 1.6c.5.4.6 1.2.1 1.7l-1.2 1.2c-.5.5-1.2.7-1.9.5-4.6-1.4-8.3-5.1-9.7-9.7-.2-.7 0-1.4.5-1.9Z" />
            </svg>
          </RoundBtn>
          <RoundBtn label="Message">
            <svg viewBox="0 0 20 20" className="size-5" fill="currentColor" aria-hidden>
              <path d="M10 2.5c4.7 0 8.5 3.1 8.5 7s-3.8 7-8.5 7c-.9 0-1.8-.1-2.6-.4l-3.5 1.4a.7.7 0 0 1-.9-.9l.9-2.6C2.4 12.7 1.5 11.2 1.5 9.5c0-3.9 3.8-7 8.5-7Z" />
            </svg>
          </RoundBtn>
          <RoundBtn label="Share trip" goto="ride/on-trip">
            <svg viewBox="0 0 20 20" className="size-5" fill="none" aria-hidden>
              <path d="M10 12.5v-9m0 0L6.8 6.7M10 3.5l3.2 3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 10.5v5a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </RoundBtn>
        </div>
        <button
          data-goto="ride/on-trip"
          className={cn('mt-auto mb-8 h-[54px] shrink-0 rounded-full bg-brand text-[16.5px] font-bold text-white hover:bg-brand-ink md:mt-7 md:mb-0', tap)}
        >
          I’m at the pickup
        </button>
      </Sheet>
      <HomeBar />
    </Screen>
  )
}
