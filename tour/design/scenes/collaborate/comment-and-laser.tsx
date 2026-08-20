import type { ReactNode } from 'react'
import { Face, Ink, Move, Slide, cn } from '../../../src/components/kit'

export const meta = { title: 'Comments + laser', viewport: 'laptop' }

/**
 * Four keys, four drawn demos. The highlights are the real ones: marver tints an
 * element by its DEPTH in the tree - hue 0, 60, 120... one step per level - and
 * paints a 2px outline, a 10% fill and a soft ring. Same numbers here, so the
 * swatch matches what the human sees the moment they press l.
 */

/** The depth-hue highlight, exactly as the frame host paints it. */
function Hue({ h, className, children }: { h: number; className?: string; children?: ReactNode }) {
  return (
    <div
      className={cn('rounded-[3px]', className)}
      style={{
        outline: `2px solid hsl(${h} 95% 45%)`,
        outlineOffset: -2,
        backgroundColor: `hsl(${h} 95% 50% / 0.10)`,
        boxShadow: `0 0 0 3px hsl(${h} 95% 50% / 0.32)`,
      }}
    >
      {children}
    </div>
  )
}

/** The laser reticle - the crosshair cursor the shell swaps in, drawn to scale. */
function Reticle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={cn('absolute w-[22px]', className)} aria-hidden>
      <g stroke="#fff" strokeWidth={46} fill="none">
        <circle cx="128" cy="128" r="56" />
        <path d="M128 24V56M128 200v32M24 128h32M200 128h32" strokeLinecap="round" />
      </g>
      <g stroke="#0088ff" strokeWidth={20} fill="none">
        <circle cx="128" cy="128" r="56" />
        <path d="M128 24V56M128 200v32M24 128h32M200 128h32" strokeLinecap="round" />
      </g>
      <circle cx="128" cy="128" r="16" fill="#0088ff" stroke="#fff" strokeWidth={8} />
    </svg>
  )
}

/** A comment pin as the canvas drops one: a disc with a tail, in the thread's hue. */
function Pin({ initial = 'A', ghost, className }: { initial?: string; ghost?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'absolute flex size-[18px] items-center justify-center rounded-full rounded-bl-[3px] text-[9px] font-bold',
        ghost
          ? 'border border-dashed border-muted-foreground/40 text-transparent'
          : 'bg-comment text-white shadow-(--shadow-node)',
        className,
      )}
    >
      {initial}
    </span>
  )
}

/** The little card a swatch stands on - a frame reduced to a few elements. */
function Card({ w = 124, children }: { w?: number; children: ReactNode }) {
  return (
    <div
      style={{ width: w }}
      className="rounded-[10px] border border-(--node-brd) bg-(--node-bg) p-2.5 shadow-(--shadow-node)"
    >
      {children}
    </div>
  )
}

/** Plain rows for the cards that are not being pointed at. */
const Rows = () => (
  <>
    <span className="block h-[4px] w-[62%] rounded-full bg-foreground/70" />
    <span className="mt-[5px] block h-[3px] w-[84%] rounded-full bg-muted-foreground/30" />
  </>
)

/* ── The four swatches ────────────────────────────────────────────────────── */

/** c - click any element and the pin holds a thread to it. */
const Comment = (
  <div className="flex h-full items-center justify-center">
    <div className="relative">
      <Card>
        <Rows />
        <Hue h={120} className="mt-2.5 flex items-center justify-between px-1.5 py-1">
          <span className="block h-[4px] w-[28px] rounded-full bg-foreground/70" />
          <span className="block h-[9px] w-[26px] rounded-full bg-brand" />
        </Hue>
      </Card>
      <Pin initial="A" className="-right-2 -bottom-2" />
    </div>
  </div>
)

/** shift+c - the pins step aside; the design is clean again. */
const Hidden = (
  <div className="flex h-full items-center justify-center">
    <div className="relative">
      <Card>
        <Rows />
        <div className="mt-2.5 flex items-center justify-between rounded-[3px] px-1.5 py-1">
          <span className="block h-[4px] w-[28px] rounded-full bg-foreground/70" />
          <span className="block h-[9px] w-[26px] rounded-full bg-brand" />
        </div>
      </Card>
      <Pin ghost className="-right-2 -bottom-2" />
      <Pin ghost className="-top-2 left-3" />
    </div>
  </div>
)

