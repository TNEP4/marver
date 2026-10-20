// The Jam V2 gallery (test/jam-ui-browser.test.ts): each presentational component in a real `.sh-app`
// over the canvas ground, in light or dark - `?scene=lane|readback|review|notes|thread|marks&theme=dark`.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/client/shell/styles.css'
import { Lane, type LaneTile } from '../../../src/client/shell/jam-lane.tsx'
import { CaptureBlock, CapturePoint, EdgeRing, FocusPanel, NotesCard, ReadBack, ReviewDetail } from '../../../src/client/shell/jam-panel.tsx'
import { timelineLines } from '../../../src/client/shell/jam-lines.ts'
import type { CaptureRecord } from '../../../src/server/jam/types.ts'

const q = new URLSearchParams(location.search)
const scene = q.get('scene') ?? 'lane'
const dark = q.get('theme') === 'dark'
const many = q.get('many') === '1'

/** A stand-in picture: a frame-like card drawn as an SVG data URL. */
const pic = (label: string, tone: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#fff"/><rect x="24" y="24" width="592" height="44" rx="8" fill="${tone}"/><rect x="24" y="92" width="380" height="16" rx="4" fill="#d4d6de"/><rect x="24" y="120" width="300" height="16" rx="4" fill="#e4e5eb"/><rect x="24" y="170" width="280" height="190" rx="12" fill="#f2f3f7"/><rect x="336" y="170" width="280" height="190" rx="12" fill="#f2f3f7"/><text x="320" y="390" font-family="sans-serif" font-size="13" fill="#9a9caa" text-anchor="middle">${label}</text></svg>`)}`

const TILES: LaneTile[] = [
  { id: 'a', state: 'done', title: 'Footer links', line: 'Done · 2 frames' },
  { id: 'b', state: 'review', title: 'Confirm headline', line: 'Ready to review' },
  { id: 'c', state: 'working', title: 'Plans table wraps on a phone', line: 'Agent working · 1:12' },
  { id: 'd', state: 'queued', title: 'Empty state copy', line: 'Queued · next' },
  { id: 'e', state: 'queued', title: 'Kit buttons: one radius', line: 'Queued · 2nd', exclusive: true },
  { id: 'f', state: 'asks', title: 'Coupon field placement', line: 'Asks you' },
  { id: 'g', state: 'failed', title: 'Tax line in the total', line: 'Failed · Retry' },
  { id: 'h', state: 'kept', title: 'Ideas for the receipt', line: 'Kept, not sent' },
  { id: 'i', state: 'draft', title: 'This card field never says which cards we take', line: 'To confirm' },
]
const MORE: LaneTile[] = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, state: 'done', title: `Earlier capture ${i + 1}`, line: 'Done' }))

const t0 = 1_000_000
const REC: CaptureRecord = {
  format: 'marver.jam.capture', v: 1, id: 'cap-1792305059995-7f3a', context: { canvas: 'tidewell', board: 'pricing' }, view: {}, pictures: ['p-1', 'p-2'],
  timeline: [
    { at: t0, event: 'view', view: { board: 'Pricing', frames: ['pricing/checkout'], viewport: 'laptop', theme: 'light' } },
    { at: t0 + 300, event: 'select', frames: ['pricing/checkout'] },
    { at: t0 + 1000, event: 'words', text: 'this card field never says which cards we take' },
    { at: t0 + 3000, frame: 'pricing/checkout', event: 'pick', point: 1, mode: 'canvas', bundle: { tag: 'input', quote: 'Card number', source: 'design/scenes/pricing/checkout.tsx:62:9' } },
    { at: t0 + 3200, frame: 'pricing/checkout', event: 'picture', id: 'p-1', why: 'pick' },
    { at: t0 + 5000, event: 'note', text: 'We take Visa, Mastercard and Amex - say so under the field' },
    { at: t0 + 6000, event: 'device', frame: 'pricing/checkout', viewport: 'Phone', width: 390, height: 844 },
    { at: t0 + 7000, event: 'theme', theme: 'dark' },
    { at: t0 + 8000, event: 'interact', on: true },
    { at: t0 + 10000, frame: 'pricing/checkout', event: 'click', point: 2, mode: 'interact', bundle: { tag: 'button', quote: 'Pay $153.60', source: 'design/scenes/pricing/checkout.tsx:91:11' } },
    { at: t0 + 11000, event: 'words', text: 'and on a phone, keep Pay pinned to the bottom' },
    { at: t0 + 15000, event: 'copied', what: 'path', frame: 'pricing/checkout' },
    { at: t0 + 16000, event: 'note', text: 'Billing has the same card field' },
    { at: t0 + 17000, frame: 'pricing/checkout', event: 'picture', id: 'p-2', why: 'end' },
  ],
}

