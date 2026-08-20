import { Cmd, Ink, Out, Slide, Term } from '../../../src/components/kit'

export const meta = { title: 'Take it home', viewport: 'laptop' }

/**
 * The last frame of the tour, and the only one with an ask. Two commands, then
 * the sentence that actually matters: point your own agent at your own repo and
 * watch what it does with a canvas.
 */

const AFTER = [
  {
    title: 'It reads your codebase',
    body: 'Your components, your tokens, your Tailwind config. The frames it writes import the real thing.',
  },
  {
    title: 'It designs by writing files',
    body: 'No handoff, no export. The design work and the app work are the same files.',
  },
  {
    title: 'You steer from the canvas',
    body: 'Pin a comment on the exact element, tag it, and the loop you just watched runs on your own screens.',
  },
]

export default function TakeItHome() {
  return (
    <Slide
      eyebrow="Thank you"
      step="2 of 2"
      title="Now point it at your own repo."
      lead={
        <>
          Try it on a side project, or on the one that pays. Two commands and your coding
          agent has a canvas - and if you have never watched an agent design against your
          real components, <Ink>you are about to be surprised by what it can already do</Ink>.
        </>
      }
      hint={<>That is the whole pitch. Go and see.</>}
    >
      <div className="flex max-w-[1140px] flex-col items-stretch gap-7 lg:flex-row">
        <Term title="your repo" className="w-full max-w-[520px] shrink-0">
          <Cmd note="reads the codebase, writes design/">npx marver init</Cmd>
          <Out className="text-comment-ink">✓ canvas configured from your components</Out>
          <div className="h-3" />
          <Cmd note="the canvas, live">npx marver dev</Cmd>
          <Out>→ http://localhost:5240</Out>
          <div className="h-4" />
          <Out className="pl-0 text-muted-soft">
            # or just tell your agent:
          </Out>
          <Out className="pl-0 text-foreground/80">
            # “set up marver here and design me the settings screen”
          </Out>
        </Term>

        <div className="grid min-w-0 flex-1 grid-rows-3 gap-3.5">
          {AFTER.map((a, i) => (
            <div key={a.title} className="flex items-start gap-4 rounded-card border border-border bg-surface-2 px-5 py-4">
              <span className="mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-full bg-brand-wash text-[13px] font-bold text-brand-ink ring-1 ring-brand/15">
                {i + 1}
              </span>
              <div className="min-w-0">
                <h2 className="text-[15.5px] font-semibold tracking-[-0.015em]">{a.title}</h2>
                <p className="mt-1 text-[13.5px] leading-[1.55] text-muted-foreground">{a.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Slide>
  )
}
