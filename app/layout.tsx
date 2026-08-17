import type { Metadata, Viewport } from 'next';
import { Fira_Code, Fira_Sans } from 'next/font/google';
import { cookies } from 'next/headers';
import { ThemeProvider } from '@/components/theme-provider';
import { brandAssetSrc } from '@/lib/branding';
import { SURFACE_DARK, SURFACE_LIGHT } from '@/lib/colour';
import { getBranding } from '@/lib/branding-store';
import { getLocaleConfig } from '@/lib/locale-store';
import { brandStyleSheet } from '@/lib/theme';
import {
  parseThemePreference,
  THEME_COOKIE,
  THEME_SCRIPT,
  themeClassFor,
} from '@/lib/theme-preference';
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

/**
 * Self-hosted at build time by `next/font`, so there is no request to
 * fonts.googleapis.com on any page load — one fewer third party between an
 * operator and the dispatch board, and no flash of unstyled text.
 *
 * Only the weights actually used are fetched. `display: swap` means text is
 * readable immediately in the fallback and reflows once, rather than being
 * invisible while a font downloads.
 */
const firaSans = Fira_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const firaCode = Fira_Code({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

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
  const [branding, locale, cookieStore] = await Promise.all([
    getBranding(),
    getLocaleConfig(),
    cookies(),
  ]);

  // Resolved here so an explicit choice is already on `<html>` in the markup
  // the server sends — there is nothing to correct after hydration, so no
  // flash. `system` is the one case the server cannot answer, and
  // `THEME_SCRIPT` settles that before the first paint.
  const themePreference = parseThemePreference(
    cookieStore.get(THEME_COOKIE)?.value,
  );
  const themeClass = themeClassFor(themePreference);

  // One `<style>` element carrying only the tokens that differ from the
  // stylesheet's neutral defaults. Inline rather than a generated file
  // because it has to change the moment a setting is saved, with no rebuild.
  const themeCss = brandStyleSheet(branding);

  return (
    <html
      lang={locale.locale}
      className={`${firaSans.variable} ${firaCode.variable}${themeClass ? ` ${themeClass}` : ''}`}
      data-theme={themePreference}
      suppressHydrationWarning
    >
      <head>
        {/*
          Before anything paints. On `system` this is what reads the machine's
          preference — the server cannot — and it has to be blocking and
          inline, because a deferred script runs after the first paint and the
          page would flash the wrong theme on every single load.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
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
        <ThemeProvider preference={themePreference}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
