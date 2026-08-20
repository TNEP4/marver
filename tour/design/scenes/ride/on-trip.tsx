import { CityMap, DriverFace, HomeBar, MapBack, Screen, Sheet, StatusBar, tap } from '../../../src/components/ride'
import { cn } from '../../../src/components/kit'

export const meta = { title: 'Ride - on trip', viewport: 'mobile' }

export default function OnTrip() {
  return (
    <Screen>
      <StatusBar />
      <CityMap
        route
        car={{ x: 225, y: 250, rot: -90 }}
        className="h-[420px] shrink-0"
        pins={<MapBack to="ride/arriving" label="Back to pickup" />}
      />
      <Sheet>
        <div className="flex items-baseline justify-between">
          <h1 className="text-[20px] font-bold tracking-[-0.02em]">Heading to Fern Street</h1>
          <p className="text-[15px] font-semibold text-muted-foreground tnum">9:53</p>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="size-2 rounded-full bg-good" />
          <p className="text-[13.5px] font-medium text-muted-foreground">On the fastest route · 8 min left</p>
        </div>
        <div className="mt-3 h-[5px] overflow-hidden rounded-full bg-muted">
          <span className="block h-full w-[42%] rounded-full bg-brand" />
        </div>

        <div className="mt-5 flex items-start gap-3.5">
          <div className="mt-1 flex flex-col items-center gap-1">
            <span className="size-[9px] rounded-full border-[2.5px] border-brand bg-card" />
            <span className="h-[26px] w-[2px] rounded-full bg-border" />
            <span className="size-[9px] rounded-[3px] bg-brand" />
          </div>
          <div className="min-w-0 space-y-3">
            <div>
              <p className="text-[15px] font-semibold">Calder &amp; 3rd</p>
              <p className="text-[12.5px] text-muted-soft">Picked up 9:45</p>
            </div>
            <div>
              <p className="text-[15px] font-semibold">Fern Street Studio</p>
              <p className="text-[12.5px] text-muted-soft">18 Fern St</p>
            </div>
          </div>
          <button
            data-goto="ride/arriving"
            className={cn('ml-auto flex items-center gap-2.5 rounded-full py-1 pr-2 pl-1 hover:bg-muted', tap)}
          >
            <DriverFace className="size-9 text-[13px]" />
            <span className="text-[13.5px] font-medium text-muted-foreground">Moss</span>
          </button>
        </div>

        <button
          data-goto="ride/where-to"
          className={cn('mt-auto mb-8 h-[54px] shrink-0 rounded-full bg-muted text-[16px] font-semibold text-foreground hover:bg-border/70 md:mt-7 md:mb-0', tap)}
        >
          End demo · back to Where to?
        </button>
      </Sheet>
      <HomeBar />
    </Screen>
  )
}
