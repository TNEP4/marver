import { Ink, Keys, MiniBar, MiniBlock, MiniButton, Slide, cn } from '../../../src/components/kit'

export const meta = { title: 'Devices', viewport: 'tablet' }

/**
 * Two pairs, so the row can fold. Wide frames lay all four out at their true
 * widths; narrow ones stack the pairs and let each card take its share of the
 * row (`share` of the pair's width, minus the gap) - the ladder phone < tablet
 * < laptop < monitor survives the fold.
 */
const PAIRS = [
  [
    { k: '1', label: 'phone', w: 64, share: 0.4, on: false },
    { k: '2', label: 'tablet', w: 96, share: 0.6, on: true },
  ],
  [
    { k: '3', label: 'laptop', w: 150, share: 0.44, on: false },
    { k: '4', label: 'monitor', w: 190, share: 0.56, on: false },
  ],
]

/*
 * At phone width the frame gives its margins back to the copy: the title and
 * lead reflow into fewer lines, which is exactly the room the 0 hint needs to
 * clear the bottom edge.
 */
export default function Devices() {
  return (
    <Slide
      className="max-md:px-6 max-md:pt-9 max-md:pb-6"
      eyebrow="The canvas"
      step="6 of 8"
      title="One design, every device."
      lead={
        <>
          The digit keys re-render frames at real device widths - <Ink>the selection</Ink> when
          one exists, the whole board otherwise. This frame lives at tablet size; press{' '}
          <Ink>1</Ink> through <Ink>4</Ink> with the recipe phones selected and watch a design
          respond instead of a picture stretching.
        </>
      }
      hint={
        <>
          <Keys combo="0" className="mr-2" /> returns every frame to its own size.
        </>
      }
    >
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:gap-5">
        {PAIRS.map((pair, i) => (
          <div key={i} className="flex items-end gap-4 md:contents">
            {pair.map((s) => (
              <div
                key={s.k}
                className="flex flex-col items-center gap-2.5"
                style={{ width: `min(${s.w}px, calc((100% - 1rem) * ${s.share}))` }}
              >
                <div
                  className={cn(
                    'w-full rounded-[10px] border bg-(--node-bg) p-2.5 shadow-(--shadow-node)',
                    s.on ? 'border-brand outline-2 outline-brand -outline-offset-1' : 'border-(--node-brd)',
                  )}
                >
                  <div className="space-y-1.5">
                    <MiniBar w="46%" tone="ink" />
                    <MiniBar />
                    <MiniBlock className="h-7" />
                    <div className="flex justify-end"><MiniButton className="h-[12px] w-[34px]" /></div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Keys combo={s.k} />
                  <span className={cn('text-[12.5px] font-semibold whitespace-nowrap', s.on ? 'text-brand-ink' : 'text-muted-soft')}>{s.label}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Slide>
  )
}
