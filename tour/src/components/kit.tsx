/**
 * The tour's visual kit. One slide language for every teaching frame, plus the
 * small vocabulary the frames share: key chips, mini frame-nodes, abstract UI
 * fillers. Everything draws from src/styles/theme.css tokens - both themes free.
 */
import type { CSSProperties, ReactNode } from 'react'

export const cn = (...xs: Array<string | false | null | undefined>) =>
  xs.filter(Boolean).join(' ')

/** The marver mark (ParallelogramDuo - same path as the shell's sidebar). */
export function MarverMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={className} fill="currentColor" aria-hidden>
      <path d="M239.29,59.28l-64.8,144a8,8,0,0,1-7.3,4.72H24a8,8,0,0,1-7.3-11.28l64.8-144A8,8,0,0,1,88.81,48H232A8,8,0,0,1,239.29,59.28Z" opacity=".12" />
      <path d="M245.43,47.31A15.94,15.94,0,0,0,232,40H88.81a16,16,0,0,0-14.59,9.43l-64.8,144A16,16,0,0,0,24,216H167.19a16,16,0,0,0,14.59-9.43l64.8-144A16,16,0,0,0,245.43,47.31ZM167.19,200H24L88.81,56H232Z" />
    </svg>
  )
}

/** The solid mark - what the shell twinkles in the working shimmer matrix. */
export function MarverMarkFill({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 256 256" className={className} style={style} fill="currentColor" aria-hidden>
      <path d="M245.43,47.31A15.94,15.94,0,0,0,232,40H88.81a16,16,0,0,0-14.59,9.43l-64.8,144A16,16,0,0,0,24,216H167.19a16,16,0,0,0,14.59-9.43l64.8-144A16,16,0,0,0,245.43,47.31Z" />
    </svg>
  )
}

/** A keyboard key, as the canvas tooltips draw them. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[26px] min-w-[26px] items-center justify-center rounded-[7px] border border-border bg-surface-2 px-2 text-[13px] font-semibold text-foreground shadow-[0_1px_0_var(--border)]',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** The shift arrow, drawn: the interface font carries no ⇧ glyph, so the
 *  character alone renders as a tofu box on every shortcut chip. */
export function ShiftGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('size-[13px]', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinejoin="round"
      role="img"
      aria-label="Shift"
    >
      <path d="M12 3.8 19.8 11.6h-4.3v6.6H8.5v-6.6H4.2Z" />
    </svg>
  )
}

/** "shift+L" -> chips joined by a quiet plus. */
export function Keys({ combo, className }: { combo: string; className?: string }) {
  const parts = combo.split('+')
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-[12px] text-muted-soft">+</span>}
          <Kbd>{p === 'shift' ? <ShiftGlyph /> : p}</Kbd>
        </span>
      ))}
    </span>
  )
}

/** One shortcut, taught: keys on the left, the action, then what it does. */
export function KeyRow({ combo, action, children }: { combo: string; action: string; children?: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-baseline gap-x-5 gap-y-1">
      <span className="justify-self-start"><Keys combo={combo} /></span>
      <p className="text-[15.5px] leading-[1.5] text-muted-foreground">
        <span className="font-semibold text-foreground">{action}</span>
        {children && <> {children}</>}
      </p>
    </div>
  )
}

/**
 * The slide - every laptop teaching frame wears this. Eyebrow names the board
 * and the step, the headline makes one claim, the lead grounds it, children
 * carry the demonstration, and the hint at the foot points onward.
 */
