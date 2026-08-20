import { Ink, Keys, MiniBar, MiniBlock, MiniFrame, Slide } from '../../../src/components/kit'

export const meta = { title: 'What variants are', viewport: 'laptop' }

const FILES = [
  { name: 'a-classic.tsx', letter: 'A', label: 'soft cards, warm accent' },
  { name: 'b-editorial.tsx', letter: 'B', label: 'type-led, quiet chrome' },
  { name: 'c-brutalist.tsx', letter: 'C', label: 'hard edges, loud ink' },
]

/** The caption for the three phones on its right: why they are letter-prefixed. */
export default function WhatVariantsAre() {
  return (
    <Slide
      eyebrow="The canvas"
      title="Letter the file, get a variant."
      lead={
        <>
          Sibling frames that start with <Ink>a-</Ink>, <Ink>b-</Ink>, <Ink>c-</Ink> are one
          screen explored three ways - so the canvas keeps them together, badges them A/B/C,
          and collapses them into a single row in the rail. Exploring a direction is naming a
          file, not forking a branch.
        </>
      }
      hint={
        <>
          <Keys combo="[" className="mr-1.5" />
          <Keys combo="]" className="mr-2" /> swap versions in place in play mode - the three
          phones to the right are exactly this.
        </>
      }
    >
      <div className="flex flex-col items-start gap-8 xl:flex-row xl:items-center">
        {/* The files */}
        <div className="w-full max-w-[430px] shrink-0 overflow-hidden rounded-card border border-border bg-surface-2">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="size-2.5 rounded-full bg-muted-foreground/30" />
            <span className="font-mono text-[12px] font-medium text-muted-foreground">design/scenes/recipe/</span>
          </div>
          <div className="px-4 py-3">
            {FILES.map((f) => (
              <div key={f.name} className="flex items-baseline gap-3 py-1.5">
                <span className="inline-flex size-[18px] shrink-0 translate-y-[3px] items-center justify-center rounded-[5px] bg-brand text-[11px] font-bold text-white">
                  {f.letter}
                </span>
                <span className="font-mono text-[12.5px] text-foreground/85">{f.name}</span>
                <span className="ml-auto text-[12px] text-muted-soft">{f.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Becomes one group */}
        <svg viewBox="0 0 48 24" className="hidden w-12 shrink-0 text-brand xl:block" fill="none" aria-hidden>
          <path d="M2 12h40m0 0-8-8m8 8-8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        <div className="rounded-[14px] border border-dashed border-brand/45 bg-brand-wash p-3.5">
          <div className="flex flex-wrap items-start gap-2.5">
            <MiniFrame title="a-classic" badge="A" state="selected" className="w-[118px]">
              <div className="space-y-2">
                <MiniBlock className="h-[34px] rounded-[8px]" />
                <MiniBar w="70%" tone="ink" />
                <MiniBar w="45%" />
                <div className="h-[12px] w-full rounded-full bg-brand/70" />
              </div>
            </MiniFrame>
            <MiniFrame title="b-editorial" badge="B" className="w-[118px]">
              <div className="space-y-2">
                <MiniBar w="85%" tone="ink" />
                <div className="h-px w-full bg-muted-foreground/30" />
                <MiniBar w="60%" />
                <MiniBlock className="h-[28px] rounded-[8px]" />
                <MiniBar w="40%" />
              </div>
            </MiniFrame>
            <MiniFrame title="c-brutalist" badge="C" className="w-[118px]">
              <div className="space-y-2">
                <div className="h-[16px] w-full rounded-none bg-foreground/80" />
                <MiniBar w="55%" className="rounded-none" />
                <MiniBar w="75%" className="rounded-none" />
                <div className="h-[14px] w-[60%] rounded-none bg-foreground/80" />
              </div>
            </MiniFrame>
          </div>
          <p className="mt-3 px-0.5 text-[12px] font-medium text-muted-soft">
            one variant group - it never breaks apart on tidy
          </p>
        </div>
      </div>
    </Slide>
  )
}
