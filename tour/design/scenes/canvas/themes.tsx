import { Ink, Keys, Slide } from '../../../src/components/kit'

export const meta = { title: 'Themes', viewport: 'laptop', theme: 'dark' }

export default function Themes() {
  return (
    <Slide
      eyebrow="The canvas"
      step="3 of 4"
      title="Both themes, from one set of tokens."
      lead={
        <>
          Press <Ink>d</Ink> and every frame re-renders from the same components, so dark is a
          state your design really has, not a filter over a picture of it. Notice this frame
          does not flip: it is <Ink>pinned dark</Ink> in its own file, the way a frame can
          insist on the state it was designed to show.
        </>
      }
      hint={
        <>
          <Keys combo="d" className="mr-2" /> flips the selection when one exists, the whole
          canvas otherwise. Try it on the recipe phones.
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-6">
        {(['light', 'dark'] as const).map((t) => (
          <div
            key={t}
            className="w-[300px] rounded-card border p-5"
            style={
              t === 'light'
                ? { background: '#ffffff', borderColor: '#dddee5', color: '#18181b' }
                : { background: '#0f1015', borderColor: '#2c2d38', color: '#f5f5f7' }
            }
          >
            <p className="text-[12px] font-semibold tracking-[0.08em] uppercase" style={{ color: t === 'light' ? '#86868b' : '#9fa0ac' }}>
              {t}
            </p>
            <p className="mt-2 text-[17px] font-semibold">The same screen.</p>
            <p className="mt-1.5 text-[13.5px] leading-[1.5]" style={{ color: t === 'light' ? '#5c5e6b' : '#9fa0ac' }}>
              One set of tokens carries both - the design agrees with itself before any logic
              is written.
            </p>
            <button
              type="button"
              className="mt-4 inline-flex h-[34px] items-center gap-2 rounded-full pr-4 pl-3.5 text-[13px] font-semibold"
              style={{ background: '#0088ff', color: '#ffffff' }}
            >
              <svg viewBox="0 0 16 16" className="size-4 shrink-0" fill="none" aria-hidden>
                <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.6" />
                <path d="M8 1.75v12.5A6.25 6.25 0 0 0 8 1.75Z" fill="currentColor" />
              </svg>
              Flip the theme
            </button>
          </div>
        ))}
      </div>
    </Slide>
  )
}
