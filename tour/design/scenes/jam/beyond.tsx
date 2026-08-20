import { MarverMark, cn } from '../../../src/components/kit'

export const meta = { title: 'And beyond', viewport: 'mobile' }

/**
 * The jam board's send-off, and the tour's switchboard. Each card is a real
 * data-goto: press P and this phone becomes a menu you can tap - the canvas
 * follows the frame to whichever board it lives on.
 */

const NEXT = [
  {
    name: 'thanks',
    body: 'The end of the tour - and the two commands that start yours.',
    goto: 'thanks/end-of-tour',
    next: true,
  },
]

export default function Beyond() {
  return (
    <div className="flex h-full min-h-screen flex-col bg-background px-7 pt-14 pb-10 text-foreground">
      <div className="flex items-center gap-2">
        <MarverMark className="size-4 text-brand" />
        <span className="text-[12px] font-semibold tracking-[0.08em] text-brand uppercase">Live Jam · 3 of 3</span>
      </div>
      <h1 className="mt-4 text-[30px] leading-[1.12] font-semibold tracking-[-0.025em]">
        One board to go.
      </h1>
      <p className="mt-4 text-[15px] leading-[1.55] text-muted-foreground">
        The loop you just watched is the whole tool in one motion - designs, feedback and
        your agent on the same canvas. One stop left.
      </p>

      <div className="mt-8 space-y-3.5">
        {NEXT.map((n) => (
          <button
            key={n.name}
            type="button"
            data-goto={n.goto}
            className={cn(
              'group w-full cursor-pointer rounded-card border p-5 text-left transition duration-150',
              'hover:-translate-y-0.5 hover:border-brand hover:bg-brand-wash hover:shadow-lift',
              'active:translate-y-0 active:scale-[0.985] active:bg-brand-wash active:shadow-node',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
              n.next ? 'border-brand bg-brand-wash' : 'border-border bg-surface-2',
            )}
          >
            <div className="flex items-center gap-2">
              <MarverMark
                className={cn(
                  'size-[14px] transition-colors duration-150 group-hover:text-brand',
                  n.next ? 'text-brand' : 'text-muted-soft',
                )}
              />
              <span
                className={cn(
                  'text-[12.5px] font-semibold tracking-[0.08em] uppercase transition-colors duration-150 group-hover:text-brand-ink',
                  n.next ? 'text-brand-ink' : 'text-muted-soft',
                )}
              >
                {n.name}
              </span>
              {n.next && (
                <span className="ml-auto text-[11px] font-semibold tracking-[0.04em] text-brand-ink/70 uppercase group-hover:hidden">
                  next
                </span>
              )}
              <span className="ml-auto hidden items-center gap-1 text-[11px] font-semibold tracking-[0.04em] text-brand-ink uppercase group-hover:flex group-active:flex">
                open
                <svg viewBox="0 0 16 16" className="size-3" fill="none" aria-hidden>
                  <path
                    d="m6 3.5 4.5 4.5L6 12.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </div>
            <p className="mt-2 text-[13.5px] leading-[1.5] text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
              {n.body}
            </p>
          </button>
        ))}
      </div>

      <p className="mt-auto pt-8 text-[13px] leading-[1.5] text-muted-soft">
        Press P to make this frame live, then tap a board. Esc brings you back.
      </p>
    </div>
  )
}
