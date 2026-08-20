import type { CSSProperties, ReactNode } from 'react'
import { Ink, MarverMark, Slide, cn } from '../../../src/components/kit'

export const meta = { title: 'A look around', viewport: 'laptop' }

/**
 * The canvas, drawn from the real shell. Every measurement here is lifted from
 * marver's own source (App.tsx + styles.css): the panel is 236px wide with 28px
 * rows and a 24px radius, the pill runs 34px buttons on a 5px inset, frame nodes
 * wear a 28px header strip reading "title · width · theme". The board it depicts
 * is this board - design/boards/welcome.json, five laptop frames in one row.
 */

/* ── The shell's own icons (Phosphor paths, inlined from src/client/shell/icons.tsx) ── */
const Ico = ({ d, size = 14, className, stroke }: { d: string; size?: number; className?: string; stroke?: boolean }) => (
  <svg
    width={size} height={size} viewBox="0 0 256 256" aria-hidden
    className={cn('shrink-0', className)}
    fill={stroke ? 'none' : 'currentColor'}
    stroke={stroke ? 'currentColor' : undefined}
    strokeWidth={stroke ? 16 : undefined}
    strokeLinecap="round" strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
)

const P = {
  cards: 'M184,72H40A16,16,0,0,0,24,88V200a16,16,0,0,0,16,16H184a16,16,0,0,0,16-16V88A16,16,0,0,0,184,72Zm0,128H40V88H184V200ZM232,56V176a8,8,0,0,1-16,0V56H64a8,8,0,0,1,0-16H216A16,16,0,0,1,232,56Z',
  cardsThree: 'M208,88H48a16,16,0,0,0-16,16v96a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V104A16,16,0,0,0,208,88Zm0,112H48V104H208v96ZM48,64a8,8,0,0,1,8-8H200a8,8,0,0,1,0,16H56A8,8,0,0,1,48,64ZM64,32a8,8,0,0,1,8-8H184a8,8,0,0,1,0,16H72A8,8,0,0,1,64,32Z',
  caret: 'M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z',
  frameRect: 'M60,52H196a20,20,0,0,1,20,20V184a20,20,0,0,1-20,20H60a20,20,0,0,1-20-20V72A20,20,0,0,1,60,52Z',
  comment: 'M132,24A100.11,100.11,0,0,0,32,124v84a16,16,0,0,0,16,16h84a100,100,0,0,0,0-200Zm0,184H48V124a84,84,0,1,1,84,84Z',
  columns: 'M104,32H64A16,16,0,0,0,48,48V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,104,32Zm0,176H64V48h40ZM192,32H152a16,16,0,0,0-16,16V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,192,32Zm0,176H152V48h40Z',
  laptop: 'M232,168h-8V72a24,24,0,0,0-24-24H56A24,24,0,0,0,32,72v96H24a8,8,0,0,0-8,8v16a24,24,0,0,0,24,24H216a24,24,0,0,0,24-24V176A8,8,0,0,0,232,168ZM48,72a8,8,0,0,1,8-8H200a8,8,0,0,1,8,8v96H48ZM224,192a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8v-8H224ZM152,88a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h32A8,8,0,0,1,152,88Z',
  sun: 'M120,40V16a8,8,0,0,1,16,0V40a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-16-16A8,8,0,0,0,42.34,53.66Zm0,116.68-16,16a8,8,0,0,0,11.32,11.32l16-16a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l16-16a8,8,0,0,0-11.32-11.32l-16,16A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l16,16a8,8,0,0,0,11.32-11.32ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Zm80,80a8,8,0,0,0-8,8v24a8,8,0,0,0,16,0V216A8,8,0,0,0,128,208Zm112-88H216a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16Z',
  play: 'M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.94V40l143.83,88Z',
  eyeSlash: 'M53.92,34.62A8,8,0,1,0,42.08,45.38L61.32,66.55C25,88.84,9.38,123.2,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208a127.11,127.11,0,0,0,52.07-11.07l22,24.21a8,8,0,1,0,11.84-10.76Zm47.33,75.84,41.67,45.85a32,32,0,0,1-41.67-45.85ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128c4.69-8.79,19.66-33.39,47.35-49.38l18,19.75a48,48,0,0,0,63.66,70l14.73,16.2A112,112,0,0,1,128,192Zm6-95.43a8,8,0,0,1,3-15.72,48.16,48.16,0,0,1,38.77,42.64,8,8,0,0,1-7.22,8.71,6.39,6.39,0,0,1-.75,0,8,8,0,0,1-8-7.26A32.09,32.09,0,0,0,134,96.57Zm113.28,34.69c-.42.94-10.55,23.37-33.36,43.8a8,8,0,1,1-10.67-11.92A132.77,132.77,0,0,0,231,128a133.15,133.15,0,0,0-23.12-30.77C185.67,75.19,158.78,64,128,64a118.37,118.37,0,0,0-19.36,1.57A8,8,0,1,1,106,49.79,134,134,0,0,1,128,48c34.88,0,66.57,13.26,91.66,38.35,18.83,18.83,27.3,37.62,27.65,38.41A8,8,0,0,1,247.31,131.26Z',
}

