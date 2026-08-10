import type { Metadata, Viewport } from 'next';
import { brandAssetSrc } from '@/lib/branding';
import { SURFACE_DARK, SURFACE_LIGHT } from '@/lib/colour';
import { getBranding } from '@/lib/branding-store';
import { getLocaleConfig } from '@/lib/locale-store';
import { brandStyleSheet } from '@/lib/theme';
import './globals.css';

/**
 * Title, language and theme all come from settings.
 *
 * Nothing in this codebase names a customer — the trading name is read from
 * `Setting` and falls back to something neutral, so a fresh install is
 * coherent before anyone has configured anything. CI greps for the first
 * customer's name and fails if it appears outside seed fixtures.
 */
export async function generateMetadata(): Promise<Metadata> {
  const branding = await getBranding();

  return {
    title: {
      default: branding.tradingName,
      template: `%s · ${branding.tradingName}`,
    },
    description: 'Job management for chauffeur and private hire operators',
    // An operations system has nothing to gain from being indexed, and the
    // job references in its URLs have something to lose.
    robots: { index: false, follow: false },
    ...(branding.faviconUrl
      ? { icons: { icon: brandAssetSrc('faviconUrl', branding.faviconUrl)! } }
      : {}),
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /**
   * Declared rather than left to the browser to guess.
   *
   * `darkMode: ['class']` means the theme is ours, but scrollbars, native
   * selects, date pickers and form controls are the browser's — and without
   * this they stay light while everything around them is dark. Both schemes
   * are listed because the install can be either.
   */
  colorScheme: 'light dark',
  /**
   * Matched to `--background` in each scheme, so the browser chrome on a
   * phone is the same colour as the page rather than a band above it.
   */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: SURFACE_LIGHT },
    { media: '(prefers-color-scheme: dark)', color: SURFACE_DARK },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [branding, locale] = await Promise.all([
    getBranding(),
    getLocaleConfig(),
  ]);

  // One `<style>` element carrying only the tokens that differ from the
  // stylesheet's neutral defaults. Inline rather than a generated file
  // because it has to change the moment a setting is saved, with no rebuild.
  const themeCss = brandStyleSheet(branding);

  return (
    <html lang={locale.locale} suppressHydrationWarning>
      <head>
        {themeCss ? (
          <style
            id="brand-theme"
            // Built from validated hex values by `lib/theme.ts`, which drops
            // anything it cannot parse rather than emitting it. No part of
            // this string is caller-controlled text.
            dangerouslySetInnerHTML={{ __html: themeCss }}
          />
        ) : null}
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
