import { Ink, Kbd, MarverMark, Slide, cn } from '../../../src/components/kit'

export const meta = { title: 'Next stop', viewport: 'laptop' }

const BOARDS = [
  {
    name: 'canvas',
    body: 'Boards, scenes, frames - and how a canvas is arranged.',
    goto: 'canvas/frames-are-code',
    next: true,
  },
  {
    name: 'prototype',
    body: 'Run a wired flow in place on the canvas, or full screen.',
    goto: 'prototype/two-ways',
  },
  {
    name: 'collaborate',
    body: 'Comment on the exact element, publish, invite the team.',
    goto: 'collaborate/comment-and-laser',
  },
  {
    name: 'jam',
    body: 'Tag @marver in a comment and your agent picks up the work.',
    goto: 'jam/the-loop',
  },
  {
    name: 'thanks',
    body: 'The end of the tour, and the start of yours.',
    goto: 'thanks/end-of-tour',
  },
]

export default function NextStop() {
  return (
    <Slide
      eyebrow="Welcome"
      step="6 of 6"
      title="You can drive."
      lead={
        <>
          That is the whole idea: <Ink>a canvas of real frames</Ink>, driven by your agent,
          steered by you. Select this frame and press <Ink>p</Ink> to make it live, then
          click a board below - the canvas takes you there.
        </>
      }
      hint={
        <>
          <Kbd className="mr-1">Esc</Kbd> steps back out to the canvas. The same boards wait
          in the sidebar.
        </>
      }
    >
      <div className="grid max-w-[1080px] grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {BOARDS.map((b) => (
          <button
            key={b.name}
            type="button"
            data-goto={b.goto}
            className={cn(
              'group cursor-pointer rounded-card border p-5 text-left transition duration-150',
              'hover:-translate-y-0.5 hover:border-brand hover:bg-brand-wash hover:shadow-lift',
              'active:translate-y-0 active:scale-[0.985] active:bg-brand-wash active:shadow-node',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
              b.next ? 'border-brand bg-brand-wash' : 'border-border bg-surface-2',
            )}
          >
            <div className="flex items-center gap-2">
              <MarverMark
                className={cn(
                  'size-[15px] transition-colors duration-150 group-hover:text-brand',
                  b.next ? 'text-brand' : 'text-muted-soft',
                )}
              />
              <span
                className={cn(
                  'text-[13px] font-semibold tracking-[0.08em] uppercase transition-colors duration-150 group-hover:text-brand-ink',
                  b.next ? 'text-brand-ink' : 'text-muted-soft',
                )}
              >
                {b.name}
              </span>
              {b.next && (
                <span className="ml-auto text-[11.5px] font-semibold tracking-[0.04em] text-brand-ink/70 uppercase group-hover:hidden">
                  next
                </span>
              )}
              <span className="ml-auto hidden items-center gap-1 text-[11.5px] font-semibold tracking-[0.04em] text-brand-ink uppercase group-hover:flex group-active:flex">
                open
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden>
                  <path
                    d="m6 3.5 4.5 4.5L6 12.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </div>
            <p className="mt-2.5 text-[14.5px] leading-[1.55] text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
              {b.body}
            </p>
          </button>
        ))}
      </div>
    </Slide>
  )
}
