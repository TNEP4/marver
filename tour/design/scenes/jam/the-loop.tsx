import {
  At, Ink, MiniBar, MiniButton, MiniFrame, Slide, ThreadCard, ThreadMsg, WorkingFrame,
} from '../../../src/components/kit'

export const meta = { title: 'Live Jam', viewport: 'laptop' }

function Beat({ n, label, note, children }: { n: number; label: string; note: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <p className="text-[12.5px] font-semibold tracking-[0.06em] text-muted-soft uppercase">
        <span className="mr-1.5 text-brand">{n}</span>
        {label}
      </p>
      {children}
      <p className="px-0.5 text-[12.5px] leading-[1.45] text-muted-foreground">{note}</p>
    </div>
  )
}

function Arrow() {
  return (
    <svg viewBox="0 0 32 16" className="mt-[3px] hidden w-8 shrink-0 text-muted-soft opacity-35 lg:block" fill="none" aria-hidden>
      <path d="M2 8h26m0 0-6-6m6 6-6 6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function TheLoop() {
  return (
    <Slide
      eyebrow="Live Jam"
      step="1 of 3"
      title="Tag @marver. Your agent does the rest."
      lead={
        <>
          On your own canvas, while <Ink>marver dev</Ink> runs, any comment that tags{' '}
          <Ink>@marver</Ink> becomes a job: <Ink>your local coding agent</Ink> picks it up,
          lights the frame while it edits the real source files, and replies in the thread -
          everyone watching the board sees the work happen. It is on out of the box, and the
          agent doing the work is your own - marver ships none.
        </>
      }
      hint={<>No round trip to the terminal. The board is the workbench.</>}
    >
      <div className="flex max-w-[1120px] flex-col items-stretch gap-8 lg:flex-row lg:items-start">
        <Beat
          n={1}
          label="The ask"
          note="The mention is the trigger. Your agent answers in the thread first, so you know it heard you."
        >
          <ThreadCard>
            <ThreadMsg name="Nic" hue="#34c759" time="2m">
              <At /> make the price the biggest number on the card
            </ThreadMsg>
            <ThreadMsg agent time="now">
              On it - promoting the fare.
            </ThreadMsg>
          </ThreadCard>
        </Beat>
        <Arrow />
        <Beat
          n={2}
          label="The work, live"
          note="Working frames announce themselves: a blue ring with a shimmer orbiting the border, a wave down the content, marks twinkling in the flank."
        >
          <WorkingFrame title="ride/choose" className="w-full">
            <div className="space-y-2">
              <MiniBar w="45%" tone="ink" />
              <MiniBar />
              <MiniBar w="70%" />
              <div className="flex justify-end"><MiniButton className="h-[14px] w-[40px]" /></div>
            </div>
          </WorkingFrame>
        </Beat>
        <Arrow />
        <Beat
          n={3}
          label="The receipt"
          note="The frame lands changed and the same thread carries what your agent did."
        >
          <div className="space-y-3">
            <MiniFrame title="ride/choose" badge="updated" state="done" className="w-full">
              <div className="space-y-2">
                <MiniBar w="45%" tone="ink" />
                <MiniBar w="34%" tone="brand" className="h-[11px]" />
                <MiniBar w="70%" />
                <div className="flex justify-end"><MiniButton className="h-[14px] w-[40px]" /></div>
              </div>
            </MiniFrame>
            <ThreadCard>
              <ThreadMsg agent time="now">
                Done - the fare leads each row at 22 px semibold.
              </ThreadMsg>
            </ThreadCard>
          </div>
        </Beat>
      </div>
    </Slide>
  )
}