export function Slide({
  eyebrow, step, title, lead, children, hint, className,
}: {
  eyebrow: string
  step?: string
  title: ReactNode
  lead?: ReactNode
  children?: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex h-full min-h-screen flex-col bg-background px-6 pt-10 pb-8 text-foreground sm:px-10 lg:px-16 lg:pt-14 lg:pb-10', className)}>
      <div className="flex items-center gap-2.5">
        <MarverMark className="size-[18px] text-brand" />
        <span className="text-[13px] font-semibold tracking-[0.08em] text-brand uppercase">{eyebrow}</span>
        {step && <span className="text-[13px] font-medium tracking-[0.02em] text-muted-soft">· {step}</span>}
      </div>
      <h1 className="mt-5 max-w-[24ch] text-[32px] leading-[1.06] font-semibold tracking-[-0.03em] sm:text-[38px] lg:text-[44px]">{title}</h1>
      {lead && (
        <p className="mt-5 max-w-[62ch] text-[18px] leading-[1.55] font-[450] tracking-[-0.01em] text-muted-foreground">{lead}</p>
      )}
      {children && <div className="mt-auto pt-8">{children}</div>}
      {hint && (
        <p className="mt-8 flex items-center gap-2 text-[14px] font-medium text-muted-soft">{hint}</p>
      )}
    </div>
  )
}

/** Accent within a lead: the claim, in ink. */
export function Ink({ children }: { children: ReactNode }) {
  return <span className="font-[550] text-foreground">{children}</span>
}

/* ── The terminal - commands quoted exactly as they are typed ─────────────── */

/** A terminal panel, wearing the same chrome as the file panels. */
export function Term({ title = 'zsh', children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-card border border-border bg-surface-2', className)}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-muted-foreground/30" />
        <span className="font-mono text-[12px] font-medium text-muted-foreground">{title}</span>
      </div>
      <pre className="px-4 py-3.5 font-mono text-[12.5px] leading-[1.75]">{children}</pre>
    </div>
  )
}

/** One typed command: the prompt, the words, an optional aside. */
export function Cmd({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-brand select-none">$</span>
      <span className="min-w-0 text-foreground/90">{children}</span>
      {note && <span className="ml-auto hidden shrink-0 pl-4 text-muted-soft sm:inline">{note}</span>}
    </div>
  )
}

/** What the command printed back. */
export function Out({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('pl-[17px] text-muted-foreground', className)}>{children}</div>
}

/* ── Mini canvas vocabulary - frames that depict the canvas itself ────────── */

const STATE_RING: Record<string, string> = {
  selected: 'border-brand outline-2 outline-brand -outline-offset-1 shadow-[0_0_0_4px_var(--brand-ring),var(--shadow-node)]',
  interact: 'border-interact outline-2 outline-interact -outline-offset-1 shadow-[0_0_0_4px_rgba(219,53,242,0.16),var(--shadow-node)]',
  done: 'border-good outline-2 outline-good -outline-offset-1 shadow-[0_0_0_4px_rgba(36,138,61,0.16),var(--shadow-node)]',
}