/** The laser reticle - circle, crosshairs, core (custom, not a single path). */
function LaserIco({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth={16} aria-hidden className="shrink-0">
      <circle cx="128" cy="128" r="56" />
      <path d="M128 24V56M128 200v32M24 128h32M200 128h32" strokeLinecap="round" />
      <circle cx="128" cy="128" r="12" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** The panel/toolbar collapse glyph - outer frame with a filled pill. */
function PanelIco({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden className={cn('shrink-0', className)}>
      <rect x="32" y="48" width="192" height="160" rx="32" fill="none" stroke="currentColor" strokeWidth="16" />
      <rect x="72" y="88" width="48" height="80" rx="24" fill="currentColor" />
    </svg>
  )
}

/* ── Shell parts, at the shell's own measurements ─────────────────────────── */

/** A panel row: 28px tall, 8px radius, 7px gap - boards and scene folders both. */
function Row({ icon, label, count, cur, indent }: {
  icon?: ReactNode
  label: string
  count?: number
  cur?: boolean
  indent?: boolean
}) {
  return (
    <div
      className={cn(
        'mb-px flex h-[28px] items-center gap-[7px] rounded-[8px] pr-2 text-[13px]',
        indent ? 'pl-[31px] font-normal text-glass-ink/60' : 'pl-2 font-medium text-glass-ink',
        cur && 'bg-brand-wash font-semibold text-brand-ink',
      )}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && <span className="tnum text-[11px] font-medium text-glass-ink/40">{count}</span>}
    </div>
  )
}

/** A pill button: 34px tall, fully round, quiet ink until it is on. */
function PillBtn({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <span className={cn('inline-flex h-[34px] items-center justify-center gap-1 rounded-full text-[12px] font-medium text-glass-ink/60', wide ? 'px-2.5' : 'w-[34px]')}>
      {children}
    </span>
  )
}

const Sep = () => <i className="mx-[3px] h-4 w-px bg-glass-brd" />

/** A frame node: header strip inside the card, body below - as Canvas draws it. */
function Node({ title, w, style }: { title: string; w: number; style: CSSProperties }) {
  return (
    <div className="absolute overflow-hidden rounded-[10px] border border-(--node-brd) bg-(--node-bg) shadow-(--shadow-node)" style={style}>
      <div className="flex h-[21px] items-center gap-2 border-b border-(--node-brd) bg-white/55 px-[9px] text-[9px] dark:bg-white/5">
        <span className="truncate font-semibold text-foreground">{title}</span>
        <span className="tnum ml-auto shrink-0 text-foreground/40">{w} · light</span>
      </div>
      <div className="flex h-[119px] flex-col p-[9px]">
        <div className="flex items-center gap-1">
          <span className="size-[4px] rounded-full bg-brand" />
          <span className="h-[3px] w-[24%] rounded-full bg-brand/50" />
        </div>
        <div className="mt-2.5 space-y-[5px]">
          <span className="block h-[6px] w-[68%] rounded-full bg-foreground/70" />
          <span className="block h-[6px] w-[42%] rounded-full bg-foreground/70" />
        </div>
        <div className="mt-2.5 space-y-[4px]">
          <span className="block h-[3px] w-full rounded-full bg-muted-foreground/25" />
          <span className="block h-[3px] w-[82%] rounded-full bg-muted-foreground/25" />
        </div>
        <div className="mt-auto h-[32px] rounded-[4px] bg-muted" />
      </div>
    </div>
  )
}

/** A numbered marker: on the diagram and in the legend, the same disc. */
function Dot({ n, className }: { n: number; className?: string }) {
  return (
    <span className={cn('inline-flex size-[22px] shrink-0 items-center justify-center rounded-full bg-brand text-[12px] font-bold text-white shadow-(--shadow-node)', className)}>
      {n}
    </span>
  )
}

const LEGEND = [
  { n: 1, title: 'The panel', body: <>Every <Ink>board</Ink> (a curated arrangement), every <Ink>scene</Ink> (a folder of related screens), every <Ink>frame</Ink> (one screen, one file). Click anything to fly to it.</> },
  { n: 2, title: 'The toolbar', body: <>Comment, laser, tidy, then devices, theme, zoom, and play. Hover anything for its name and shortcut.</> },
  { n: 3, title: 'The ground', body: <>Frames float on the dot grid - and everything around this frame right now is that same UI.</> },
]

export default function AroundYou() {
  return (
    <Slide
      eyebrow="Welcome"
      step="4 of 5"
      title="A quick look around."
      lead={
        <>
          Three words carry the tool: <Ink>frames</Ink> are screens, <Ink>scenes</Ink> group
          them, <Ink>boards</Ink> arrange them.
        </>
      }
      hint={<>One more frame in this board, then you are driving.</>}
    >
      <div className="flex flex-col items-start gap-10 xl:flex-row">
        {/* The canvas, in miniature - this board, drawn at the shell's measurements. */}
        <div
          data-testid="canvas-mock"
          className="canvas-ground relative h-[440px] w-[760px] max-w-full shrink-0 overflow-x-auto rounded-card border border-border"
        >
          {/* 3 - frames on the ground: welcome.json, five laptop frames in one row */}
          <Node title="Why code-native" w={1280} style={{ left: 268, top: 195, width: 190 }} />
          <Node title="A look around" w={1280} style={{ left: 484, top: 195, width: 190 }} />
          <Node title="Next stop" w={1280} style={{ left: 700, top: 195, width: 190 }} />
          <Dot n={3} className="absolute top-[352px] left-[268px]" />

          {/* 1 - the panel: 236px, 24px radius, 10px inset */}
          <div className="glass absolute top-2.5 bottom-2.5 left-2.5 flex w-[236px] flex-col overflow-hidden rounded-panel p-2.5 text-[13px] text-glass-ink">
            <div className="flex items-center gap-2 pt-0.5 pr-0.5 pb-2 pl-2">
              <MarverMark className="size-[21px] text-brand" />
              <span className="mr-auto truncate text-[15px] font-bold tracking-[-0.01em]">Tour</span>
              <PanelIco size={17} className="text-glass-ink/40" />
            </div>
            <div className="mt-0.5 mb-[5px] px-2.5 text-[11px] font-semibold tracking-[0.02em] text-glass-ink/40">Boards</div>
            <Row icon={<Ico d={P.cards} className="text-brand-ink" />} label="Welcome" cur />
            <Row icon={<Ico d={P.cards} className="mx-px text-glass-ink/40" />} label="Canvas" />
            <Row icon={<Ico d={P.cards} className="mx-px text-glass-ink/40" />} label="Prototype" />
            <Row icon={<Ico d={P.cards} className="mx-px text-glass-ink/40" />} label="Collaborate" />
            <Row icon={<Ico d={P.cards} className="mx-px text-glass-ink/40" />} label="Jam" />
            <Row icon={<Ico d={P.cardsThree} className="mx-px text-glass-ink/40" />} label="All Scenes" />
            <div className="mt-2.5 mb-[5px] px-2.5 text-[11px] font-semibold tracking-[0.02em] text-glass-ink/40">Scenes</div>
            <Row icon={<Ico d={P.caret} size={11} className="mx-[2.5px] text-glass-ink/40" />} label="Welcome" count={5} />
            <Row icon={<Ico d={P.frameRect} size={13} stroke className="opacity-[0.72]" />} label="Hello" indent />
            <Row icon={<Ico d={P.frameRect} size={13} stroke className="opacity-[0.72]" />} label="Drive-it" indent />
            <Row icon={<Ico d={P.frameRect} size={13} stroke className="opacity-[0.72]" />} label="Philosophy" indent />
            <Row icon={<Ico d={P.frameRect} size={13} stroke className="opacity-[0.72]" />} label="Around-you" indent />
            <Row icon={<Ico d={P.frameRect} size={13} stroke className="opacity-[0.72]" />} label="Next-stop" indent />
          </div>
          <Dot n={1} className="absolute top-[13px] left-[256px]" />

          {/* 2 - the toolbar pill: 34px buttons on a 5px inset */}
          <div className="glass absolute top-2.5 right-2.5 flex items-center gap-px rounded-full p-[5px]">
            <PillBtn><Ico d={P.comment} size={16} /></PillBtn>
            <PillBtn><LaserIco size={16} /></PillBtn>
            <PillBtn><Ico d={P.columns} size={16} /></PillBtn>
            <Sep />
            <PillBtn wide><Ico d={P.laptop} size={16} /><Ico d={P.caret} size={11} /></PillBtn>
            <PillBtn wide><Ico d={P.sun} size={16} /><Ico d={P.caret} size={11} /></PillBtn>
            <Sep />
            <PillBtn wide><span className="tnum">18%</span></PillBtn>
            <Sep />
            <PillBtn><Ico d={P.play} size={15} /></PillBtn>
            <PillBtn><Ico d={P.eyeSlash} size={16} /></PillBtn>
            <PillBtn><PanelIco size={17} className="rotate-90" /></PillBtn>
          </div>
          <Dot n={2} className="absolute top-[58px] right-[18px]" />
        </div>

        {/* The legend. */}
        <div className="flex min-w-0 flex-col gap-6 pt-2">
          {LEGEND.map((l) => (
            <div key={l.n} className="flex gap-3.5">
              <Dot n={l.n} className="mt-0.5" />
              <div>
                <h2 className="text-[15px] font-semibold">{l.title}</h2>
                <p className="mt-1 text-[13.5px] leading-[1.5] text-muted-foreground">{l.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Slide>
  )
}
