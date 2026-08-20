import type { ReactNode } from 'react'
import { Ink, Keys, Slide, cn } from '../../../src/components/kit'

export const meta = { title: 'Drive it', viewport: 'laptop' }

/**
 * Five moves, each drawn instead of described: the card shows the canvas doing
 * the thing, the chip and the line underneath only name it. Every swatch sits on
 * the real dot grid at the shell's own measurements (10px node radius, brand
 * selection ring, purple interact ring) so the picture matches what happens when
 * the human tries the move on this very frame.
 */

/* ── The vocabulary these five swatches share ─────────────────────────────── */

/** The mouse pointer, drawn once - tip at the top-left, outlined so it reads on any ground. */
function Cursor({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={cn('absolute', className)} aria-hidden>
      <path
        d="M56 24 L56 196 L98 158 L124 220 L152 208 L126 148 L182 146 Z"
        fill="var(--foreground)"
        stroke="var(--background)"
        strokeWidth={14}
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Abstract page content - a design without being a design. */
function Bars({ tight }: { tight?: boolean }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1">
        <span className="size-[3px] rounded-full bg-brand" />
        <span className="h-[2px] w-[26%] rounded-full bg-brand/50" />
      </div>
      <div className={cn('space-y-[3px]', tight ? 'mt-1.5' : 'mt-2')}>
        <span className="block h-[4px] w-[70%] rounded-full bg-foreground/70" />
        <span className="block h-[4px] w-[44%] rounded-full bg-foreground/70" />
      </div>
      <div className="mt-auto h-[26%] rounded-[3px] bg-muted" />
    </div>
  )
}

/** A frame node as the canvas draws it: name above, card below, state ring. */
function Node({
  w, h, state, children, className,
}: {
  w: number
  h: number
  state?: 'selected' | 'interact'
  children?: ReactNode
  className?: string
}) {
  return (
    <div style={{ width: w }} className={cn('shrink-0', className)}>
      <div
        className={cn(
          'mb-[5px] h-[3px] rounded-full',
          state === 'selected' ? 'w-[58%] bg-brand' : state === 'interact' ? 'w-[58%] bg-interact' : 'w-[42%] bg-muted-foreground/35',
        )}
      />
      <div
        style={{ height: h }}
        className={cn(
          'rounded-[10px] border bg-(--node-bg) p-2 shadow-(--shadow-node)',
          state === 'selected' && 'border-brand outline-2 outline-brand -outline-offset-1 shadow-[0_0_0_3px_var(--brand-ring)]',
          state === 'interact' && 'border-interact outline-2 outline-interact -outline-offset-1 shadow-[0_0_0_3px_rgba(219,53,242,0.18)]',
          !state && 'border-(--node-brd)',
        )}
      >
        {children ?? <Bars />}
      </div>
    </div>
  )
}

/** A small floating key, for keys the swatch itself has to name. */
function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'absolute rounded-[6px] border border-border bg-surface px-1.5 py-px text-[10px] font-semibold text-foreground shadow-(--shadow-node)',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** One move: the picture carries it, the chip and the line name it. */
function Move({
  combo, action, children, demo,
}: {
  combo: string
  action: string
  children: ReactNode
  demo: ReactNode
}) {
  return (
    <div className="flex flex-col rounded-card border border-border bg-surface-2 p-3">
      <div className="canvas-ground relative h-[142px] overflow-hidden rounded-[12px] border border-border">
        {demo}
      </div>
      <div className="mt-3.5 px-1">
        <Keys combo={combo} />
        <h2 className="mt-2 text-[14.5px] font-semibold tracking-[-0.01em]">{action}</h2>
        <p className="mt-1 pb-0.5 text-[13px] leading-[1.45] text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

/* ── The five swatches ────────────────────────────────────────────────────── */

/** click - one frame picked out of two, brand ring, pointer on it. */
const Select = (
  <>
    <div className="flex h-full items-center justify-center gap-3.5">
      <Node w={70} h={54} state="selected" />
      <Node w={70} h={54} />
    </div>
    <Cursor className="top-[76px] left-[62px] w-[19px]" />
  </>
)

const DEVICES = [
  { n: '1', w: 18, h: 34, on: true },
  { n: '2', w: 30, h: 40 },
  { n: '3', w: 48, h: 32 },
  { n: '4', w: 58, h: 38 },
]

/** 1 - the same frame, four sizes, the pressed digit lit. */
const Devices = (
  <div className="flex h-full items-end justify-center gap-2 pb-6">
    {DEVICES.map((d) => (
      <div key={d.n} className="flex flex-col items-center gap-1.5">
        <div
          style={{ width: d.w, height: d.h }}
          className={cn(
            'rounded-[5px] border bg-(--node-bg)',
            d.on
              ? 'border-brand shadow-[0_0_0_3px_var(--brand-ring),var(--shadow-node)]'
              : 'border-(--node-brd) shadow-(--shadow-node)',
          )}
        />
        <span className={cn('text-[10px] font-bold', d.on ? 'text-brand' : 'text-muted-soft')}>{d.n}</span>
      </div>
    ))}
  </div>
)

/* Both themes at once, so the values are hardcoded from theme.css rather than
   read from tokens - a token would flip with the frame and kill the split. */
const L = { bg: '#ffffff', brd: '#dddee5', ink: 'rgba(24,24,27,0.72)', mut: '#eeeff4', soft: 'rgba(92,94,107,0.3)' }
const D = { bg: '#0f1015', brd: '#2c2d38', ink: 'rgba(236,236,241,0.75)', mut: '#22232c', soft: 'rgba(159,160,172,0.3)' }

function ThemeHalf({ t, icon }: { t: typeof L; icon: ReactNode }) {
  return (
    <div className="relative flex-1 p-2.5" style={{ background: t.bg }}>
      <div className="absolute top-2 right-2 opacity-45" style={{ color: t.ink }}>{icon}</div>
      <div className="flex items-center gap-1">
        <span className="size-[3px] rounded-full bg-brand" />
        <span className="h-[2px] w-[30%] rounded-full bg-brand/50" />
      </div>
      <div className="mt-2 space-y-[3px]">
        <span className="block h-[4px] w-[62%] rounded-full" style={{ background: t.ink }} />
        <span className="block h-[4px] w-[38%] rounded-full" style={{ background: t.ink }} />
      </div>
      <div className="mt-2 space-y-[3px]">
        <span className="block h-[2px] w-[80%] rounded-full" style={{ background: t.soft }} />
        <span className="block h-[2px] w-[64%] rounded-full" style={{ background: t.soft }} />
      </div>
      <div className="mt-2.5 h-[16px] rounded-[3px]" style={{ background: t.mut }} />
    </div>
  )
}

const Sun = (
  <svg viewBox="0 0 256 256" width="11" height="11" fill="currentColor" aria-hidden>
    <path d="M120,40V16a8,8,0,0,1,16,0V40a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-16-16A8,8,0,0,0,42.34,53.66Zm0,116.68-16,16a8,8,0,0,0,11.32,11.32l16-16a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l16-16a8,8,0,0,0-11.32-11.32l-16,16A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l16,16a8,8,0,0,0,11.32-11.32ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Zm80,80a8,8,0,0,0-8,8v24a8,8,0,0,0,16,0V216A8,8,0,0,0,128,208Zm112-88H216a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16Z" />
  </svg>
)

const Moon = (
  <svg viewBox="0 0 256 256" width="11" height="11" fill="currentColor" aria-hidden>
    <path d="M233.54,142.23a8,8,0,0,0-8-2,88.08,88.08,0,0,1-109.8-109.8,8,8,0,0,0-10-10,104.84,104.84,0,0,0-52.91,37A104,104,0,0,0,136,224a103.09,103.09,0,0,0,62.52-20.88,104.84,104.84,0,0,0,37-52.91A8,8,0,0,0,233.54,142.23ZM188.9,190.34A88,88,0,0,1,65.66,67.11a89,89,0,0,1,31.4-26A106,106,0,0,0,96,56,104.11,104.11,0,0,0,200,160a106,106,0,0,0,14.92-1.06A89,89,0,0,1,188.9,190.34Z" />
  </svg>
)

/** d - one frame, both themes, split down the middle. */
const Theme = (
  <div className="flex h-full items-center justify-center">
    <div className="flex w-[142px] overflow-hidden rounded-[10px] border border-(--node-brd) shadow-(--shadow-node)">
      <ThemeHalf t={L} icon={Sun} />
      <ThemeHalf t={D} icon={Moon} />
    </div>
  </div>
)

/** dblclick - the frame goes live: purple ring, a real button, Esc to leave. */
const Live = (
  <>
    <div className="flex h-full items-center justify-center">
      <Node w={112} h={72} state="interact">
        <div className="flex h-full flex-col">
          <div className="space-y-[3px]">
            <span className="block h-[4px] w-[64%] rounded-full bg-foreground/70" />
            <span className="block h-[3px] w-[86%] rounded-full bg-muted-foreground/30" />
          </div>
          <div className="mt-auto h-[15px] w-[52px] rounded-full bg-brand" />
        </div>
      </Node>
    </div>
    <span className="absolute top-[80px] left-[54px] size-[24px] rounded-full border-2 border-interact/55" />
    <span className="absolute top-[71px] left-[45px] size-[42px] rounded-full border border-interact/25" />
    <Cursor className="top-[84px] left-[60px] w-[19px]" />
    <Tag className="right-2 bottom-2">Esc</Tag>
  </>
)

/** scroll - the board runs past the edges, and the viewport is a zoom level. */
const Zoom = (
  <>
    <Node w={104} h={62} className="absolute top-[30px] -left-7" />
    <Node w={86} h={52} className="absolute top-[62px] left-[126px] opacity-45" />
    <Node w={70} h={40} className="absolute -top-1 left-[104px] opacity-30" />
    <div className="absolute inset-[13px] rounded-[10px] border-2 border-dashed border-brand/50" />
    <span className="glass absolute right-3.5 bottom-3.5 rounded-full px-2 py-[3px] text-[10px] font-semibold tnum">
      62%
    </span>
  </>
)

export default function DriveIt() {
  return (
    <Slide
      eyebrow="Welcome"
      step="2 of 5"
      title="You already know how to drive this."
      lead={
        <>
          Five moves cover the whole canvas. <Ink>Try each one on this very frame</Ink> -
          nothing you do as a viewer can break anything.
        </>
      }
      hint={<>Done playing? The next frame explains why any of this matters.</>}
    >
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Move combo="click" action="Select a frame." demo={Select}>
          Shift-click adds more. Click the ground to clear.
        </Move>
        <Move combo="1" action="Switch device." demo={Devices}>
          Digits 1 to 4 preview phone, tablet, laptop, monitor. <Ink>0</Ink> restores each
          frame's own size.
        </Move>
        <Move combo="d" action="Flip the theme." demo={Theme}>
          Both are real - the same components, the same tokens, no second set of designs.
        </Move>
        <Move combo="dblclick" action="Touch a frame." demo={Live}>
          The frame goes live: clickable, scrollable. <Ink>Esc</Ink> steps back out.
        </Move>
        <Move combo="scroll" action="Glide and zoom." demo={Zoom}>
          Scroll to pan, pinch or ⌘-scroll to zoom. The canvas is big on purpose.
        </Move>
      </div>
    </Slide>
  )
}