/** A frame node as the canvas draws it: title above, card below, state ring. */
export function MiniFrame({
  title, badge, state, children, className,
}: {
  title: string
  badge?: string
  state?: 'selected' | 'interact' | 'done'
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1.5 flex items-baseline gap-2 px-0.5">
        <span className={cn('truncate text-[11.5px] font-semibold', state === 'selected' ? 'text-brand' : state === 'interact' ? 'text-interact-ink' : 'text-muted-foreground')}>{title}</span>
        {badge && <span className="text-[10px] font-medium text-muted-soft">{badge}</span>}
      </div>
      <div
        className={cn(
          'rounded-[10px] border border-(--node-brd) bg-(--node-bg) p-3.5 shadow-(--shadow-node)',
          state && STATE_RING[state],
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** The shell's scattered twinkle beats - each mark keeps its own rhythm. */
const SHIM_DELAYS = Array.from({ length: 12 }, (_, i) => {
  const r = Math.floor(i / 2), c = i % 2
  return ((((r * 7 + c * 13) % 9) / 9) * 0.95).toFixed(2)
})

/**
 * A frame node while Marver works on it - the canvas's real treatment, not a
 * stand-in: blue selected geometry, an orbiting shimmer riding the border, a
 * wave sweeping the content, and marver marks twinkling in the left flank.
 */
export function WorkingFrame({
  title, badge = 'working', children, className,
}: {
  title: string
  badge?: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('relative min-w-0', className)}>
      <div className="mb-1.5 flex items-baseline gap-2 px-0.5">
        <span className="truncate text-[11.5px] font-semibold text-brand">{title}</span>
        {badge && <span className="text-[10px] font-medium text-brand-ink/70">{badge}</span>}
      </div>
      <div className="work-node relative rounded-[10px] bg-(--node-bg) p-3.5">
        {children}
        <div className="work-wave" />
      </div>
      <div className="work-shim" aria-hidden>
        {SHIM_DELAYS.map((d, i) => (
          <MarverMarkFill key={i} style={{ animationDelay: `${d}s` }} />
        ))}
      </div>
    </div>
  )
}

/** Abstract UI fillers - a design without being a design. */
export function MiniBar({ w = 'full', tone, className }: { w?: string; tone?: 'ink' | 'brand'; className?: string }) {
  return (
    <div
      className={cn(
        'h-[7px] rounded-full',
        tone === 'ink' ? 'bg-foreground/70' : tone === 'brand' ? 'bg-brand' : 'bg-muted-foreground/25',
        className,
      )}
      style={{ width: w === 'full' ? '100%' : w }}
    />
  )
}
export function MiniBlock({ className }: { className?: string }) {
  return <div className={cn('rounded-[6px] bg-muted', className)} />
}
export function MiniButton({ className }: { className?: string }) {
  return <div className={cn('h-[18px] w-[54px] rounded-full bg-brand', className)} />
}

/** The glass pill - toolbars and mode controls as the shell draws them. */
export function GlassBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('glass inline-flex w-fit items-center gap-0.5 rounded-full p-[5px]', className)}>
      {children}
    </div>
  )
}
export function GlassBtn({ children, on, className }: { children: ReactNode; on?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[30px] items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-semibold',
        on ? 'bg-brand-wash text-brand-ink' : 'text-glass-ink/65',
        className,
      )}
    >
      {children}
    </span>
  )
}

/* ── Drawn demos - the canvas depicting itself doing the thing ────────────── */

