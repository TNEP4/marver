import { Cursor, DemoNode, GlassBar, GlassBtn, Ink, Kbd, Move, Slide } from '../../../src/components/kit'

export const meta = { title: 'Two ways to run it', viewport: 'laptop' }

/**
 * The prototype board's opening claim: wired frames can be DRIVEN two ways, and
 * the tour has been quietly using one of them since the welcome board. Interact
 * runs one frame in place on the canvas; prototype (play) takes the whole flow
 * full screen. Same files, same data-goto wiring - different depth of visit.
 */

/** The play triangle - the mark the canvas toolbar wears. */
function PlayGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={className} fill="currentColor" aria-hidden>
      <path d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27Z" />
    </svg>
  )
}

/** Interact: the board stays put, one frame goes live under the cursor. */
const InPlace = (
  <>
    <div className="flex h-full items-center justify-center gap-3">
      <DemoNode w={52} h={72} className="opacity-60" />
      <DemoNode w={52} h={72} state="interact" />
      <DemoNode w={52} h={72} className="opacity-60" />
    </div>
    <Cursor className="top-[calc(50%+6px)] left-[calc(50%-4px)] w-[17px]" />
  </>
)

/** Prototype: the board falls away, the flow runs full screen in a device. */
const FullScreen = (
  <>
    <div className="absolute inset-0 flex items-center justify-center gap-3 opacity-25">
      <DemoNode w={46} h={64} />
      <DemoNode w={46} h={64} />
      <DemoNode w={46} h={64} />
    </div>
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex h-[104px] w-[56px] flex-col overflow-hidden rounded-[10px] border border-interact bg-(--node-bg) shadow-[0_0_0_3px_rgba(219,53,242,0.18),var(--shadow-lift)]">
        <div className="h-[44%] bg-muted" />
        <div className="flex flex-1 flex-col p-1.5">
          <span className="block h-[4px] w-[62%] rounded-full bg-foreground/70" />
          <span className="mt-1 block h-[3px] w-[42%] rounded-full bg-muted-foreground/30" />
          <div className="mt-auto h-[9px] rounded-full bg-brand" />
        </div>
      </div>
    </div>
    <div className="absolute inset-x-0 bottom-2 flex justify-center">
      <GlassBar>
        <GlassBtn on className="h-[24px] px-2.5 text-[11.5px]">
          <PlayGlyph className="size-[9px]" />
          play
        </GlassBtn>
      </GlassBar>
    </div>
  </>
)

export default function TwoWays() {
  return (
    <Slide
      eyebrow="Prototype"
      step="1 of 7"
      title="One wired flow, two ways to run it."
      lead={
        <>
          Every frame here is wired to the next with <Ink>data-goto</Ink> - and there are two
          doors into that wiring. <Ink>Interact</Ink> runs one frame in place, right on the
          canvas: the quick feel-check. <Ink>Prototype</Ink> takes the whole flow full screen
          inside a device: the complete experience, in the weeds.
        </>
      }
      hint={
        <>
          Try the ride to the right both ways: double-click <Ink>Start here</Ink> to tap
          through in place, or press <Kbd className="mx-1">p</Kbd> on it for the full-screen
          ride. The next frame has all the play controls.
        </>
      }
    >
      <div className="grid max-w-[980px] grid-cols-1 gap-4 sm:grid-cols-2">
        <Move
          keys={<span className="text-[12.5px] font-semibold tracking-[0.04em] text-interact-ink uppercase">double-click</span>}
          action="Interact - feel it from the canvas."
          demo={InPlace}
          wide
        >
          The frame wakes under your cursor while the board stays around you. Scroll it, tap
          its links, check one screen fast - <Kbd className="mx-0.5 h-[20px] min-w-[20px] px-1 text-[11px]">Esc</Kbd> or a click outside steps back out.
        </Move>
        <Move
          keys={<Kbd>p</Kbd>}
          action="Prototype - ride it full screen."
          demo={FullScreen}
          wide
        >
          The board falls away and the design runs inside a device - taps navigate screen to
          screen, variants and devices flip live. The detailed run-through of the whole journey.
        </Move>
      </div>
    </Slide>
  )
}
