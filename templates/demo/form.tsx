// Demo frame: proves the resize gesture (real breakpoint at 768px) and interact mode (native <dialog>).
import { useRef, useState } from 'react'
import { fx } from './_fixtures.ts'

export const meta = { title: 'Demo - form', viewport: 'desktop' }

export default function Form() {
  const dlg = useRef<HTMLDialogElement>(null)
  const [email, setEmail] = useState(fx.user.email)
  return (
    <div style={{ fontFamily: 'system-ui', minHeight: '100vh', padding: 24 }}>
      <style>{`
        .demo-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px }
        .demo-nav-links { display: flex; gap: 16px }
        .demo-burger { display: none }
        @media (max-width: 768px) {
          .demo-grid { grid-template-columns: 1fr }
          .demo-nav-links { display: none }
          .demo-burger { display: block }
        }
        .demo-card { border: 1px solid #e4e8f0; border-radius: 10px; padding: 16px }
        .demo-in { width: 100%; padding: 10px 12px; border: 1px solid #d4d9e4; border-radius: 8px; font-size: 14px }
        .demo-in:focus { outline: 2px solid #2440c4; outline-offset: 1px }
        .demo-btn { padding: 10px 16px; border-radius: 8px; border: 0; background: #111; color: #fff; font-weight: 600; cursor: pointer }
        .demo-btn:hover { opacity: .85 }
      `}</style>
      <nav style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <span className="demo-burger">☰</span>
        <b>◆ Demo</b>
        <span className="demo-nav-links" style={{ color: '#667085', fontSize: 14 }}><span>Shop</span><span>Journal</span><span>About</span></span>
      </nav>
      <div className="demo-grid">
        {fx.items.map((it) => (
          <div key={it.id} className="demo-card"><b>{it.name}</b><div style={{ color: '#667085' }}>{it.price}</div></div>
        ))}
        <div className="demo-card">
          <label style={{ fontSize: 13, color: '#667085' }}>Email
            <input className="demo-in" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginTop: 6 }} />
          </label>
          <button className="demo-btn" style={{ marginTop: 12 }} onClick={() => dlg.current?.showModal()}>Open dialog</button>
        </div>
      </div>
      <p style={{ color: '#98a2b3', fontSize: 13, marginTop: 20 }}>Drag this frame's edge across 768px - the nav collapses to a burger and the grid drops to one column. Real CSS, real viewport.</p>
      <dialog ref={dlg} style={{ border: '1px solid #e4e8f0', borderRadius: 12, padding: 24, maxWidth: 320 }}>
        <b>It is a real dialog</b>
        <p style={{ color: '#667085', fontSize: 14 }}>Typing, focus, and click all work in interact mode. Press Escape to close it, Escape again to leave interact mode.</p>
        <button className="demo-btn" onClick={() => dlg.current?.close()}>Close</button>
      </dialog>
    </div>
  )
}
