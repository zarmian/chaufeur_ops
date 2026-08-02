import type { Metadata, Viewport } from 'next';
import './globals.css';

/**
 * Title and description come from settings in Phase 3. Until then they are
 * deliberately generic — nothing in this codebase names a customer.
 */
export const metadata: Metadata = {
  title: {
    default: 'Operations',
    template: '%s · Operations',
  },
  description: 'Job management for chauffeur and private hire operators',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
