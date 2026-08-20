import type { ReactNode } from 'react'
import { Ink, Keys, Slide, Tag, cn } from '../../../src/components/kit'

export const meta = { title: 'What variants are', viewport: 'laptop' }

/**
 * The caption for the three recipe phones on its right, and the frame that has
 * to make one point land: you are looking at ONE screen designed three ways,
 * parked side by side so the choice is a look rather than a memory.
 *
 * So the demonstration is the comparison itself - three honest miniatures of
 * a-classic, b-editorial and c-brutalist, close enough to read as one object.
 * The naming rule is the caption underneath, not the headline act.
 */

/** A phone-shaped miniature, badged the way the canvas badges a variant. */
function Mini({
  badge, file, live, children,
}: {
  badge: string
  file: string
  live?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex w-[108px] shrink-0 flex-col gap-2 sm:w-[132px]">
      <div className="flex items-center gap-1.5 px-0.5">
        <span
          className={cn(
            'inline-flex size-[17px] items-center justify-center rounded-[5px] text-[10.5px] font-bold',
            live ? 'bg-brand text-white' : 'bg-muted text-muted-foreground',
          )}
        >
          {badge}
        </span>
        <span className={cn('truncate font-mono text-[10.5px]', live ? 'text-brand' : 'text-muted-soft')}>
          {file}
        </span>
      </div>
      <div
        className={cn(
          'h-[164px] overflow-hidden rounded-[10px] border bg-(--node-bg) sm:h-[196px]',
          live
            ? 'border-brand shadow-[0_0_0_3px_var(--brand-ring),var(--shadow-node)]'
            : 'border-(--node-brd) shadow-(--shadow-node)',
        )}
      >
        {children}
      </div>
    </div>
  )
}

/* ── The three directions, reduced to what the eye actually sorts them by ─── */

/** A: photo on top, soft cards under it, warm accent. */
const Classic = (
  <div className="flex h-full flex-col">
    <div className="relative h-[44%] shrink-0 bg-[radial-gradient(120%_95%_at_26%_8%,#54483a,#2f2a22_48%,#14120f)]">
      <span className="absolute top-1/2 left-1/2 size-[48px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_34%_26%,#fffdf8,#efe9dc_52%,#c3b184)] sm:size-[58px]" />
    </div>
    <div className="flex flex-1 flex-col gap-[7px] p-2.5">
      <span className="block h-[7px] w-[76%] rounded-full bg-foreground/75" />
      <div className="flex gap-1">
        {[26, 32, 24].map((w) => (
          <span key={w} style={{ width: w }} className="block h-[9px] rounded-full bg-muted" />
        ))}
      </div>
      <span className="mt-0.5 block h-[3px] w-full rounded-full bg-muted-foreground/25" />
      <span className="block h-[3px] w-[82%] rounded-full bg-muted-foreground/25" />
      <div className="mt-auto h-[13px] rounded-full bg-[#c8792f]" />
    </div>
  </div>
)

/** B: masthead rule, serif headline, drop cap, one engraved band. */
const Editorial = (
  <div className="flex h-full flex-col px-2.5 pt-3 pb-2.5">
    <div className="flex items-center justify-between border-b border-foreground/70 pb-1.5">
      <span className="block h-[3px] w-[38px] rounded-full bg-foreground/70" />
      <span className="block h-[3px] w-[22px] rounded-full bg-muted-foreground/40" />
    </div>
    <p
      className="mt-3 text-[16px] leading-[0.94] tracking-[-0.015em] text-foreground sm:text-[19px]"
      style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
    >
      Charred
      <br />
      <em className="font-normal italic">leek</em>
    </p>
    <div className="mt-2.5 flex gap-1.5">
      <span
        className="text-[16px] leading-[0.72] font-semibold text-foreground sm:text-[19px]"
        style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
      >
        L
      </span>
      <div className="mt-0.5 flex-1 space-y-[3px]">
        <span className="block h-[2.5px] w-full rounded-full bg-muted-foreground/30" />
        <span className="block h-[2.5px] w-full rounded-full bg-muted-foreground/30" />
        <span className="block h-[2.5px] w-[64%] rounded-full bg-muted-foreground/30" />
      </div>
    </div>
    <div className="relative mt-auto h-[40px] shrink-0 overflow-hidden bg-[radial-gradient(120%_180%_at_30%_10%,#4c4437,#1a1712)] sm:h-[46px]">
      <span className="absolute top-1/2 left-1/2 size-[32px] -translate-x-1/2 -translate-y-[46%] rounded-full bg-[radial-gradient(circle_at_38%_30%,#f3ecdc,#d9cdb0_58%,#a89b7e)] sm:size-[38px]" />
    </div>
  </div>
)

