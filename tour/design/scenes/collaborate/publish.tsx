import type { ReactNode } from 'react'
import { Cmd, Ink, Out, Slide, Term, cn } from '../../../src/components/kit'

export const meta = { title: 'Publish it', viewport: 'laptop' }

/**
 * The first collaborate slide: how a local canvas becomes a URL. Two commands on
 * the left, the gate they produce on the right - three doors, one credential
 * each, because that is the part people actually ask about.
 */

const DOORS: { key: string; who: string; how: ReactNode; rights: string; tone: string }[] = [
  {
    key: 'Guest',
    who: 'Anyone with the password',
    how: <>The canvas password you set at serve time.</>,
    rights: 'read',
    tone: 'text-muted-soft',
  },
  {
    key: 'Member',
    who: 'Your team',
    how: <>Their own email and password - the session IS the gate.</>,
    rights: 'read + comment',
    tone: 'text-comment-ink',
  },
  {
    key: 'Invited',
    who: 'Whoever you send a link to',
    how: <>The link skips the password; they set a name and land inside.</>,
    rights: 'read + comment',
    tone: 'text-comment-ink',
  },
]

function Key({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={className} fill="currentColor" aria-hidden>
      <path d="M216.57,39.43a80,80,0,0,0-113.14,0h0A80.09,80.09,0,0,0,83.29,113L34.34,161.9A8,8,0,0,0,32,167.57V216a8,8,0,0,0,8,8H88a8,8,0,0,0,8-8V200h16a8,8,0,0,0,8-8V176h16a8,8,0,0,0,5.66-2.34l9.4-9.4a80.09,80.09,0,0,0,73.51-20.14h0A80,80,0,0,0,216.57,39.43ZM180,84a16,16,0,1,1,16-16A16,16,0,0,1,180,84Z" />
    </svg>
  )
}

export default function Publish() {
  return (
    <Slide
      eyebrow="Collaborate"
      step="1 of 3"
      title="Two commands and the canvas has a URL."
      lead={
        <>
          <Ink>marver build</Ink> bundles only the boards you listed in{' '}
          <Ink>publish.json</Ink> - anything unlisted is not even in the bundle.{' '}
          <Ink>marver serve</Ink> runs it on any Node host. Point a volume at it and the
          published canvas grows accounts and live comments; leave it out and it stays a
          static, read-only canvas. <Ink>This tour is that command.</Ink>
        </>
      }
      hint={<>Re-publishing never clobbers feedback - the server unions the logs on boot.</>}
    >
      <div className="flex max-w-[1140px] items-stretch gap-7">
        <Term title="your repo" className="w-[540px] shrink-0">
          <Cmd note="which boards, what rights">cat design/publish.json</Cmd>
          <Out className="text-foreground/70">
            {'{ "boards": { "welcome": "read", "prototype": "comment" } }'}
          </Out>
          <div className="h-3" />
          <Cmd note="builds design/.dist">npx marver build</Cmd>
          <Out>2 boards · 11 frames · comment logs seeded</Out>
          <div className="h-3" />
          <Cmd>
            MARVER_PASSWORD=<span className="text-muted-soft">···</span> MARVER_DATA_DIR=/data \
          </Cmd>
          <Cmd>npx marver serve</Cmd>
          <Out className="text-comment-ink">→ live on https://tour.marver.design</Out>
        </Term>

        <div className="flex min-w-0 flex-1 flex-col rounded-card border border-border bg-surface-2 p-6">
          <div className="flex items-center gap-2.5">
            <span className="flex size-[30px] items-center justify-center rounded-[9px] bg-brand-wash text-brand ring-1 ring-brand/15">
              <Key className="size-[17px]" />
            </span>
            <h2 className="text-[16.5px] font-semibold tracking-[-0.015em]">
              The gate has three doors
            </h2>
          </div>
          <div className="mt-5 divide-y divide-border">
            {DOORS.map((d) => (
              <div key={d.key} className="flex items-baseline gap-4 py-3.5 first:pt-0 last:pb-0">
                <span className="w-[74px] shrink-0 text-[14.5px] font-semibold">{d.key}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium">{d.who}</p>
                  <p className="mt-1 text-[13.5px] leading-[1.5] text-muted-foreground">{d.how}</p>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full border border-border bg-surface px-2.5 py-1 text-[11.5px] font-semibold tracking-[0.02em]',
                    d.tone,
                  )}
                >
                  {d.rights}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-auto pt-6 text-[13.5px] leading-[1.5] text-muted-soft">
            You are standing behind door one right now - which is why this canvas reads but
            does not answer back.
          </p>
        </div>
      </div>
    </Slide>
  )
}
