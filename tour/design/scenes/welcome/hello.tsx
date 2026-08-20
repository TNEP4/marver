import { Ink, Kbd, MiniBar, MiniBlock, MiniButton, MiniFrame, Slide } from '../../../src/components/kit'

export const meta = { title: 'Welcome', viewport: 'laptop' }

export default function Hello() {
  return (
    <Slide
      eyebrow="Welcome"
      step="1 of 5"
      title="Your design canvas is a folder in your repo."
      lead={
        <>
          This is marver - a live canvas of <Ink>frames built from real code</Ink>, rendered
          with a real theme and real components. Nothing here is a mockup or a screenshot:
          every frame you see is a React component in a file, and this canvas is what a
          published marver canvas feels like.
        </>
      }
      hint={
        <>
          Scroll to glide around, pinch or <Kbd className="mx-1">⌘</Kbd> scroll to zoom -
          then head to the next frame on the right.
        </>
      }
    >
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
        <div className="grid w-full max-w-[440px] grid-cols-[1.3fr_1fr] items-start gap-4">
          <MiniFrame title="landing/hero" badge="laptop" state="selected">
            <div className="space-y-2">
              <MiniBar w="36%" tone="ink" />
              <MiniBar w="72%" tone="ink" />
              <div className="space-y-1.5 pt-1">
                <MiniBar />
                <MiniBar w="64%" />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <MiniButton />
                <MiniBar w="26%" />
              </div>
              <MiniBlock className="h-12" />
            </div>
          </MiniFrame>
          <div className="space-y-4">
            <MiniFrame title="checkout/payment" badge="live" state="interact">
              <div className="space-y-1.5">
                <MiniBar w="50%" tone="ink" />
                <MiniBlock className="h-5" />
                <MiniBlock className="h-5" />
                <div className="flex justify-end pt-0.5">
                  <MiniButton />
                </div>
              </div>
            </MiniFrame>
            <MiniFrame title="onboarding/welcome" badge="mobile">
              <div className="space-y-1.5">
                <MiniBar w="44%" tone="ink" />
                <MiniBar />
                <MiniBar w="58%" />
              </div>
            </MiniFrame>
          </div>
        </div>

        <div className="glass w-full max-w-[420px] rounded-panel p-6">
          <p className="text-[13px] font-semibold tracking-[0.08em] text-brand uppercase">Meanwhile</p>
          <p className="mt-2.5 text-[15.5px] leading-[1.55] text-glass-ink/85">
            Your coding agent is setting up your own workspace right now. It may ask you a
            question or two along the way - glance at the terminal now and then. This canvas
            is yours in the meantime: by the end of it, you will know exactly what your agent
            just built you.
          </p>
        </div>
      </div>
    </Slide>
  )
}
