import { cn } from '../../../src/components/kit'

export const meta = { title: 'Ride - start here', viewport: 'mobile' }

/**
 * The doorway to the ride flow. Everything left of here is the canvas explaining
 * itself; this is the first frame that asks for a hand - so it is white, nearly
 * empty, and holds exactly one thing you can press.
 *
 * That one thing carries both states in the frame: at rest it is a plain white
 * card, on hover a blue gradient blooms behind it and the card turns brand blue.
 * Pressing it runs data-goto - in play mode you land on the next screen.
 *
 * The column centres and grows from tablet up, so the same doorway reads on a
 * phone, a laptop and a monitor - flip the device and it re-lays itself.
 */

/** The play triangle - the same mark the canvas toolbar wears. */
function PlayGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={className} fill="currentColor" aria-hidden>
      <path d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27Z" />
    </svg>
  )
}

export default function Start() {
  return (
    <div className="flex h-full min-h-screen flex-col justify-center bg-white px-7 py-14 text-[#18181b] md:mx-auto md:w-full md:max-w-[620px] md:px-10 lg:max-w-[720px]">
      <h1 className="text-[40px] leading-[1.05] font-bold tracking-[-0.035em] text-balance md:text-[52px] lg:text-[60px]">
        Let’s try prototype mode.
      </h1>
      <p className="mt-4 text-[17px] leading-[1.45] text-[#6e6e73] md:mt-5 md:text-[19px]">
        Four screens sit to the right, wired to each other. Press this and they run
        like the real app.
      </p>

      <button
        data-testid="ride-start-cta"
        data-goto="ride/where-to"
        className={cn(
          'group relative isolate mt-10 flex w-full cursor-pointer items-center gap-5 rounded-[24px] bg-transparent px-7 py-7 text-left',
          'transition-transform duration-200 ease-out hover:-translate-y-1 active:translate-y-0 active:scale-[0.99]',
        )}
      >
        {/* the bloom: blue gradient, blurred, only on hover */}
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-3 -z-20 rounded-[32px] opacity-0 blur-2xl transition-opacity duration-200 ease-out group-hover:opacity-100"
          style={{
            background:
              'linear-gradient(140deg, rgba(0,136,255,0.75), rgba(0,136,255,0.25) 55%, rgba(92,179,255,0.7))',
          }}
        />
        {/* the surface: white at rest, brand blue on hover */}
        <span
          aria-hidden
          className="absolute inset-0 -z-10 rounded-[24px] border border-[#e5e5ea] bg-white transition-colors duration-200 ease-out group-hover:border-[#0088ff] group-hover:bg-[#0088ff]"
        />

        <span className="min-w-0">
          <span className="block text-[20px] leading-[1.2] font-bold tracking-[-0.02em] transition-colors duration-200 ease-out group-hover:text-white md:text-[22px]">
            Start the ride
          </span>
          <span className="mt-1 block text-[14.5px] leading-[1.35] text-[#6e6e73] transition-colors duration-200 ease-out group-hover:text-white/80 md:text-[15.5px]">
            Then keep tapping - every screen goes somewhere.
          </span>
        </span>
        <svg
          viewBox="0 0 20 20"
          className="ml-auto size-6 shrink-0 text-[#c7c7cc] transition-colors duration-200 ease-out group-hover:text-white"
          fill="none"
          aria-hidden
        >
          <path
            d="M4 10h11m0 0-4.5-4.5M15 10l-4.5 4.5"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="mt-8 flex items-start gap-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#0088ff]">
          <PlayGlyph className="size-[15px]" />
        </span>
        <p className="text-[13.5px] leading-[1.5] text-[#86868b] md:text-[14.5px]">
          Select this frame and press{' '}
          <kbd className="mx-px inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[6px] border border-[#e5e5ea] bg-[#f9f9fb] px-1.5 text-[12.5px] font-semibold text-[#18181b]">
            P
          </kbd>{' '}
          - or hit play in the toolbar. It fills the screen inside a phone, and{' '}
          <kbd className="mx-px inline-flex h-[22px] items-center justify-center rounded-[6px] border border-[#e5e5ea] bg-[#f9f9fb] px-1.5 text-[12.5px] font-semibold text-[#18181b]">
            1
          </kbd>
          –
          <kbd className="mx-px inline-flex h-[22px] items-center justify-center rounded-[6px] border border-[#e5e5ea] bg-[#f9f9fb] px-1.5 text-[12.5px] font-semibold text-[#18181b]">
            4
          </kbd>{' '}
          swap the device under you. Esc brings you back.
        </p>
      </div>
    </div>
  )
}
