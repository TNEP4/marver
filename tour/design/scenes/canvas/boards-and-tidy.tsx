import type { ReactNode } from 'react'
import { Ink, Keys, Slide, cn } from '../../../src/components/kit'

export const meta = { title: 'Boards + tidy', viewport: 'laptop' }

/** The product's palette, as a real brand board would carry it. */
const PALETTE = [
  { hex: '#1A1614', name: 'ink' },
  { hex: '#C2410C', name: 'rust' },
  { hex: '#E8A33D', name: 'amber' },
  { hex: '#6B8F71', name: 'sage' },
  { hex: '#EFE7DA', name: 'sand' },
]

/** Three products worth stealing from - each shot reduced to its palette. */
const SHOTS = [
  { bg: '#0D0D11', accent: '#5E6AD2', body: '#22222B' },
  { bg: '#FFFFFF', accent: '#635BFF', body: '#E9ECF5' },
  { bg: '#F5F1EA', accent: '#1A1614', body: '#E2D9CB' },
]

/** One node on the mini board: file name above, the frame's silhouette below. */
function Node({
  label, badge, w, h, on, children,
}: {
  label: string
  badge?: string
  w: number
  h: number
  on?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1" style={{ width: w }}>
      <div className="flex items-center gap-1 px-0.5">
        <span className={cn('truncate text-[9.5px] font-medium', on ? 'text-brand' : 'text-muted-soft')}>
          {label}
        </span>
        {badge && (
          <span className="rounded-[3px] bg-brand-wash px-1 text-[8.5px] font-bold text-brand-ink">{badge}</span>
        )}
      </div>
      <div
        className={cn(
          'overflow-hidden rounded-[6px] border bg-(--node-bg) p-2 shadow-(--shadow-node)',
          on ? 'border-brand outline-1 outline-brand -outline-offset-1' : 'border-(--node-brd)',
        )}
        style={{ height: h }}
      >
        {children}
      </div>
    </div>
  )
}

/** A lane of nodes with its scene name above - the board grammar, drawn. */
function Lane({ scene, col, children }: { scene: string; col?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="px-0.5 text-[10px] font-semibold tracking-[0.04em] text-muted-soft uppercase">{scene}</span>
      <div className={cn('flex', col ? 'flex-col gap-2' : 'items-start gap-2')}>{children}</div>
    </div>
  )
}

/** The whitespace token, drawn: the agent sets the gaps as deliberately as the lanes. */
function Space({ n, down }: { n: number; down?: boolean }) {
  if (down) {
    return (
      <div className="flex items-center gap-1.5 py-1">
        <div className="flex flex-1 items-center gap-1 text-muted-foreground/40">
          <span className="h-2.5 w-px bg-current" />
          <span className="h-px flex-1 bg-current" />
          <span className="h-2.5 w-px bg-current" />
        </div>
        <span className="text-[10px] font-semibold whitespace-nowrap text-muted-soft">space {n}</span>
      </div>
    )
  }
  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5 self-stretch pt-5">
      <span className="text-[10px] font-semibold whitespace-nowrap text-muted-soft">space {n}</span>
      <div className="flex flex-1 flex-col items-center gap-1 pb-2 text-muted-foreground/40">
        <span className="h-px w-2.5 bg-current" />
        <span className="w-px flex-1 bg-current" />
        <span className="h-px w-2.5 bg-current" />
      </div>
    </div>
  )
}

/* ── Frame contents - each node is a use case, not a placeholder ──────────── */

function Moodboard() {
  return (
    <div className="grid h-full grid-cols-3 grid-rows-2 gap-1">
      <div className="rounded-[3px]" style={{ background: 'linear-gradient(140deg,#C2410C,#E8A33D)' }} />
      <div className="col-span-2 rounded-[3px]" style={{ background: '#EFE7DA' }} />
      <div
        className="col-span-2 flex items-center justify-center rounded-[3px] font-serif text-[15px] leading-none"
        style={{ background: '#1A1614', color: '#EFE7DA' }}
      >
        Aa
      </div>
      <div className="rounded-[3px]" style={{ background: '#6B8F71' }} />
    </div>
  )
}

/** The palette as a column: swatch, name, hex - one row per token. */
function Palette() {
  return (
    <div className="flex h-full flex-col justify-between">
      {PALETTE.map((c) => (
        <div key={c.hex} className="flex items-center gap-1.5">
          <span className="size-[8px] shrink-0 rounded-[2px] border border-black/10" style={{ background: c.hex }} />
          <span className="text-[7.5px] font-medium text-foreground/75">{c.name}</span>
          <span className="ml-auto font-mono text-[7px] text-muted-soft">{c.hex}</span>
        </div>
      ))}
    </div>
  )
}

