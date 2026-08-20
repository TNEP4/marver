import { CityMap, HomeBar, Screen, Sheet, StatusBar, tap } from '../../../src/components/ride'
import { cn } from '../../../src/components/kit'

export const meta = { title: 'Ride - where to', viewport: 'mobile' }

const SAVED = [
  { name: 'Home', addr: 'Calder & 3rd' },
  { name: 'Work', addr: '990 Marsh' },
]

const RECENTS = [
  { name: 'Fern Street Studio', addr: '18 Fern St · 12 min' },
  { name: 'Union Station', addr: 'Great Hall entrance · 24 min' },
  { name: 'Aeliana’s', addr: '204 College Ave · 9 min' },
]

export default function WhereTo() {
  return (
    <Screen>
      <StatusBar />
      <CityMap here className="h-[400px] shrink-0" />
      <Sheet>
        <h1 className="text-[24px] font-bold tracking-[-0.02em]">Where to?</h1>
        <button
          data-goto="ride/choose"
          className={cn(
            'mt-4 flex h-[52px] items-center gap-3 rounded-[14px] bg-muted px-4 text-left hover:bg-border/70',
            tap,
          )}
        >
          <svg viewBox="0 0 20 20" className="size-5 text-muted-foreground" fill="none" aria-hidden>
            <circle cx="9" cy="9" r="6.25" stroke="currentColor" strokeWidth="1.8" />
            <path d="m13.8 13.8 3.4 3.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span className="text-[16px] font-medium text-muted-foreground">Search destination</span>
        </button>
        <div className="mt-2.5 flex gap-2">
          {SAVED.map((s) => (
            <button
              key={s.name}
              data-goto="ride/choose"
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-full border border-border px-3 py-2 text-left hover:border-brand hover:bg-brand-wash',
                tap,
              )}
            >
              <svg viewBox="0 0 20 20" className="size-4 shrink-0 text-brand-ink" fill="currentColor" aria-hidden>
                <path d="M10 2.2 2.5 8.4V17a1 1 0 0 0 1 1h4v-5h5v5h4a1 1 0 0 0 1-1V8.4Z" />
              </svg>
              <span className="min-w-0 truncate text-[13.5px] font-semibold">{s.name}</span>
              <span className="min-w-0 truncate text-[12.5px] text-muted-soft">{s.addr}</span>
            </button>
          ))}
        </div>
        <div className="mt-1 divide-y divide-border">
          {RECENTS.map((r) => (
            <button
              key={r.name}
              data-goto="ride/choose"
              className={cn('-mx-2 flex w-[calc(100%+1rem)] items-center gap-3.5 rounded-[12px] px-2 py-3.5 text-left hover:bg-muted', tap)}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <svg viewBox="0 0 20 20" className="size-[18px] text-muted-foreground" fill="none" aria-hidden>
                  <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M10 6v4.2l2.8 1.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[16px] font-semibold">{r.name}</span>
                <span className="block truncate text-[13.5px] text-muted-foreground">{r.addr}</span>
              </span>
              <svg viewBox="0 0 20 20" className="ml-auto size-5 shrink-0 text-muted-soft" fill="none" aria-hidden>
                <path d="m7.5 4.5 5.5 5.5-5.5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ))}
        </div>
        <p className="mt-auto mb-8 pt-6 text-center text-[12px] text-muted-soft md:mb-0">
          A demo, and a real prototype: tap anything here to ride the flow.
        </p>
      </Sheet>
      <HomeBar />
    </Screen>
  )
}