/** l - point, and the element lights up in its own depth hue. */
const Laser = (
  <div className="flex h-full items-center justify-center">
    <div className="relative">
      <Hue h={0} className="p-2">
        <Hue h={60} className="p-2">
          <Hue h={120} className="flex items-center gap-2 px-2 py-1.5">
            <span className="block h-[4px] w-[34px] rounded-full bg-foreground/70" />
            <span className="block h-[10px] w-[28px] rounded-full bg-brand" />
          </Hue>
        </Hue>
      </Hue>
      <Reticle className="-right-3 -bottom-3" />
    </div>
  </div>
)

/** shift+l - every thread paints its anchor, so you see what the words mean. */
const LaserComments = (
  <div className="flex h-full items-center justify-center gap-3">
    <div className="relative">
      <Card w={104}>
        <Rows />
        <Hue h={120} className="mt-2.5 h-[14px]" />
      </Card>
      <Pin initial="A" className="right-1.5 -bottom-2" />
    </div>
    <svg viewBox="0 0 24 12" className="w-5 shrink-0 text-comment" fill="none" aria-hidden>
      <path d="M1 6h20m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <div className="w-[104px] rounded-[8px] border border-border bg-card p-2 shadow-(--shadow-node)">
      <div className="flex items-center gap-1.5">
        <span className="size-[13px] rounded-full bg-comment" />
        <span className="block h-[3px] w-[30px] rounded-full bg-foreground/60" />
      </div>
      <span className="mt-1.5 block h-[3px] w-[86%] rounded-full bg-muted-foreground/30" />
      <span className="mt-[4px] block h-[3px] w-[60%] rounded-full bg-muted-foreground/30" />
    </div>
  </div>
)

export default function CommentAndLaser() {
  return (
    <Slide
      eyebrow="Collaborate"
      step="1 of 4"
      title="The canvas is where feedback lives."
      lead={
        <>
          Drop a pin on the exact element and the thread stays anchored to it - design review
          without screenshots. <Ink>This tour is read-only for guests</Ink>, so here it is as a
          preview; on your own canvas the loop is live and your agent reads every thread.
        </>
      }
      hint={<>The rest of this board: publish the canvas, invite the team, and watch a thread become work.</>}
    >
      <div className="flex items-center gap-7">
        {/* a thread, as the canvas draws one */}
        <div className="w-[340px] shrink-0 rounded-panel border border-border bg-card p-5 shadow-(--shadow-lift)">
          <div className="flex items-start gap-3">
            <Face name="A" hue="#ff9500" />
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold">Aeliana <span className="ml-1 font-normal text-muted-soft">2:14 pm</span></p>
              <p className="mt-1 text-[14px] leading-[1.5] text-foreground/85">
                The fare feels buried - can it lead the row?
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-start gap-3">
            <Face name="N" hue="#34c759" />
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold">Nic <span className="ml-1 font-normal text-muted-soft">2:31 pm</span></p>
              <p className="mt-1 text-[14px] leading-[1.5] text-foreground/85">
                Agreed. <span className="font-semibold text-brand-ink">@marver</span> make the
                price the biggest number on the card.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-full border border-border bg-surface-2 px-4 py-2.5">
            <span className="text-[13.5px] text-muted-soft">Reply…</span>
          </div>
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-3.5">
          <Move combo="c" action="Comment mode." demo={Comment} stageH={84}>
            Click an element; the pin holds the thread.
          </Move>
          <Move combo="shift+c" action="Hide the pins." demo={Hidden} stageH={84}>
            Threads stay; the design gets its frame back.
          </Move>
          <Move combo="l" action="Laser mode." demo={Laser} stageH={84}>
            Point at exact elements, tinted by depth.
          </Move>
          <Move combo="shift+l" action="Laser comments." demo={LaserComments} stageH={84}>
            Each thread paints the element it names.
          </Move>
        </div>
      </div>
    </Slide>
  )
}