/** Product design inspo: three reference shots, side by side. */
function Inspo() {
  return (
    <div className="grid h-full grid-cols-3 gap-1">
      {SHOTS.map((s) => (
        <div
          key={s.accent}
          className="flex flex-col gap-[3px] overflow-hidden rounded-[3px] border border-black/10 p-[4px]"
          style={{ background: s.bg }}
        >
          <div className="h-[3px] w-[62%] rounded-full" style={{ background: s.accent }} />
          <div className="flex-1 rounded-[2px]" style={{ background: s.body }} />
          <div className="flex items-center gap-[3px]">
            <div className="h-[3px] flex-1 rounded-full" style={{ background: s.body }} />
            <div className="h-[4px] w-[9px] rounded-[1px]" style={{ background: s.accent }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** A mermaid flowchart the way a shaped spec carries it. */
function Flow() {
  const box = { fill: 'var(--surface-2)', stroke: 'var(--border)' }
  return (
    <svg viewBox="0 0 384 76" className="h-full w-full text-muted-foreground" aria-hidden>
      <defs>
        <marker id="fl-ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
        </marker>
      </defs>
      <g strokeWidth="1" markerEnd="url(#fl-ar)" stroke="currentColor" fill="none" opacity="0.55">
        <path d="M66 29 H90" />
        <path d="M174 29 H196" />
        <path d="M264 29 H280 V11 H292" />
        <path d="M264 29 H280 V51 H292" />
        <path d="M339 62 V70 H134 V44" strokeDasharray="3 3" />
      </g>
      <g {...box} strokeWidth="1">
        <rect x="2" y="18" width="64" height="22" rx="5" />
        <rect x="94" y="18" width="80" height="22" rx="5" />
        <polygon points="200,29 232,9 264,29 232,49" />
        <rect x="296" y="40" width="86" height="22" rx="5" />
      </g>
      <rect x="296" y="0" width="86" height="22" rx="5" fill="var(--brand-wash)" stroke="var(--brand)" strokeWidth="1" />
      <g fontSize="9" textAnchor="middle" fill="currentColor" className="text-foreground/80">
        <text x="34" y="32">brief</text>
        <text x="134" y="32">wireframe</text>
        <text x="232" y="32">review</text>
        <text x="339" y="54">iterate</text>
      </g>
      <text x="339" y="14" fontSize="9" textAnchor="middle" fill="var(--brand-ink)" fontWeight="600">
        promote
      </text>
      <text x="230" y="68" fontSize="7.5" textAnchor="middle" fill="currentColor" opacity="0.7">
        comments
      </text>
    </svg>
  )
}

/** Rendered markdown - the written half of a shaped spec. */
function Doc() {
  return (
    <div className="flex h-full flex-col gap-[5px]">
      <span className="text-[9px] leading-none font-semibold text-foreground/85">Checkout v2 - brief</span>
      <div className="h-[2.5px] w-full rounded-full bg-muted-foreground/20" />
      <div className="h-[2.5px] w-[84%] rounded-full bg-muted-foreground/20" />
      <div className="mt-[3px] flex flex-col gap-[4px] text-[7.5px] leading-none text-muted-soft">
        {['guest checkout - must', 'saved cards - must', 'wallet pay - later'].map((row) => (
          <div key={row} className="flex items-center gap-1.5">
            <span className="size-[3px] shrink-0 rounded-full bg-muted-foreground/50" />
            <span className="truncate">{row}</span>
          </div>
        ))}
      </div>
      <div className="mt-auto border-l-2 border-brand pl-1.5 text-[7.5px] leading-[1.4] text-muted-foreground italic">
        One tap from cart to done.
      </div>
    </div>
  )
}

/** Lo-fi: grey blocks, a crossed placeholder, no color anywhere. */
function Wire({ list = false }: { list?: boolean }) {
  return (
    <div className="flex h-full flex-col gap-1.5 text-muted-foreground">
      <div className="h-[5px] w-[46%] rounded-[2px] bg-current opacity-40" />
      {list ? (
        <div className="flex flex-1 flex-col gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-1 items-center gap-1 rounded-[2px] border border-dashed border-current/35 px-1">
              <span className="h-[7px] w-[7px] shrink-0 rounded-[1px] bg-current opacity-20" />
              <span className="h-[3px] flex-1 rounded-full bg-current opacity-20" />
            </div>
          ))}
        </div>
      ) : (
        <div className="relative flex-1 rounded-[2px] border border-dashed border-current/35">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full opacity-25"
            aria-hidden
          >
            <path d="M0 0 L100 100 M100 0 L0 100" stroke="currentColor" strokeWidth="0.6" fill="none" />
          </svg>
        </div>
      )}
      <div className="h-[3px] w-[72%] rounded-full bg-current opacity-20" />
      <div className="h-[8px] w-[30px] self-end rounded-[2px] border border-current/40" />
    </div>
  )
}

/** The same screen, hi-fi: type, image, brand button. */
function Screen({ cta = true }: { cta?: boolean }) {
  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="h-[4px] w-[45%] rounded-full bg-foreground/70" />
      <div
        className="flex-1 rounded-[3px]"
        style={{ background: 'linear-gradient(150deg,var(--brand-wash),var(--muted))' }}
      />
      <div className="h-[2.5px] w-full rounded-full bg-muted-foreground/20" />
      <div className="h-[2.5px] w-[62%] rounded-full bg-muted-foreground/20" />
      {cta ? (
        <div className="h-[8px] w-[34px] self-end rounded-[3px] bg-brand" />
      ) : (
        <div className="h-[8px] w-[34px] self-end rounded-[3px] border border-good bg-good/15" />
      )}
    </div>
  )
}

export default function BoardsAndTidy() {
  return (
    <Slide
      eyebrow="The canvas"
      step="4 of 4"
      title="Boards are the curation."
      lead={
        <>
          A board is a saved arrangement - which frames, in what composition: the
          inspiration left, the thinking middle, the screens right. Press <Ink>t</Ink> to
          re-tidy <Ink>your view</Ink>; the durable layout - lanes and the space between
          them - lives in a JSON file your agent writes.
        </>
      }
      hint={
        <>
          <Keys combo="t" className="mr-2" /> One card left - every key in one place - then
          the recipe phones are yours to play with.
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* The board: three columns - inspiration, thinking, screens */}
        <div className="rounded-card border border-border bg-surface-2 px-5 py-4">
          <div className="flex items-start gap-4">
            {/* left column - what the work looks up to */}
            <div className="flex shrink-0 flex-col">
              <Lane scene="brand" col>
                <Node label="moodboard.tsx" w={186} h={68}>
                  <Moodboard />
                </Node>
                <Node label="palette.tsx" w={186} h={68}>
                  <Palette />
                </Node>
              </Lane>
              <Space n={1} down />
              <Lane scene="inspiration">
                <Node label="products.tsx" w={186} h={60}>
                  <Inspo />
                </Node>
              </Lane>
            </div>

            <Space n={2} />

            {/* middle column - the thinking */}
            <Lane scene="workflow" col>
              <Node label="flow.tsx" w={300} h={76}>
                <Flow />
              </Node>
              <Node label="brief.tsx" w={300} h={104}>
                <Doc />
              </Node>
            </Lane>

            {/* right column - lo-fi above, hi-fi below */}
            <div className="flex min-w-0 flex-col">
              <Lane scene="wireframes">
                <Node label="cart.tsx" w={152} h={104}>
                  <Wire list />
                </Node>
                <Node label="payment.tsx" w={152} h={104}>
                  <Wire />
                </Node>
                <Node label="done.tsx" w={152} h={104}>
                  <Wire />
                </Node>
              </Lane>
              <Space n={1} down />
              <Lane scene="checkout">
                <Node label="cart.tsx" w={112} h={104}>
                  <Screen />
                </Node>
                <Node label="a-card.tsx" badge="A" w={112} h={104}>
                  <Screen />
                </Node>
                <Node label="b-wallet.tsx" badge="B" w={112} h={104} on>
                  <Screen />
                </Node>
                <Node label="done.tsx" w={112} h={104}>
                  <Screen cta={false} />
                </Node>
              </Lane>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-border pt-2.5">
            <span className="font-mono text-[11px] text-muted-soft">design/boards/checkout-v2.json</span>
            <span className="font-mono text-[11px] whitespace-nowrap text-foreground/70">
              columns: [ {'{'} rows: [ “brand”, space 1, “inspiration” ] {'}'}, space 2, “workflow”,{' '}
              {'{'} rows: [ “wireframes”, space 1, “checkout” ] {'}'} ]
            </span>
          </div>
        </div>
        <p className="text-[14px] leading-[1.5] text-muted-soft">
          Ask for “a board comparing the three checkout directions” and it appears - composed,
          down to the gaps.
        </p>
      </div>
    </Slide>
  )
}
