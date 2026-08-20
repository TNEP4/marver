import { Ink, MiniBlock, MiniFrame, Slide, cn } from '../../../src/components/kit'

export const meta = { title: 'Frames are code', viewport: 'laptop' }

/** The fixture the code on the left names - so the picture really is the file. */
const fx = {
  cart: [
    { name: 'Ridge wallet', variant: 'Titanium · Black', price: '$95.00' },
    { name: 'Aer tech pouch', variant: 'X-Pac · Small', price: '$44.00' },
  ],
}

/** Three marked lines, three marked regions - the same three numbers. */
const SRC: Array<{ t: string; dim?: boolean; g?: number }> = [
  { t: "import { Button } from '@/components/ui'", dim: true },
  { t: '' },
  { t: "export const meta = { title: 'Cart', viewport: 'mobile' }", g: 1 },
  { t: '' },
  { t: 'export default function Cart() {' },
  { t: '  return (' },
  { t: '    <CheckoutLayout>' },
  { t: '      <LineItems items={fx.cart} />', g: 2 },
  { t: '      <Button data-goto="checkout/payment">', g: 3 },
  { t: '        Pay now', g: 3 },
  { t: '      </Button>', g: 3 },
  { t: '    </CheckoutLayout>' },
  { t: '  )' },
  { t: '}' },
]

function Marker({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-[16px] items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white tabular-nums',
        className,
      )}
    >
      {n}
    </span>
  )
}

export default function FramesAreCode() {
  return (
    <Slide
      eyebrow="The canvas"
      step="1 of 4"
      title="Every frame is a file."
      lead={
        <>
          One screen, one <Ink>.tsx</Ink> file, rendered live. Your agent designs by writing
          these files - and because they import your app’s real components, the design work
          IS the app work. This is why handing a canvas to a coding agent works.
        </>
      }
      hint={<>Head right: devices, themes, boards - and at the end of the row, one screen designed three ways.</>}
    >
      <div className="flex flex-col items-start gap-7 lg:flex-row lg:items-center">
        {/* The file */}
        <div className="w-full max-w-[470px] shrink-0 overflow-hidden rounded-card border border-border bg-surface-2">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="size-2.5 rounded-full bg-muted-foreground/30" />
            <span className="font-mono text-[12px] font-medium text-muted-foreground">design/scenes/checkout/cart.tsx</span>
          </div>
          <pre className="px-3 py-3.5 font-mono text-[12px] leading-[1.6]">
            {SRC.map((l, i) => {
              const opens = l.g !== undefined && SRC[i - 1]?.g !== l.g
              const closes = l.g !== undefined && SRC[i + 1]?.g !== l.g
              return (
                <div
                  key={i}
                  className={cn(
                    'flex items-center gap-1.5 px-1',
                    l.g !== undefined && 'bg-brand/[0.07]',
                    opens && 'rounded-t-[5px]',
                    closes && 'rounded-b-[5px]',
                  )}
                >
                  <span className="w-4 shrink-0">{opens && <Marker n={l.g!} />}</span>
                  <span className={l.dim ? 'text-muted-soft' : 'text-foreground/85'}>{l.t || ' '}</span>
                </div>
              )
            })}
          </pre>
        </div>

        {/* The arrow */}
        <div className="hidden shrink-0 flex-col items-center gap-1.5 lg:flex">
          <svg viewBox="0 0 48 24" className="w-11 text-brand" fill="none" aria-hidden>
            <path d="M2 12h40m0 0-8-8m8 8-8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="font-mono text-[10.5px] font-medium tracking-[0.02em] text-muted-soft">on save</span>
        </div>

        {/* The frame it renders */}
        <div className="relative">
          <MiniFrame title="checkout/cart" badge="mobile" state="selected" className="w-[296px]">
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] font-semibold tracking-[-0.015em]">Cart</span>
                <span className="text-[11px] font-medium text-muted-soft">{fx.cart.length} items</span>
              </div>

              {/* 2 - LineItems items={fx.cart} */}
              <div className="relative rounded-[9px] border border-border bg-surface p-2.5">
                <div className="divide-y divide-border">
                  {fx.cart.map((item) => (
                    <div key={item.name} className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
                      <MiniBlock className="size-9 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px] font-semibold tracking-[-0.01em]">{item.name}</p>
                        <p className="truncate text-[11px] text-muted-soft">{item.variant}</p>
                      </div>
                      <span className="text-[12.5px] font-medium tabular-nums text-muted-foreground">{item.price}</span>
                    </div>
                  ))}
                </div>
                <Marker n={2} className="absolute -top-2 -right-2" />
              </div>

              <div className="space-y-1 px-0.5 text-[11.5px] text-muted-foreground">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span className="tabular-nums">$139.00</span>
                </div>
                <div className="flex justify-between">
                  <span>Shipping</span>
                  <span>Free</span>
                </div>
                <div className="flex justify-between pt-1 text-[13px] font-semibold text-foreground">
                  <span>Total</span>
                  <span className="tabular-nums">$139.00</span>
                </div>
              </div>

              {/* 3 - <Button data-goto="checkout/payment">Pay now</Button> */}
              <div className="relative">
                <div className="flex h-9 items-center justify-center rounded-full bg-brand text-[13px] font-semibold text-white">
                  Pay now
                </div>
                <Marker n={3} className="absolute -top-2 -right-2" />
              </div>
            </div>
          </MiniFrame>

          {/* 1 - meta: the name and the device this frame wears */}
          <Marker n={1} className="absolute top-0 right-0" />
        </div>
      </div>
    </Slide>
  )
}
