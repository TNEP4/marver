import { Face, Ink, Slide } from '../../../src/components/kit'

export const meta = { title: 'Trust shape', viewport: 'laptop' }

/* Phosphor regular, inlined - the repo's icon system (design/instructions/craft.md). */
const ICON = {
  laptop:
    'M232,168h-8V72a24,24,0,0,0-24-24H56A24,24,0,0,0,32,72v96H24a8,8,0,0,0-8,8v16a24,24,0,0,0,24,24H216a24,24,0,0,0,24-24V176A8,8,0,0,0,232,168ZM48,72a8,8,0,0,1,8-8H200a8,8,0,0,1,8,8v96H48ZM224,192a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8v-8H224ZM152,88a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h32A8,8,0,0,1,152,88Z',
  key: 'M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43ZM224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z',
  seal: 'M225.86,102.82c-3.77-3.94-7.67-8-9.14-11.57-1.36-3.27-1.44-8.69-1.52-13.94-.15-9.76-.31-20.82-8-28.51s-18.75-7.85-28.51-8c-5.25-.08-10.67-.16-13.94-1.52-3.56-1.47-7.63-5.37-11.57-9.14C146.28,23.51,138.44,16,128,16s-18.27,7.51-25.18,14.14c-3.94,3.77-8,7.67-11.57,9.14C88,40.64,82.56,40.72,77.31,40.8c-9.76.15-20.82.31-28.51,8S41,67.55,40.8,77.31c-.08,5.25-.16,10.67-1.52,13.94-1.47,3.56-5.37,7.63-9.14,11.57C23.51,109.72,16,117.56,16,128s7.51,18.27,14.14,25.18c3.77,3.94,7.67,8,9.14,11.57,1.36,3.27,1.44,8.69,1.52,13.94.15,9.76.31,20.82,8,28.51s18.75,7.85,28.51,8c5.25.08,10.67.16,13.94,1.52,3.56,1.47,7.63,5.37,11.57,9.14C109.72,232.49,117.56,240,128,240s18.27-7.51,25.18-14.14c3.94-3.77,8-7.67,11.57-9.14,3.27-1.36,8.69-1.44,13.94-1.52,9.76-.15,20.82-.31,28.51-8s7.85-18.75,8-28.51c.08-5.25.16-10.67,1.52-13.94,1.47-3.56,5.37-7.63,9.14-11.57C232.49,146.28,240,138.44,240,128S232.49,109.73,225.86,102.82Zm-11.55,39.29c-4.79,5-9.75,10.17-12.38,16.52-2.52,6.1-2.63,13.07-2.73,19.82-.1,7-.21,14.33-3.32,17.43s-10.39,3.22-17.43,3.32c-6.75.1-13.72.21-19.82,2.73-6.35,2.63-11.52,7.59-16.52,12.38S132,224,128,224s-9.15-4.92-14.11-9.69-10.17-9.75-16.52-12.38c-6.1-2.52-13.07-2.63-19.82-2.73-7-.1-14.33-.21-17.43-3.32s-3.22-10.39-3.32-17.43c-.1-6.75-.21-13.72-2.73-19.82-2.63-6.35-7.59-11.52-12.38-16.52S32,132,32,128s4.92-9.15,9.69-14.11,9.75-10.17,12.38-16.52c2.52-6.1,2.63-13.07,2.73-19.82.1-7,.21-14.33,3.32-17.43S70.51,56.9,77.55,56.8c6.75-.1,13.72-.21,19.82-2.73,6.35-2.63,11.52-7.59,16.52-12.38S124,32,128,32s9.15,4.92,14.11,9.69,10.17,9.75,16.52,12.38c6.1,2.52,13.07,2.63,19.82,2.73,7,.1,14.33.21,17.43,3.32s3.22,10.39,3.32,17.43c.1,6.75.21,13.72,2.73,19.82,2.63,6.35,7.59,11.52,12.38,16.52S224,124,224,128,219.08,137.15,214.31,142.11ZM173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34Z',
}

const SHAPE = [
  {
    icon: ICON.laptop,
    title: 'Your agent, your machine',
    body: 'marver ships no AI and calls no cloud. The agent that acts is the one you already run and already trust, working in your own checkout.',
  },
  {
    icon: ICON.key,
    title: 'Owner-gated triggers',
    body: 'Only mentions the canvas owner has vouched for become jobs. A drive-by comment on a published board cannot start work on your repo.',
  },
  {
    icon: ICON.seal,
    title: 'Provenance on every reply',
    body: 'Each agent reply carries its receipt - which agent ran it, as which dev user, on which model when the agent names one. Hover the badge and the chain is there.',
  },
]

export default function Trust() {
  return (
    <Slide
      eyebrow="Live Jam"
      step="2 of 3"
      title="What the agent can touch, and what it cannot."
      lead={
        <>
          A comment that edits your codebase should make you ask hard questions. The answers
          are the design: <Ink>nothing acts but your own agent, nothing triggers but the
          owner’s word, and nothing lands unsigned</Ink>.
        </>
      }
    >
      <div className="flex max-w-[1120px] flex-col items-stretch gap-6 lg:flex-row">
        <div className="grid flex-1 grid-cols-1 gap-6 md:grid-cols-3">
          {SHAPE.map((s) => (
            <div key={s.title} className="rounded-card border border-border bg-surface-2 p-6">
              <span className="mb-4 flex size-[38px] items-center justify-center rounded-[11px] bg-brand-wash text-brand ring-1 ring-brand/15">
                <svg width="21" height="21" viewBox="0 0 256 256" fill="currentColor" aria-hidden>
                  <path d={s.icon} />
                </svg>
              </span>
              <h2 className="text-[17px] font-semibold tracking-[-0.015em]">{s.title}</h2>
              <p className="mt-2.5 text-[14.5px] leading-[1.55] text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
        {/* the provenance tooltip, as the canvas draws it */}
        <div className="flex w-[230px] shrink-0 flex-col justify-end">
          <div className="rounded-card bg-tip p-4 text-tip-ink shadow-(--shadow-lift)">
            <div className="mb-2.5 flex items-center gap-2">
              <Face agent className="size-6 text-[10px]" />
              <span className="text-[13px] font-semibold">Marver</span>
            </div>
            {[['Agent', 'Claude Code'], ['Model', 'Opus'], ['Dev user', 'Nic']].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between py-[3px] text-[12.5px]">
                <span className="opacity-55">{k}</span>
                <span className="font-semibold">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Slide>
  )
}