function Scene() {
  const [sel, setSel] = useState<string | undefined>(scene === 'lane' ? 'b' : scene === 'review' ? 'b' : scene === 'readback' ? 'i' : undefined)
  const [view, setView] = useState<'both' | 'before' | 'after'>(q.get('view') === 'before' ? 'before' : q.get('view') === 'after' ? 'after' : 'both')
  const [tab, setTab] = useState(0)
  const [more, setMore] = useState(q.get('more') === '1')
  const [draft, setDraft] = useState(q.get('draft') ?? '')
  const recording = scene === 'lane' || scene === 'notes' || scene === 'marks'
    ? { time: '0:14', points: 3, pictures: 1, steps: 5, notes: scene === 'notes' ? 2 : 1, noteOn: scene === 'notes', onNote() {}, onStop() {} } : undefined
  const tiles = [...(many ? MORE : []), ...TILES]
  return (
    <>
      {scene === 'marks' && <><EdgeRing /><CapturePoint x={520} y={300} n={1} /><CapturePoint x={640} y={360} n={2} type="click" /><CapturePoint x={720} y={420} type="hover" /></>}
      {scene === 'readback' && (
        <FocusPanel left={10} width={540}>
          <ReadBack title="This card field never says which cards we take" of={[2, 2]} onPrev={() => {}}
            meta={['0:17', 'Checkout', '2 points', '2 pictures', '2 notes', '5 steps']}
            lines={timelineLines(REC)} agent="Claude Code"
            pictures={[{ id: 'p-1', url: pic('Checkout at pick 1 · laptop', '#0088ff'), caption: <><b>1</b> · Checkout at pick 1 · laptop</> }, { id: 'p-2', url: pic('Checkout at E · phone, dark', '#17171b'), caption: <><b>2</b> · Checkout at E · phone, dark</> }]}
            onConfirm={() => {}} onKeep={() => {}} onDrop={() => {}} onEdit={() => {}} />
        </FocusPanel>
      )}
      {scene === 'review' && (
        <FocusPanel left={10} width={560}>
          <ReviewDetail title="Confirm headline" of={[1, 3]} onNext={() => {}} active={tab} onTab={setTab} view={view} onFlip={setView}
            reply="The headline now reads 'You're all set' and the order number sits under it. Plans had the same wording - named it there for you."
            shots={[{ frame: 'pricing/confirm', before: pic('Confirm - before', '#c9cbd5'), after: pic('Confirm - after', '#34c759') }, { frame: 'pricing/plans', before: pic('Plans - before', '#c9cbd5') }]}
            alsoChanged={['design/scenes/pricing/_kit.tsx']} agent="Claude Code" when="4m" more={more} onMoreOpen={setMore} onMore={() => setMore(false)}
            onGood={() => {}} onLater={() => {}} onOpenThread={() => {}} />
        </FocusPanel>
      )}
      {scene === 'notes' && (
        <NotesCard style={{ position: 'absolute', right: 10, bottom: 'calc(var(--edge) + 58px)', zIndex: 32 }}
          notes={[{ t: '0:05', text: 'We take Visa, Mastercard and Amex - say so under the field' }, { t: '0:11', text: 'Billing has the same card field' }]}
          draft={draft} onDraft={setDraft} onAdd={() => setDraft('')} onClose={() => {}} />
      )}
      {scene === 'thread' && (
        <div className="cm-card" style={{ left: 120, top: 120, position: 'absolute' }}>
          <div className="cm-scroll">
            <header><span className="cm-avatar" style={{ width: 24, height: 24, background: 'hsl(212 55% 45%)' }}>S</span><b>Sam</b><span className="dim">9m</span></header>
            <div className="cm-body"><CaptureBlock id="cap-1792305059995-7f3a" facts="0:19 · 2 points · 2 notes" words="this card field never says which cards we take (note) We take Visa, Mastercard and Amex" /></div>
          </div>
        </div>
      )}
      {(scene === 'lane' || scene === 'readback' || scene === 'review' || scene === 'notes' || scene === 'marks') && (
        <Lane tiles={scene === 'notes' || scene === 'marks' ? TILES.slice(0, 3) : tiles} recording={recording} selected={sel} onOpen={setSel} followEnd={tiles.length} />
      )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <div className={`sh-app${dark ? ' dark' : ''}`} style={{ position: 'fixed', inset: 0, background: 'var(--ground)', backgroundImage: 'radial-gradient(var(--dot) 1px, transparent 1px)', backgroundSize: '20px 20px', colorScheme: dark ? 'dark' : 'light' }}>
    <Scene />
  </div>,
)
