import type { ReactNode } from 'react'
import {
  At, Cmd, Ink, MiniFrame, Out, Slide, Term, ThreadCard, ThreadMsg, cn,
} from '../../../src/components/kit'

export const meta = { title: 'Comments that act', viewport: 'laptop' }

/**
 * The last collaborate slide, and the one that closes the loop: a thread is not
 * a sticky note on a screenshot - it is anchored to an element, and that anchor
 * is what makes it something an agent can act on. Left, what a person sees;
 * right, what the agent reads.
 */

/** The depth-hue highlight, exactly as the frame host paints it. */
function Hue({ h, className, children }: { h: number; className?: string; children?: ReactNode }) {
  return (
    <div
      className={cn('rounded-[4px]', className)}
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

export default function Comments() {
  return (
    <Slide
      eyebrow="Collaborate"
      step="3 of 3"
      title="Every comment is pinned to an element."
      lead={
        <>
          Not to a screenshot, not to a frame - to the <Ink>exact div</Ink>, with its tag,
          its text and its css path. That anchor is what makes a thread{' '}
          <Ink>machine-readable</Ink>: your agent lists the open queue, reads the element
          before the words, edits the file, and replies in the thread. <Ink>@marver</Ink> in
          the comment starts it without you leaving the board.
        </>
      }
      hint={<>Feedback, work and receipt in one place - the iteration loop gets very short.</>}
    >
      <div className="flex max-w-[1140px] items-stretch gap-7">
        {/* what a person sees */}
        <div className="flex w-[560px] shrink-0 items-start gap-4 rounded-card border border-border bg-surface-2 p-5">
          <div className="relative shrink-0">
            <MiniFrame title="ride/choose" badge="mobile" state="comment" className="w-[186px]">
              <div className="space-y-2">
                <span className="block h-[5px] w-[62%] rounded-full bg-foreground/70" />
                <span className="block h-[4px] w-[42%] rounded-full bg-muted-foreground/30" />
                <Hue h={120} className="mt-2.5 flex items-center gap-2 px-2 py-2">
                  <span className="block size-[18px] rounded-[4px] bg-muted" />
                  <span className="block h-[4px] w-[46px] rounded-full bg-foreground/60" />
                  <span className="ml-auto text-[11px] font-bold">$11.20</span>
                </Hue>
                <span className="block h-[4px] w-[52%] rounded-full bg-muted-foreground/30" />
                <div className="h-[14px] rounded-full bg-brand" />
              </div>
            </MiniFrame>
            <span className="absolute -right-2 top-[92px] flex size-[20px] items-center justify-center rounded-full rounded-bl-[3px] bg-comment text-[10px] font-bold text-white shadow-(--shadow-node)">
              A
            </span>
          </div>

          <ThreadCard className="min-w-0 flex-1">
            <ThreadMsg name="Aeliana" hue="#ff9500" time="2:14 pm">
              The fare is buried - can it lead the row? <At />
            </ThreadMsg>
            <ThreadMsg agent time="2:14 pm">
              On it - promoting the fare.
            </ThreadMsg>
            <ThreadMsg agent time="2:17 pm">
              Price is the row’s biggest number now.
            </ThreadMsg>
          </ThreadCard>
        </div>

        {/* what the agent reads */}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <Term title="your agent" className="min-w-0">
            <Cmd note="the work queue">marver comments list --open --json</Cmd>
            <Out className="text-foreground/70">
              {'{ "frame": "ride/choose",'}
            </Out>
            <Out className="pl-[34px] text-foreground/70">
              {'"anchor": { "tag": "button", "quote": "$11.20",'}
            </Out>
            <Out className="pl-[52px] text-foreground/70">
              {'"css": "#root > div > ul > li:nth-child(1)" },'}
            </Out>
            <Out className="pl-[34px] text-foreground/70">
              {'"body": "The fare is buried…" }'}
            </Out>
            <div className="h-3" />
            <Cmd>marver comments reply &lt;thread&gt; --body "…"</Cmd>
            <Cmd>marver comments resolve &lt;thread&gt; --addressed-in ride/choose</Cmd>
          </Term>

          <div className="rounded-card border border-border bg-surface-2 px-5 py-4">
            <p className="text-[13.5px] leading-[1.55] text-muted-foreground">
              <Ink>The anchor names the div, so the agent reads it before the words.</Ink>{' '}
              That is the difference between “make the price bigger” being a note and being
              a job.
            </p>
          </div>
        </div>
      </div>
    </Slide>
  )
}
