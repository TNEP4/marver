export const meta = { title: 'Recipe - brutalist', viewport: 'mobile' }

/** The loud direction: one look, deliberately theme-proof - hard borders,
 *  system mono, a yellow that does not ask permission. */

const STACK = [
  ['LEEKS [CHARRED]', '×2'],
  ['ARBORIO', '220 G'],
  ['WHITE WINE', '90 ML'],
  ['PARMESAN', '40 G+'],
  ['BUTTER / LEMON / PEPPER', 'TO TASTE'],
]

export default function Brutalist() {
  return (
    <div className="flex h-full min-h-screen flex-col bg-[#f2f000] font-mono text-black">
      <div className="flex items-center justify-between border-b-4 border-black px-5 py-3.5 text-[11.5px] font-bold tracking-[0.1em]">
        <span>RCP-014</span>
        <span
          className="h-3 flex-1 mx-3 border-y-2 border-black"
          style={{ backgroundImage: 'repeating-linear-gradient(135deg, #000 0 3px, transparent 3px 7px)' }}
          aria-hidden
        />
        <span>DINNER / VEG</span>
      </div>

      <div className="flex border-b-4 border-black">
        <h1 className="flex-1 px-5 py-6 text-[36px] leading-[0.96] font-bold tracking-[-0.03em] uppercase">
          Charred<br />leek<br />risotto
        </h1>
        <div className="grid w-[74px] place-items-center border-l-4 border-black bg-black text-[44px] leading-none font-bold text-[#f2f000] tnum">
          14
        </div>
      </div>

      <div className="grid grid-cols-3 border-b-4 border-black text-center">
        {[['35', 'MIN'], ['2', 'SRV'], ['MED', 'DIFF']].map(([n, l], i) => (
          <div key={l} className={`py-3.5 ${i < 2 ? 'border-r-4 border-black' : ''}`}>
            <p className="text-[23px] leading-none font-bold tnum">{n}</p>
            <p className="mt-1.5 text-[9.5px] font-bold tracking-[0.14em]">{l}</p>
          </div>
        ))}
      </div>

      <div className="flex-1 px-5 pt-4">
        <p className="text-[11.5px] font-bold tracking-[0.1em]">STACK →</p>
        <ul className="mt-2">
          {STACK.map(([item, qty]) => (
            <li key={item} className="flex items-baseline gap-2 border-b-2 border-dotted border-black/45 py-[9px] text-[13px] font-bold">
              <span className="uppercase">{item}</span>
              <span className="flex-1" />
              <span className="tnum">{qty}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 border-4 border-black bg-black px-3.5 py-3 text-[12px] leading-[1.5] font-bold text-[#f2f000] uppercase">
          Char dry. Toast rice. Wine. Ladle 18 min. Fold. Eat standing up.
        </div>
      </div>

      <button className="group mt-5 flex h-[62px] w-full cursor-pointer items-center justify-between border-t-4 border-black bg-black px-5 text-[17px] font-bold tracking-[0.1em] text-[#f2f000] uppercase transition-colors duration-100 hover:bg-[#f2f000] hover:text-black focus-visible:outline-4 focus-visible:-outline-offset-8 focus-visible:outline-[#f2f000]">
        Cook it
        <span className="transition-transform duration-100 group-hover:translate-x-1.5">→</span>
      </button>
    </div>
  )
}
