// Demo frame: deletable. Shows meta, fixtures, data-goto. Styled inline so it works in any repo.
import { fx } from './_fixtures.ts'

export const meta = { title: 'Demo - welcome', viewport: 'mobile' }

const s = {
  wrap: { fontFamily: 'system-ui', minHeight: '100vh', display: 'flex', flexDirection: 'column', padding: 24, gap: 12, background: 'var(--background, #fff)', color: 'var(--foreground, #111)' },
  h: { fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 },
  p: { color: '#667085', margin: 0, lineHeight: 1.5 },
  btn: { marginTop: 'auto', padding: '12px 16px', borderRadius: 8, border: 0, background: '#111', color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer' },
} as const

export default function Welcome() {
  return (
    <div style={s.wrap}>
      <h1 style={s.h}>Hey {fx.user.name.split(' ')[0]} 👋</h1>
      <p style={s.p}>This frame is a plain file: design/scenes/demo/welcome.tsx. Edit it and watch the canvas update. Double-click the frame to interact.</p>
      <button style={s.btn} data-goto="demo/form">Continue → (data-goto)</button>
    </div>
  )
}