/** The mouse pointer - tip at the top-left, outlined so it reads on any ground. */
export function Cursor({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={cn('absolute', className)} aria-hidden>
      <path
        d="M56 24 L56 196 L98 158 L124 220 L152 208 L126 148 L182 146 Z"
        fill="var(--foreground)"
        stroke="var(--background)"
        strokeWidth={14}
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A small floating key, for keys the picture itself has to name. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'absolute rounded-[6px] border border-border bg-surface px-1.5 py-px text-[10px] font-semibold text-foreground shadow-(--shadow-node)',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Abstract page content at demo scale - a design without being a design. */
export function DemoBars({ tight }: { tight?: boolean }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1">
        <span className="size-[3px] rounded-full bg-brand" />
        <span className="h-[2px] w-[26%] rounded-full bg-brand/50" />
      </div>
      <div className={cn('space-y-[3px]', tight ? 'mt-1.5' : 'mt-2')}>
        <span className="block h-[4px] w-[70%] rounded-full bg-foreground/70" />
        <span className="block h-[4px] w-[44%] rounded-full bg-foreground/70" />
      </div>
      <div className="mt-auto h-[26%] rounded-[3px] bg-muted" />
    </div>
  )
}

const DEMO_RING: Record<string, string> = {
  selected: 'border-brand outline-2 outline-brand -outline-offset-1 shadow-[0_0_0_3px_var(--brand-ring)]',
  interact: 'border-interact outline-2 outline-interact -outline-offset-1 shadow-[0_0_0_3px_rgba(219,53,242,0.18)]',
  comment: 'border-comment outline-2 outline-comment -outline-offset-1 shadow-[0_0_0_3px_rgba(0,136,255,0.18)]',
}

/** A frame node at demo scale: name bar above, card below, state ring. */
export function DemoNode({
  w, h, state, children, className,
}: {
  w: number
  h: number
  state?: 'selected' | 'interact' | 'comment'
  children?: ReactNode
  className?: string
}) {
  return (
    <div style={{ width: w }} className={cn('shrink-0', className)}>
      <div
        className={cn(
          'mb-[5px] h-[3px] rounded-full',
          state === 'selected'
            ? 'w-[58%] bg-brand'
            : state === 'interact'
              ? 'w-[58%] bg-interact'
              : state === 'comment'
                ? 'w-[58%] bg-comment'
                : 'w-[42%] bg-muted-foreground/35',
        )}
      />
      <div
        style={{ height: h }}
        className={cn(
          'rounded-[10px] border bg-(--node-bg) p-2 shadow-(--shadow-node)',
          state ? DEMO_RING[state] : 'border-(--node-brd)',
        )}
      >
        {children ?? <DemoBars />}
      </div>
    </div>
  )
}

/** The well a demo is drawn in - the shell's real dot grid, clipped. */
export function Stage({ h = 142, children, className }: { h?: number; children: ReactNode; className?: string }) {
  return (
    <div
      style={{ height: h }}
      className={cn('canvas-ground relative overflow-hidden rounded-[12px] border border-border', className)}
    >
      {children}
    </div>
  )
}

/** One move: the picture carries it, the chip and the line only name it. */
export function Move({
  combo, keys, action, children, demo, stageH, wide,
}: {
  combo?: string
  keys?: ReactNode
  action: string
  children?: ReactNode
  demo: ReactNode
  stageH?: number
  /** A card that carries a claim rather than a key - bigger title, roomier body. */
  wide?: boolean
}) {
  return (
    <div className="flex flex-col rounded-card border border-border bg-surface-2 p-3">
      <Stage h={stageH}>{demo}</Stage>
      <div className={cn('px-1', wide ? 'mt-4 pb-1' : 'mt-3.5')}>
        {keys ?? (combo ? <Keys combo={combo} /> : null)}
        <h2 className={cn('font-semibold tracking-[-0.015em]', wide ? 'text-[16.5px]' : 'mt-2 text-[14.5px]')}>
          {action}
        </h2>
        {children && (
          <p className={cn('mt-1.5 leading-[1.5] text-muted-foreground', wide ? 'text-[14px]' : 'pb-0.5 text-[13px] leading-[1.45]')}>
            {children}
          </p>
        )}
      </div>
    </div>
  )
}

/** A chat avatar disc - initials or the agent mark, HIG people colors. */
export function Face({ name, hue, agent, className }: { name?: string; hue?: string; agent?: boolean; className?: string }) {
  return (
    <span
      className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold text-white', className)}
      style={{ background: agent ? 'var(--brand)' : hue ?? '#34c759' }}
    >
      {agent ? <MarverMark className="size-4" /> : (name ?? 'Y')[0].toUpperCase()}
    </span>
  )
}

/**
 * The comment thread card as the canvas parks it beside a frame: our glass
 * wearing the selected geometry in comment green. Messages stack inside it -
 * the root ask first, every reply below in the same shape.
 */
export function ThreadCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('thread-card flex flex-col gap-3 rounded-[20px] p-4 text-left', className)}>
      {children}
    </div>
  )
}

/** One message: avatar + name + time, body indented to the name column. */
export function ThreadMsg({
  name, hue, agent, time, children,
}: {
  name?: string
  hue?: string
  agent?: boolean
  time: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-[9px]">
        <Face name={name} hue={hue} agent={agent} className="size-6 text-[10px]" />
        <b className="text-[14px] font-semibold tracking-[-0.01em] text-glass-ink">
          {agent ? 'Marver' : (name ?? 'You')}
        </b>
        <span className="tnum text-[11.5px] text-glass-ink/45">{time}</span>
      </div>
      <p className="pl-[33px] text-[13px] leading-[1.55] text-glass-ink">{children}</p>
    </div>
  )
}

/** An @marver mention in a thread the owner wrote - the live trigger, in blue. */
export function At() {
  return <span className="font-bold text-brand">@marver</span>
}
