import type { ReactNode } from 'react'
import { Cursor, DemoNode, Ink, Kbd, Move, Slide, Tag, cn } from '../../../src/components/kit'

export const meta = { title: 'Play mode', viewport: 'laptop' }

/**
 * Four moves, four drawn demos - each swatch shows the canvas doing the thing
 * rather than describing it. Play mode's own colour is the purple interact ring
 * the shell paints on a live frame, so every picture here carries it.
 */

/** The ride screen, at device scale - a design without being a design. */
function Ride({ tapped }: { tapped?: boolean }) {
  return (
    <div className="flex h-full flex-col p-1.5">
      <div className="h-[38%] rounded-[4px] bg-muted" />
      <div className="mt-1.5 space-y-[3px]">
        <span className="block h-[4px] w-[68%] rounded-full bg-foreground/70" />
        <span className="block h-[3px] w-[46%] rounded-full bg-muted-foreground/30" />
      </div>
      <div
        className={cn(
          'mt-auto h-[11px] rounded-full bg-brand',
          tapped && 'ring-[3px] ring-brand/30',
        )}
      />
    </div>
  )
}

/** A phone as play mode draws it: rounded slab, live ring, screen inside. */
function Phone({
  w = 62, h = 116, live, className, children,
}: {
  w?: number
  h?: number
  live?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      style={{ width: w, height: h }}
      className={cn(
        'shrink-0 overflow-hidden rounded-[11px] border bg-(--node-bg)',
        live
          ? 'border-interact shadow-[0_0_0_3px_rgba(219,53,242,0.18),var(--shadow-lift)]'
          : 'border-(--node-brd) shadow-(--shadow-node)',
        className,
      )}
    >
      {children ?? <Ride />}
    </div>
  )
}

/* ── The four swatches ────────────────────────────────────────────────────── */

/** p - the board dims, one frame comes up full screen in a device, and it taps. */
const Enter = (
  <>
    <DemoNode w={78} h={48} className="absolute top-4 -left-6 opacity-40" />
    <DemoNode w={70} h={44} className="absolute right-[-14px] bottom-5 opacity-40" />
    <div className="absolute inset-0 bg-background/72" />
    <div className="absolute inset-0 flex items-center justify-center">
      <Phone live>
        <Ride tapped />
      </Phone>
    </div>
    <Cursor className="bottom-[22px] left-[142px] w-[18px]" />
  </>
)

/** Three sibling directions of one screen, side by side - B is the one on screen. */
const VARIANTS: { letter: string; screen: ReactNode }[] = [
  {
    letter: 'A',
    screen: (
      <div className="flex h-full flex-col p-1.5">
        <div className="h-[34%] rounded-[4px] bg-muted" />
        <span className="mt-1.5 block h-[4px] w-[70%] rounded-full bg-foreground/70" />
        <span className="mt-1 block h-[3px] w-[44%] rounded-full bg-muted-foreground/30" />
        <div className="mt-auto h-[10px] rounded-full bg-brand" />
      </div>
    ),
  },
  {
    letter: 'B',
    screen: (
      <div className="flex h-full flex-col p-1.5">
        <span className="block h-[5px] w-[52%] rounded-full bg-foreground/70" />
        <div className="mt-1.5 flex-1 rounded-[4px] bg-muted" />
        <div className="mt-1.5 h-[10px] rounded-full bg-brand" />
      </div>
    ),
  },
  {
    letter: 'C',
    screen: (
      <div className="flex h-full flex-col gap-[3px] p-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-1 rounded-[3px] bg-muted p-1">
            <span className="size-[6px] shrink-0 rounded-full bg-muted-foreground/30" />
            <span className="block h-[3px] w-[60%] rounded-full bg-foreground/50" />
          </div>
        ))}
        <div className="mt-auto h-[10px] rounded-full bg-brand" />
      </div>
    ),
  },
]

