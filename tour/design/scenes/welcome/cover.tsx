import { MarverMark, ThreadCard, ThreadMsg, cn } from '../../../src/components/kit'

export const meta = { title: 'The marver tour', viewport: 'laptop' }

/**
 * The tour's cover, and the twin of thanks/end-of-tour: same halo, same mark,
 * same thread card. Marver says hello here and signs off there, so the whole
 * tour sits between two frames that are unmistakably a pair.
 *
 * The route is the one piece of information a cover owes you - where you are,
 * and what the six stops are. Drawn as a line with stations, not a menu: the
 * board picker is next-stop's job, five frames from here.
 */

const ROUTE = ['welcome', 'canvas', 'prototype', 'collaborate', 'jam', 'thanks']

/** One stop on the line: the dot, then its name underneath. */
function Stop({ name, here }: { name: string; here?: boolean }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-2">
      <span
        className={cn(
          'size-[11px] rounded-full',
          here ? 'bg-brand ring-4 ring-brand/20' : 'bg-muted-foreground/30',
        )}
      />
      <span
        className={cn(
          'text-[12.5px] font-semibold tracking-[0.02em]',
          here ? 'text-brand-ink' : 'text-muted-soft',
        )}
      >
        {name}
      </span>
    </div>
  )
}

export default function Cover() {
  return (
    <div className="relative flex h-full min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-6 text-center text-foreground md:px-16">
      {/* the same quiet halo the last frame wears */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 size-[620px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-wash blur-3xl" />

      <MarverMark className="size-12 text-brand" />
      <h1 className="mt-8 text-[42px] leading-[1.04] font-semibold tracking-[-0.032em] sm:text-[52px]">
        The marver tour.
      </h1>

      <ThreadCard className="mt-9 w-full max-w-[520px]">
        <ThreadMsg agent time="now">
          Hello and welcome! 👋 Make yourself at home - everything here is live, so poke at
          anything you like. Five more frames sit to your right on this board, then five more
          boards in the sidebar, one idea each. Go through them in order and you will have
          seen the whole tool by the end.
        </ThreadMsg>
      </ThreadCard>

      {/* the route: six stops, and the one you are standing on */}
      <div className="mt-11 flex w-full max-w-[264px] flex-wrap items-start justify-center gap-x-4 gap-y-5 sm:max-w-[620px]">
        {ROUTE.map((name, i) => (
          <div key={name} className="flex shrink-0 items-start gap-4">
            {i > 0 && <span className="mt-[5px] hidden h-px w-8 bg-border sm:block" />}
            <Stop name={name} here={i === 0} />
          </div>
        ))}
      </div>

      <p className="mt-11 text-[14px] font-medium text-muted-soft">
        Two-finger scroll to glide, pinch to zoom. Keep going right.
      </p>
    </div>
  )
}
