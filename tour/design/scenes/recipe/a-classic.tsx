export const meta = { title: 'Recipe - classic', viewport: 'mobile' }

/** One screen, three directions (see b- and c-). This is the friendly default:
 *  soft cards, warm accent, nothing to argue with. */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const CHIPS = [
  { label: '35 min', d: 'M12 7.5V12l2.8 1.7M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
  { label: 'Serves 2', d: 'M15.5 20v-1.2a3.8 3.8 0 0 0-3.8-3.8H7.3A3.8 3.8 0 0 0 3.5 18.8V20M9.5 4.5a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8ZM20.5 20v-1.2a3.8 3.8 0 0 0-2.9-3.7M16 4.7a3.4 3.4 0 0 1 0 6.6' },
  { label: 'Medium', d: 'M12 3.5c1.1 2.2 2.1 4.5 1.4 5.9-.9-.2-1.6-.9-1.9-2.2-.8 1-1.6 2.4-1.6 4a4.1 4.1 0 0 0 8.2 0c0-4-5-7.7-6.1-7.7Z M6.4 12.6a4.6 4.6 0 0 0-1 2.8 6.6 6.6 0 0 0 13.2 0' },
]

/* the "photo": no rasters on this canvas, so the dish is painted */
const RICE = [
  [40, 34, -18], [55, 40, 24], [46, 52, 8], [62, 56, -32], [35, 48, 40],
  [52, 28, 62], [66, 44, -8], [30, 60, 16], [58, 66, 34], [44, 66, -24],
]
const PEPPER = [[38, 42], [60, 34], [50, 60], [68, 52], [33, 55], [56, 48]]

export default function Classic() {
  return (
    <div className="flex h-full min-h-screen flex-col bg-background text-foreground">
      <div className="relative h-[318px] shrink-0 overflow-hidden">
        {/* warm table, light falling from the upper left */}
        <div className="absolute inset-0 bg-[radial-gradient(120%_95%_at_26%_8%,#54483a_0%,#2f2a22_48%,#14120f_100%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(80%_60%_at_78%_92%,rgba(0,0,0,0.55),transparent_70%)]" />

        {/* bowl */}
        <div className="absolute top-[54%] left-1/2 size-[236px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_34%_26%,#fffdf8_0%,#f0ece3_46%,#d3ccbe_76%,#a79f8e_100%)] shadow-[0_26px_54px_-14px_rgba(0,0,0,0.72)]" />
        <div
          className="absolute top-[54%] left-1/2 size-[196px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: 'radial-gradient(circle at 42% 34%, #f2e9d0 0%, #e2d3a9 56%, #c3b184 100%)',
            boxShadow: 'inset 0 6px 18px rgba(120,100,60,0.28)',
          }}
        />

        {/* rice */}
        {RICE.map(([x, y, r], i) => (
          <span
            key={i}
            className="absolute h-[7px] w-[11px] rounded-full bg-[#fbf4de]/85"
            style={{ left: `${x}%`, top: `${y}%`, transform: `rotate(${r}deg)` }}
          />
        ))}

        {/* charred leeks */}
        <div className="absolute top-[44%] left-[41%] h-[27px] w-[86px] -rotate-[14deg] rounded-full bg-[linear-gradient(96deg,#7d9a55_0%,#4c6a33_38%,#1e2417_62%,#496331_100%)] shadow-[0_6px_14px_-4px_rgba(0,0,0,0.55)]" />
        <div className="absolute top-[57%] left-[47%] h-[21px] w-[70px] rotate-[9deg] rounded-full bg-[linear-gradient(88deg,#6f9049_0%,#20281a_44%,#5b7b3c_100%)] shadow-[0_6px_14px_-4px_rgba(0,0,0,0.5)]" />

        {/* parmesan shavings + cracked pepper */}
        <span className="absolute top-[50%] left-[57%] h-[5px] w-[26px] rotate-[26deg] rounded-[2px] bg-[#fffaea]/90" />
        <span className="absolute top-[62%] left-[38%] h-[5px] w-[22px] -rotate-[16deg] rounded-[2px] bg-[#fff7e2]/85" />
        <span className="absolute top-[38%] left-[50%] h-[4px] w-[19px] rotate-[8deg] rounded-[2px] bg-[#fffaea]/80" />
        {PEPPER.map(([x, y], i) => (
          <span key={i} className="absolute size-[3px] rounded-full bg-[#241d12]/75" style={{ left: `${x}%`, top: `${y}%` }} />
        ))}

        {/* chrome */}
        <div className="absolute inset-x-0 top-0 h-24 bg-[linear-gradient(180deg,rgba(0,0,0,0.42),transparent)]" />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-4">
          <button
            aria-label="Back"
            className="grid size-9 cursor-pointer place-items-center rounded-full bg-black/35 text-white backdrop-blur-md transition-colors duration-150 hover:bg-black/55 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
          >
            <svg viewBox="0 0 24 24" className="size-[18px]" {...stroke} aria-hidden><path d="m14.5 6-6 6 6 6" /></svg>
          </button>
          <button
            aria-label="Save recipe"
            className="grid size-9 cursor-pointer place-items-center rounded-full bg-black/35 text-white backdrop-blur-md transition-colors duration-150 hover:bg-black/55 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
          >
            <svg viewBox="0 0 24 24" className="size-[18px]" {...stroke} aria-hidden><path d="M6.5 4.5h11v15l-5.5-4-5.5 4z" /></svg>
          </button>
        </div>
        <div className="absolute inset-x-0 bottom-0 h-16 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.3))]" />
      </div>

      <div className="relative -mt-7 flex flex-1 flex-col rounded-t-[26px] bg-background px-6 pt-3 shadow-[0_-12px_30px_-18px_rgba(0,0,0,0.45)]">
        <span className="mx-auto h-1 w-9 rounded-full bg-muted-foreground/25" />

        <p className="mt-5 text-[12px] font-semibold tracking-[0.09em] text-amber-700 uppercase dark:text-amber-400">
          Dinner · Vegetarian
        </p>
        <h1 className="mt-2 text-[28px] leading-[1.12] font-bold tracking-[-0.022em]">Charred leek risotto</h1>

        <div className="mt-4 flex gap-2">
          {CHIPS.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground">
              <svg viewBox="0 0 24 24" className="size-[14px] shrink-0 opacity-70" {...stroke} aria-hidden><path d={c.d} /></svg>
              {c.label}
            </span>
          ))}
        </div>

        <h2 className="mt-7 text-[13px] font-bold tracking-[0.04em] text-muted-soft uppercase">Ingredients</h2>
        <ul className="mt-1 divide-y divide-border">
          {['2 leeks, halved and charred', '220 g arborio rice', '90 ml dry white wine', '40 g parmesan, plus more', 'Butter, lemon, black pepper'].map((it) => (
            <li key={it} className="group flex cursor-pointer items-center gap-3 py-[11px] text-[15px] leading-[1.35]">
              <span className="grid size-[19px] shrink-0 place-items-center rounded-full border-[1.5px] border-border text-transparent transition-colors duration-150 group-hover:border-amber-600 group-hover:text-amber-600">
                <svg viewBox="0 0 24 24" className="size-[11px]" {...stroke} strokeWidth={3} aria-hidden><path d="m5 12.5 4.5 4.5L19 7" /></svg>
              </span>
              <span className="text-foreground/85 transition-colors duration-150 group-hover:text-foreground">{it}</span>
            </li>
          ))}
        </ul>

        <button className="mt-auto mb-7 h-[54px] cursor-pointer rounded-full bg-amber-600 text-[16px] font-bold tracking-[-0.01em] text-white shadow-[0_10px_24px_-10px_rgba(180,83,9,0.85)] transition-[background-color,transform] duration-150 hover:bg-amber-700 focus-visible:ring-2 focus-visible:ring-amber-600/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none active:scale-[0.985]">
          Start cooking
        </button>
      </div>
    </div>
  )
}