/** [ ] - sibling directions of one screen, swapping inside the same device. */
const Variants = (
  <>
    <div className="flex h-full items-center justify-center gap-3">
      {VARIANTS.map(({ letter, screen }) => {
        const live = letter === 'B'
        return (
          <div key={letter} className="flex flex-col items-center gap-2">
            <Phone w={52} h={94} live={live} className={cn(!live && 'opacity-45')}>
              {screen}
            </Phone>
            <span
              className={cn(
                'text-[10px] font-bold',
                live ? 'text-interact-ink' : 'text-muted-soft',
              )}
            >
              {letter}
            </span>
          </div>
        )
      })}
    </div>
    <Tag className="top-1/2 left-3 -translate-y-1/2">[</Tag>
    <Tag className="top-1/2 right-3 -translate-y-1/2">]</Tag>
  </>
)

/** 1 - the device changes around the prototype; it keeps running. */
const Devices = (
  <div className="flex h-full items-center justify-center gap-4">
    <div className="flex flex-col items-center gap-2">
      <Phone w={40} h={76} live />
      <span className="text-[10px] font-bold text-interact-ink">1</span>
    </div>
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-col items-center">
        <div className="h-[68px] w-[112px] overflow-hidden rounded-[8px] border border-interact bg-(--node-bg) shadow-[0_0_0_3px_rgba(219,53,242,0.18)]">
          <div className="flex h-full gap-1.5 p-2">
            <div className="w-[42%] rounded-[3px] bg-muted" />
            <div className="flex flex-1 flex-col">
              <span className="block h-[4px] w-[80%] rounded-full bg-foreground/70" />
              <span className="mt-1 block h-[3px] w-[56%] rounded-full bg-muted-foreground/30" />
              <div className="mt-auto h-[10px] w-[38px] rounded-full bg-brand" />
            </div>
          </div>
        </div>
        <span className="h-[3px] w-[132px] rounded-b-[3px] bg-(--node-brd)" />
      </div>
      <span className="text-[10px] font-bold text-muted-soft">3</span>
    </div>
  </div>
)

/** esc - the full-screen device folds back down into its node on the board. */
const Exit = (
  <>
    <div className="absolute inset-0 flex items-center justify-center">
      <DemoNode w={92} h={58} state="selected" />
    </div>
    <div className="absolute inset-[10px] rounded-[10px] border-2 border-dashed border-muted-foreground/30" />
    {[
      'top-[18px] left-[18px] rotate-[135deg]',
      'top-[18px] right-[18px] -rotate-[135deg]',
      'bottom-[18px] left-[18px] rotate-45',
      'bottom-[18px] right-[18px] -rotate-45',
    ].map((pos) => (
      <svg
        key={pos}
        viewBox="0 0 16 16"
        className={cn('absolute size-3 text-muted-foreground/50', pos)}
        fill="none"
        aria-hidden
      >
        <path d="M8 2v12m0 0-4-4m4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ))}
    <Tag className="right-2.5 bottom-2.5">Esc</Tag>
  </>
)

export default function Play() {
  return (
    <Slide
      eyebrow="The modes"
      step="1 of 2"
      title="Press play. It behaves like the app."
      lead={
        <>
          Put <Ink>data-goto</Ink> on any element and it points at another frame. Select a
          frame and press <Ink>p</Ink>: the design goes full screen inside a device, and
          tapping through it navigates like the shipped product.{' '}
          <Ink>A prototype no one had to build.</Ink>
        </>
      }
      hint={<>The <Ink>prototype</Ink> board is a whole ride flow, wired up - that is where you drive it.</>}
    >
      <div className="grid grid-cols-4 gap-4">
        <Move combo="p" action="Enter play mode." demo={Enter}>
          The board falls away. Taps follow <Ink>data-goto</Ink>, screen to screen.
        </Move>
        <Move
          keys={
            <span className="inline-flex items-center gap-1">
              <Kbd>[</Kbd>
              <Kbd>]</Kbd>
            </span>
          }
          action="Flip variants in place."
          demo={Variants}
        >
          Sibling directions of the same screen swap live. Try it on a recipe phone.
        </Move>
        <Move combo="1" action="Devices still work." demo={Devices}>
          Digits switch the device around the running prototype, full-screen fill included.
        </Move>
        <Move combo="esc" action="Step back out." demo={Exit}>
          Out of play, out of any mode - the frame folds back onto the board.
        </Move>
      </div>
    </Slide>
  )
}
