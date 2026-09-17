import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Docket — decision surface for issue triage',
  description:
    'A non-chat, non-dashboard interface for open-source issue triage, running on the real vercel/next.js backlog.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