/** C: yellow ground, hard black rules, mono, a number that shouts. */
const Brutalist = (
  <div className="flex h-full flex-col bg-[#f2f000] font-mono text-black">
    <div className="flex items-center justify-between border-b-[3px] border-black px-2 py-1.5 text-[7px] font-bold tracking-[0.1em]">
      <span>RCP-014</span>
      <span>DINNER</span>
    </div>
    <div className="flex border-b-[3px] border-black">
      <p className="flex-1 px-2 py-2.5 text-[13px] leading-[0.94] font-bold tracking-[-0.03em] uppercase sm:text-[15px]">
        Charred
        <br />
        leek
      </p>
      <span className="grid w-[28px] place-items-center border-l-[3px] border-black bg-black text-[16px] leading-none font-bold text-[#f2f000] sm:w-[34px] sm:text-[19px]">
        14
      </span>
    </div>
    <div className="grid grid-cols-3 border-b-[3px] border-black text-center text-[7px] font-bold">
      {['35', '2', 'MED'].map((n, i) => (
        <span key={n} className={cn('py-1.5 text-[12px] leading-none', i < 2 && 'border-r-[3px] border-black')}>
          {n}
        </span>
      ))}
    </div>
    <div className="flex-1 space-y-[5px] p-2">
      {[100, 74, 88].map((w, i) => (
        <span key={i} style={{ width: `${w}%` }} className="block h-[4px] bg-black/80" />
      ))}
    </div>
  </div>
)

export default function WhatVariantsAre() {
  return (
    <Slide
      eyebrow="The canvas"
      title="One screen, three directions, side by side."
      lead={
        <>
          The phones to the right are the same recipe screen designed three ways: photo-led,
          editorial, and loud. Name sibling files <Ink>a-</Ink>, <Ink>b-</Ink>, <Ink>c-</Ink>{' '}
          and the canvas treats them as <Ink>one variant group</Ink> - parked shoulder to
          shoulder through every tidy, badged A, B, C, and folded into a single row in the
          sidebar.
        </>
      }
      hint={
        <>
          <Keys combo="[" className="mr-1.5" />
          <Keys combo="]" className="mr-2" /> swap directions in place in play mode: same
          device, same position, only the design changes.
        </>
      }
    >
      <div className="flex flex-col items-start gap-7 lg:flex-row lg:items-end">
        {/* the comparison itself - one group, three takes, close enough to read together */}
        <div className="relative w-full max-w-[520px] shrink-0 rounded-[16px] border border-dashed border-brand/45 bg-brand-wash p-4">
          <div className="-mx-1 flex flex-nowrap items-end gap-2.5 overflow-x-auto px-1 pb-1 sm:gap-3.5">
            <Mini badge="A" file="a-classic" live>
              {Classic}
            </Mini>
            <Mini badge="B" file="b-editorial">
              {Editorial}
            </Mini>
            <Mini badge="C" file="c-brutalist">
              {Brutalist}
            </Mini>
          </div>
          <Tag className="top-1/2 -left-2.5 hidden -translate-y-1/2 lg:block">[</Tag>
          <Tag className="top-1/2 -right-2.5 hidden -translate-y-1/2 lg:block">]</Tag>
        </div>

        {/* what the naming buys, in the fewest words that still say it */}
        <div className="flex min-w-0 flex-col gap-4 pb-1">
          <div className="overflow-hidden rounded-card border border-border bg-surface-2">
            <div className="border-b border-border px-4 py-2 font-mono text-[11.5px] font-medium text-muted-soft">
              design/scenes/recipe/
            </div>
            <div className="space-y-1 px-4 py-3 font-mono text-[12px] text-foreground/85">
              <p>a-classic.tsx</p>
              <p>b-editorial.tsx</p>
              <p>c-brutalist.tsx</p>
            </div>
          </div>
          <p className="max-w-[300px] text-[13.5px] leading-[1.5] text-muted-foreground">
            A fourth letter adds a fourth direction. Delete the ones that lost and the group
            becomes an ordinary frame again.
          </p>
        </div>
      </div>
    </Slide>
  )
}
