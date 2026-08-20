import type { ReactNode } from 'react'
import {
  Cursor, GlassBar, GlassBtn, Ink, Kbd, Move, Slide, Tag, cn,
} from '../../../src/components/kit'

export const meta = { title: 'Press play', viewport: 'laptop' }

/**
 * The prototype board's opening slide. Everything to the right is one wired ride
 * flow, so this frame only has to hand over the controls: how to start it, what
 * makes it move, and how it re-lays itself when the device changes.
 *
 * The third swatch is the honest one - phone stacks map over sheet, laptop puts
 * the map full-bleed with the sheet docked. Same frames, same file.
 */

/** The play triangle - the mark the canvas toolbar wears. */
function PlayGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={className} fill="currentColor" aria-hidden>
      <path d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27Z" />
    </svg>
  )
}

/** The ride screen at phone scale - map on top, sheet below. */
function PhoneRide({ tapped }: { tapped?: boolean }) {
  return (
    <div className="flex h-full flex-col">
      <div className="h-[46%] bg-muted" />
      <div className="flex flex-1 flex-col rounded-t-[6px] bg-(--node-bg) p-1.5 shadow-[0_-3px_8px_-4px_rgba(0,0,0,0.3)]">
        <span className="mx-auto block h-[2px] w-[14px] rounded-full bg-muted-foreground/30" />
        <span className="mt-1.5 block h-[4px] w-[62%] rounded-full bg-foreground/70" />
        <span className="mt-1 block h-[3px] w-[42%] rounded-full bg-muted-foreground/30" />
        <div className={cn('mt-auto h-[9px] rounded-full bg-brand', tapped && 'ring-[3px] ring-brand/30')} />
      </div>
    </div>
  )
}

/** The same screen, wide: map full-bleed, sheet docked as a panel. */
function WideRide() {
  return (
    <div className="relative h-full bg-muted">
      <div className="absolute inset-y-[7px] left-[7px] flex w-[38%] flex-col rounded-[5px] bg-(--node-bg) p-1.5 shadow-[0_4px_10px_-4px_rgba(0,0,0,0.4)]">
        <span className="block h-[4px] w-[70%] rounded-full bg-foreground/70" />
        <span className="mt-1 block h-[3px] w-[48%] rounded-full bg-muted-foreground/30" />
        <div className="mt-auto h-[8px] rounded-full bg-brand" />
      </div>
    </div>
  )
}

/** A device slab - the live purple ring is play mode's own colour. */
function Slab({
  w, h, live, children, className,
}: {
  w: number
  h: number
  live?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      style={{ width: w, height: h }}
      className={cn(
        'shrink-0 overflow-hidden rounded-[10px] border bg-(--node-bg)',
        live
          ? 'border-interact shadow-[0_0_0_3px_rgba(219,53,242,0.18),var(--shadow-lift)]'
          : 'border-(--node-brd) shadow-(--shadow-node)',
        className,
      )}
    >
      {children}
    </div>
  )
}

/* ── The three swatches ───────────────────────────────────────────────────── */

/** p, or the toolbar's play button - the board dims and one frame comes up live. */
const Enter = (
  <>
    <div className="absolute inset-0 flex items-center justify-center">
      <Slab w={58} h={108} live>
        <PhoneRide tapped />
      </Slab>
    </div>
    <div className="absolute inset-x-0 bottom-3 flex justify-center">
      <GlassBar>
        <GlassBtn>
          <span className="block size-[11px] rounded-[3px] border-[1.5px] border-current" />
        </GlassBtn>
        <GlassBtn on>
          <PlayGlyph className="size-[11px]" />
          play
        </GlassBtn>
      </GlassBar>
    </div>
    <Cursor className="bottom-[26px] left-[calc(50%+16px)] w-[17px]" />
  </>
)

/** Every tap is a data-goto - five screens, one graph, no build. */
const Flow = (
  <div className="flex h-full items-center justify-center gap-[9px] px-2">
    {[0, 1, 2, 3, 4].map((i) => (
      <div key={i} className="flex items-center gap-[9px]">
        {i > 0 && (
          <svg viewBox="0 0 16 10" className="w-[13px] shrink-0 text-brand/45" fill="none" aria-hidden>
            <path d="M1 5h12m0 0-3.5-3.5M13 5l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <Slab w={34} h={64} live={i === 1} className={cn(i !== 1 && 'opacity-55')}>
          <PhoneRide tapped={i === 1} />
        </Slab>
      </div>
    ))}
  </div>
)

/** 1 to 4 - the device changes and the design re-lays itself around it. */
const Devices = (
  <div className="flex h-full items-center justify-center gap-5">
    <div className="flex flex-col items-center gap-2">
      <Slab w={44} h={84} live>
        <PhoneRide />
      </Slab>
      <Kbd className="h-[18px] min-w-[18px] px-1 text-[10px]">1</Kbd>
    </div>
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-col items-center">
        <Slab w={126} h={76} live>
          <WideRide />
        </Slab>
        <span className="h-[3px] w-[146px] rounded-b-[3px] bg-(--node-brd)" />
      </div>
      <Kbd className="h-[18px] min-w-[18px] px-1 text-[10px]">3</Kbd>
    </div>
    <Tag className="top-3 right-3">same file</Tag>
  </div>
)

export default function PressPlay() {
  return (
    <Slide
      eyebrow="Prototype"
      step="1 of 6"
      title="Press P. The board becomes the product."
      lead={
        <>
          The five phones to the right are one ride flow - a file each, wired to the next
          with <Ink>data-goto</Ink>. Select the white one and press <Ink>p</Ink>, or hit{' '}
          <Ink>play</Ink> in the toolbar: the design goes full screen inside a device and
          taps navigate it. <Ink>A prototype nobody had to build.</Ink>
        </>
      }
      hint={
        <>
          Start on <Ink>Start here</Ink>, the white frame beside this one.{' '}
          <Kbd className="mx-1">Esc</Kbd> drops you back on the board.
        </>
      }
    >
      <div className="grid max-w-[1140px] grid-cols-3 gap-4">
        <Move
          keys={
            <span className="inline-flex items-center gap-1.5">
              <Kbd>p</Kbd>
              <span className="text-[12px] text-muted-soft">or</span>
              <span className="inline-flex h-[26px] items-center gap-1 rounded-[7px] border border-border bg-surface-2 px-2 text-[12.5px] font-semibold">
                <PlayGlyph className="size-[9px] text-brand" />
                play
              </span>
            </span>
          }
          action="Start it."
          demo={Enter}
          wide
        >
          No double-click needed. The board falls away and the frame runs.
        </Move>
        <Move
          keys={<span className="text-[12.5px] font-semibold tracking-[0.04em] text-brand uppercase">tap through</span>}
          action="Every tap goes somewhere."
          demo={Flow}
          wide
        >
          Search, pick a ride, meet the driver, ride it. Five screens, one graph - dead ends show up immediately.
        </Move>
        <Move
          keys={
            <span className="inline-flex items-center gap-1">
              <Kbd>1</Kbd>
              <span className="text-[12px] text-muted-soft">–</span>
              <Kbd>4</Kbd>
            </span>
          }
          action="Flip the device under it."
          demo={Devices}
          wide
        >
          Phone stacks the sheet under the map; laptop docks it beside a full-bleed one. Same frame, laid out for the screen it landed on.
        </Move>
      </div>
    </Slide>
  )
}
