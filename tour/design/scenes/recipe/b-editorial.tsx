export const meta = { title: 'Recipe - editorial', viewport: 'mobile' }

/** The magazine direction: type IS the image, one serif voice, generous air. */

const serif = { fontFamily: 'Georgia, "Iowan Old Style", "Times New Roman", serif' }

const STEPS = [
  'Char the leeks whole, dry pan, high heat.',
  'Toast the rice; deglaze with the wine.',
  'Ladle, stir, repeat - eighteen minutes.',
  'Fold in leeks, parmesan, butter, lemon.',
]

export default function Editorial() {
  return (
    <div className="flex h-full min-h-screen flex-col bg-background px-7 pt-12 pb-8 text-foreground">
      <header className="flex items-baseline justify-between border-b border-foreground/70 pb-2.5">
        <p className="text-[10.5px] font-semibold tracking-[0.24em] uppercase">The Weeknight</p>
        <p className="text-[10.5px] tracking-[0.16em] text-muted-soft uppercase tnum">№ 14 · Dinner</p>
      </header>

      <h1 className="mt-7 text-[45px] leading-[0.98] tracking-[-0.015em]" style={serif}>
        Charred leek
        <br />
        <em className="font-normal italic">risotto</em>
      </h1>

      <p className="mt-5 text-[16px] leading-[1.6] text-muted-foreground">
        <span className="float-left mt-[7px] mr-2 text-[46px] leading-[0.72] font-semibold text-foreground" style={serif}>L</span>
        eeks want fire. Char them until the outer leaves blacken, fold the sweet
        insides through slow-stirred arborio, and finish with lemon sharp enough
        to argue back.
      </p>

      {/* the plate, engraved: one warm band so the page has an image without a raster */}
      <div className="relative mt-7 h-[104px] overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(120%_180%_at_30%_10%,#4c4437,#1a1712)]" />
        <div className="absolute top-1/2 left-1/2 size-[168px] -translate-x-1/2 -translate-y-[46%] rounded-full bg-[radial-gradient(circle_at_38%_30%,#f3ecdc,#d9cdb0_58%,#a89b7e)]" />
        <div className="absolute top-[46%] left-[42%] h-[20px] w-[74px] -translate-y-1/2 -rotate-12 rounded-full bg-[linear-gradient(92deg,#7a934f,#232a1a_52%,#5d7a3b)]" />
        <div
          className="absolute inset-0 mix-blend-soft-light"
          style={{ backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.55) 0 1px, transparent 1px 3px)' }}
        />
      </div>
      <p className="mt-2 text-[11px] leading-[1.4] text-muted-soft italic" style={serif}>
        Above: the leeks, taken further than looks comfortable.
      </p>

      <div className="mt-7 grid grid-cols-3 border-y border-foreground/70 py-4 text-center">
        {[['35', 'minutes'], ['2', 'servings'], ['6', 'ingredients']].map(([n, l], i) => (
          <div key={l} className={i < 2 ? 'border-r border-foreground/15' : ''}>
            <p className="text-[27px] leading-none font-semibold tnum" style={serif}>{n}</p>
            <p className="mt-1.5 text-[10px] tracking-[0.16em] text-muted-soft uppercase">{l}</p>
          </div>
        ))}
      </div>

      <ol className="mt-7 space-y-[15px]">
        {STEPS.map((s, i) => (
          <li key={i} className="flex gap-4 text-[15px] leading-[1.5]">
            <span className="w-[22px] shrink-0 text-[15px] font-semibold text-muted-soft tnum" style={serif}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className="text-foreground/85">{s}</span>
          </li>
        ))}
      </ol>

      <button className="group mt-auto flex h-[54px] cursor-pointer items-center justify-center gap-3 border border-foreground text-[12px] font-semibold tracking-[0.2em] uppercase transition-colors duration-200 hover:bg-foreground hover:text-background focus-visible:ring-2 focus-visible:ring-foreground/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none">
        Begin
        <svg viewBox="0 0 24 24" className="size-4 transition-transform duration-200 group-hover:translate-x-1" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 12h15m0 0-5.5-5.5M19 12l-5.5 5.5" />
        </svg>
      </button>
    </div>
  )
}
