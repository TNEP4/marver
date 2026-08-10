// Demo frame: an error state, dark-styled. Sibling frames = states (spec convention).
export const meta = { title: 'Demo - error state', viewport: 'mobile' }

export default function DarkError() {
  return (
    <div style={{ fontFamily: 'system-ui', minHeight: '100vh', background: '#12151f', color: '#e7eaf2', padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <b style={{ fontSize: 16 }}>‹ Checkout</b>
      <div style={{ background: '#2a1215', border: '1px solid #5c2320', borderRadius: 8, padding: '12px 14px', color: '#f0776b', fontSize: 14, lineHeight: 1.5 }}>
        <b style={{ display: 'block', color: '#f9a8a0' }}>Card declined</b>
        Your bank rejected the charge. No money moved.
      </div>
      <button data-goto="demo/form" style={{ marginTop: 'auto', padding: '12px 16px', borderRadius: 8, border: '1px solid #363d4f', background: 'transparent', color: '#e7eaf2', fontWeight: 600, cursor: 'pointer' }}>
        Try another card
      </button>
    </div>
  )
}
