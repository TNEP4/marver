// The app shell for every scene. Replace the placeholder with your real layout
// (sidebar, nav) once it exists - frames then render inside it automatically.
import type { ReactNode } from 'react'

export default function RootLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
