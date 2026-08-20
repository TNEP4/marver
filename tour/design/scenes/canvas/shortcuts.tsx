import type { ReactNode } from 'react'
import { cn, Ink, Kbd, Keys, Slide } from '../../../src/components/kit'

export const meta = { title: 'Shortcuts', viewport: 'laptop' }

/* ── Section marks - one icon per group, in the hue that group already owns
 *    on the canvas: board blue, play purple (the interact ring), comments
 *    green (the pin). Drawn on a 24 grid, 1.6 stroke, so all three read as
 *    one set at 15px. ─────────────────────────────────────────────────────── */

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[15px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

/** Four frames on a board. */
const BoardIcon = (
  <Glyph>
    <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.8" />
    <rect x="13" y="3.5" width="7.5" height="7.5" rx="1.8" />
    <rect x="3.5" y="13" width="7.5" height="7.5" rx="1.8" />
    <rect x="13" y="13" width="7.5" height="7.5" rx="1.8" />
  </Glyph>
)

/** Play, in a device-shaped round. */
const PlayIcon = (
  <Glyph>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M10.3 8.9 15.5 12l-5.2 3.1Z" fill="currentColor" />
  </Glyph>
)

/** A thread, pinned. */
const FeedbackIcon = (
  <Glyph>
    <path d="M20.5 7.2v7.2a2.4 2.4 0 0 1-2.4 2.4h-6.4L7.4 20v-3.2H5.9a2.4 2.4 0 0 1-2.4-2.4V7.2A2.4 2.4 0 0 1 5.9 4.8h12.2a2.4 2.4 0 0 1 2.4 2.4Z" />
    <path d="M8.9 10.8h.01M12 10.8h.01M15.1 10.8h.01" strokeWidth={2.2} />
  </Glyph>
)

const TONES = {
  board: 'border-brand/25 bg-brand/10 text-brand',
  play: 'border-interact/25 bg-interact/10 text-interact',
  feedback: 'border-comment/30 bg-comment/10 text-comment-ink',
} as const

const RULES = {
  board: 'bg-brand/45',
  play: 'bg-interact/45',
  feedback: 'bg-comment/55',
} as const

/** One cheat-sheet row: key chips left, action + clause right. Denser than
 *  KeyRow on purpose - thirteen shortcuts share a single laptop frame. */
function Row({ keys, action, children }: { keys: ReactNode; action: string; children?: ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_1fr] items-baseline gap-x-4">
      <span className="justify-self-start">{keys}</span>
      <p className="text-[14px] leading-[1.45] text-muted-foreground">
        <span className="font-semibold text-foreground">{action}</span>
        {children && <> {children}</>}
      </p>
    </div>
  )
}

function Group({
  label, icon, tone, children,
}: {
  label: string
  icon: ReactNode
  tone: keyof typeof TONES
  children: ReactNode
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2.5 pb-3">
        <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-[9px] border', TONES[tone])}>
          {icon}
        </span>
        <p className="text-[16px] leading-none font-semibold tracking-[-0.015em] text-foreground">{label}</p>
      </div>
      <div className="relative h-px w-full bg-border">
        <span className={cn('absolute inset-y-0 left-0 w-7 rounded-full', RULES[tone])} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-y-3.5">{children}</div>
    </div>
  )
}

export default function Shortcuts() {
  return (
    <Slide
      eyebrow="The canvas"
      title="Every key the tour taught."
      lead={
        <>
          One card to keep. The keys are polite about scope: digits and <Ink>d</Ink> act on{' '}
          <Ink>the selection</Ink> when one exists, the whole board otherwise.
        </>
      }
      hint={<>All of it works right now - this tour is a live canvas, not a slideshow.</>}
    >
      <div className="grid max-w-[1080px] grid-cols-1 gap-x-12 gap-y-8 lg:grid-cols-3">
        <Group label="The board" icon={BoardIcon} tone="board">
          <Row
            keys={
              <span className="inline-flex items-center gap-1">
                <Kbd>1</Kbd>
                <span className="text-[12px] text-muted-soft">–</span>
                <Kbd>4</Kbd>
              </span>
            }
            action="Device widths."
          >
            Phone to monitor - designs re-render, nothing stretches.
          </Row>
          <Row keys={<Keys combo="0" />} action="True sizes.">
            Every frame returns to its own.
          </Row>
          <Row keys={<Keys combo="d" />} action="Light / dark.">
            Same tokens, both real.
          </Row>
          <Row keys={<Keys combo="t" />} action="Tidy.">
            Your view rearranges; the JSON layout stays.
          </Row>
        </Group>

        <Group label="Play" icon={PlayIcon} tone="play">
          <Row keys={<Keys combo="p" />} action="Play mode.">
            Full screen in a device; taps follow <Ink>data-goto</Ink>.
          </Row>
          <Row
            keys={
              <span className="inline-flex items-center gap-1">
                <Kbd>[</Kbd>
                <Kbd>]</Kbd>
              </span>
            }
            action="Flip variants."
          >
            Sibling directions swap in place mid-play.
          </Row>
          <Row keys={<Keys combo="esc" />} action="Step back out.">
            Of play, of any mode.
          </Row>
        </Group>

        <Group label="Feedback" icon={FeedbackIcon} tone="feedback">
          <Row keys={<Keys combo="c" />} action="Comment mode.">
            Pin a thread to the exact element.
          </Row>
          <Row keys={<Keys combo="shift+c" />} action="Hide the pins." />
          <Row keys={<Keys combo="l" />} action="Laser mode.">
            A clean highlight to point with on a call.
          </Row>
          <Row keys={<Keys combo="shift+l" />} action="Laser comments.">
            Highlight what each thread anchors to.
          </Row>
        </Group>
      </div>
    </Slide>
  )
}
