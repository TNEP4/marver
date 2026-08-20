import { Cursor, DemoNode, Ink, Move, Slide, Tag } from '../../../src/components/kit'

export const meta = { title: 'Why code-native', viewport: 'laptop' }

/**
 * Three claims, three drawn demos. Each swatch shows the thing happening - a
 * frame made of the app's own components, an agent writing the file, a human
 * reacting - so the argument is on the canvas instead of in the paragraph.
 */

/* ── The three swatches ───────────────────────────────────────────────────── */

/** No mockup-to-code gap: the frame IS the app's components, named. */
const RealCode = (
  <div className="flex h-full items-center justify-center">
    <div className="relative">
      <DemoNode w={128} h={82} state="selected">
        <div className="flex h-full flex-col">
          <span className="block h-[5px] w-[54%] rounded-full bg-foreground/70" />
          <div className="mt-2 flex-1 rounded-[4px] bg-muted" />
          <div className="mt-2 flex items-center justify-between">
            <span className="block h-[4px] w-[30px] rounded-full bg-muted-foreground/30" />
            <span className="block h-[12px] w-[36px] rounded-full bg-brand" />
          </div>
        </div>
      </DemoNode>
      <Tag className="-top-3 -left-2 font-mono">&lt;Card/&gt;</Tag>
      <Tag className="right-0 -bottom-4 font-mono">&lt;Button/&gt;</Tag>
    </div>
  </div>
)

/** The agent writes the file; the frame is already wearing the change. */
const AgentWrites = (
  <div className="flex h-full items-center justify-center gap-3.5">
    <div className="w-[118px] overflow-hidden rounded-[8px] border border-border bg-surface-2 shadow-(--shadow-node)">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span className="size-[4px] rounded-full bg-muted-foreground/35" />
        <span className="size-[4px] rounded-full bg-muted-foreground/25" />
      </div>
      <div className="space-y-1 px-2 py-2 font-mono text-[7.5px] leading-[1.5] text-muted-foreground">
        <p className="text-foreground/80">cart.tsx</p>
        <p>+ &lt;Button&gt;Pay&lt;/Button&gt;</p>
        <p className="flex items-center gap-1">
          + &lt;Total/&gt;
          <span className="inline-block h-[7px] w-[3px] bg-brand" />
        </p>
      </div>
    </div>
    <svg viewBox="0 0 24 12" className="w-5 shrink-0 text-brand" fill="none" aria-hidden>
      <path d="M1 6h20m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <DemoNode w={72} h={62} state="interact">
      <div className="flex h-full flex-col">
        <span className="block h-[4px] w-[58%] rounded-full bg-foreground/70" />
        <span className="mt-1.5 block h-[3px] w-[80%] rounded-full bg-muted-foreground/30" />
        <div className="mt-auto flex items-center gap-1">
          <span className="size-[5px] animate-pulse rounded-full bg-interact" />
          <span className="block h-[3px] w-[26px] rounded-full bg-interact/45" />
        </div>
      </div>
    </DemoNode>
  </div>
)

/** You look, compare, and say which one - that is the whole job. */
const YouSteer = (
  <div className="flex h-full items-center justify-center gap-5">
    <DemoNode w={72} h={74} className="opacity-50" />
    <div className="relative">
      <DemoNode w={72} h={74} state="selected" />
      <Cursor className="top-[40px] left-[28px] w-[18px]" />
      <span className="absolute -top-2 -right-2 flex size-[18px] items-center justify-center rounded-full rounded-bl-[3px] bg-comment text-[9px] font-bold text-white shadow-(--shadow-node)">
        Y
      </span>
    </div>
  </div>
)

const POINTS = [
  {
    title: 'Frames are real code',
    body: 'Every screen is a React component using your app’s actual theme and component library. There is no mockup-to-code gap because there is no mockup.',
    demo: RealCode,
  },
  {
    title: 'Your agent designs by writing files',
    body: 'marver ships no AI. Your own coding agent - Claude Code, Codex, whichever you run - writes the frame files, and the canvas reflects them live.',
    demo: AgentWrites,
  },
  {
    title: 'You steer by reacting',
    body: 'Look, click, compare, comment. By the time you agree on the design, most of the UI already exists - shipping means plugging in the logic.',
    demo: YouSteer,
  },
]

export default function Philosophy() {
  return (
    <Slide
      eyebrow="Welcome"
      step="4 of 6"
      title="None of this is a design artifact."
      lead={
        <>
          Design tools make pictures of software. marver skips the picture:{' '}
          <Ink>the design and the product are the same files</Ink>, so agreeing on the look
          and feel IS building the app.
        </>
      }
      hint={<>Next: a quick look around the canvas UI itself.</>}
    >
      <div className="grid max-w-[1080px] grid-cols-1 gap-5 md:grid-cols-3">
        {POINTS.map((p) => (
          <Move key={p.title} action={p.title} demo={p.demo} stageH={150} wide>
            {p.body}
          </Move>
        ))}
      </div>
    </Slide>
  )
}
