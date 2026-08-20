import { MarverMark, ThreadCard, ThreadMsg } from '../../../src/components/kit'

export const meta = { title: 'End of the tour', viewport: 'laptop' }

/**
 * The send-off. Marver has been the voice on every board, so it signs off in the
 * one place you would actually talk back to it - a thread card. The halo is the
 * frame's single flourish; everything else gets out of the way.
 */

export default function EndOfTour() {
  return (
    <div className="relative flex h-full min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-16 text-center text-foreground">
      {/* a quiet halo, the send-off's one flourish */}
      <div className="pointer-events-none absolute top-1/2 left-1/2 size-[620px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-wash blur-3xl" />

      <MarverMark className="size-12 text-brand" />
      <h1 className="mt-8 max-w-[18ch] text-[52px] leading-[1.05] font-semibold tracking-[-0.032em]">
        That is the end of the tour.
      </h1>

      <ThreadCard className="mt-9 w-[520px]">
        <ThreadMsg agent time="now">
          Thanks for taking it. If you kicked off an install before you started, go back to
          your coding agent now - it has either finished, or it is waiting on an answer from
          you.
        </ThreadMsg>
      </ThreadCard>

      <p className="mt-9 text-[14px] font-medium text-muted-soft">
        One frame left, and it is the only one that asks anything of you.
      </p>
    </div>
  )
}
