import { Cmd, Face, Ink, Out, Slide, Term } from '../../../src/components/kit'

export const meta = { title: 'Invite the team', viewport: 'laptop' }

/**
 * The middle collaborate slide. One command, one link, one account - drawn as
 * the two halves people actually see: what you type, and what your colleague
 * opens. No email infrastructure anywhere in the picture, because there is none.
 */

const TEAM = [
  { name: 'Aeliana', hue: '#ff9500', role: 'design' },
  { name: 'Mateo', hue: '#5856d6', role: 'eng' },
  { name: 'Priya', hue: '#34c759', role: 'pm' },
]

export default function Invite() {
  return (
    <Slide
      eyebrow="Collaborate"
      step="3 of 4"
      title="One link. Everyone gets their own account."
      lead={
        <>
          <Ink>marver comments invite</Ink> prints a single-use link - send it however you
          already talk. Your colleague sets a name and a password, and lands on the board
          able to pin threads. <Ink>No seats to buy, no workspace to join</Ink>, and{' '}
          <Ink>revoke</Ink> ends an account and its live sessions mid-flight.
        </>
      }
      hint={<>Every thread carries who wrote it, so the board stays accountable.</>}
    >
      <div className="flex max-w-[1140px] items-stretch gap-7">
        <Term title="your repo" className="w-[560px] shrink-0">
          <Cmd note="once, from the deploy logs">
            marver comments connect &lt;url&gt; --invite &lt;token&gt;
          </Cmd>
          <Out className="text-comment-ink">✓ owner claimed - this machine can mint invites</Out>
          <div className="h-3" />
          <Cmd>marver comments invite aeliana@example.com</Cmd>
          <Out>
            → tour.marver.design/#/i/<span className="text-foreground/70">9f2c84a1</span>
          </Out>
          <Out className="text-muted-soft">single-use · expires in 7 days</Out>
          <div className="h-3" />
          <Cmd note="account and sessions, gone">marver comments revoke aeliana@example.com</Cmd>
        </Term>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* what the colleague opens */}
          <div className="rounded-card border border-border bg-surface-2 p-5">
            <p className="text-[12.5px] font-semibold tracking-[0.06em] text-muted-soft uppercase">
              What they open
            </p>
            <div className="mt-3.5 rounded-[14px] border border-border bg-card p-5 shadow-(--shadow-lift)">
              <p className="text-[16px] font-semibold tracking-[-0.015em]">Join marver tour</p>
              <p className="mt-1 text-[13.5px] text-muted-foreground">
                Invited by Nic · read and comment
              </p>
              <div className="mt-4 flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-[11px] font-medium text-muted-soft">
                  add
                </span>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex h-[34px] items-center rounded-[10px] border border-border bg-surface px-3 text-[13.5px] text-foreground/80">
                    Aeliana Rossi
                  </div>
                  <div className="flex h-[34px] items-center rounded-[10px] border border-border bg-surface px-3 text-[13.5px] text-muted-soft">
                    ••••••••••
                  </div>
                </div>
              </div>
              <div className="mt-4 flex h-[40px] items-center justify-center rounded-full bg-brand text-[14.5px] font-semibold text-white">
                Claim my account
              </div>
            </div>
          </div>

          {/* and then they are simply on the board */}
          <div className="flex items-center gap-4 rounded-card border border-border bg-surface-2 px-5 py-4">
            <div className="flex -space-x-2">
              {TEAM.map((t) => (
                <Face key={t.name} name={t.name} hue={t.hue} className="ring-2 ring-surface-2" />
              ))}
              <Face agent className="ring-2 ring-surface-2" />
            </div>
            <p className="min-w-0 text-[13.5px] leading-[1.5] text-muted-foreground">
              Three teammates and your agent, all reading the same board.
            </p>
          </div>
        </div>
      </div>
    </Slide>
  )
}
