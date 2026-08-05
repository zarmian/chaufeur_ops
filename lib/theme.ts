import { buildPalette } from './colour';
import type { Branding } from './branding';

/**
 * Brand colours as CSS custom properties.
 *
 * `app/globals.css` already stores every theme token as an HSL triplet behind
 * a custom property, so overriding `--primary` on `:root` makes `bg-primary`
 * follow the configured colour with no component change anywhere. That is the
 * whole mechanism — there is no per-component theming and no hex literal in
 * component code.
 *
 * Only the brand tokens are overridden. The semantic states stay put: a red
 * that means "expired" must not become a customer's brand colour, or the
 * compliance screen stops meaning anything.
 *
 * Returns an empty string when nothing is configured, so a fresh install
 * renders the neutral default theme from the stylesheet untouched.
 */
export function brandThemeCss(branding: Pick<Branding, 'primaryColour' | 'accentColour'>): string {
  const declarations: string[] = [];

  if (branding.primaryColour) {
    const palette = buildPalette(branding.primaryColour);
    if (palette) {
      declarations.push(
        `--primary:${palette.base}`,
        `--primary-foreground:${palette.baseForeground}`,
        `--primary-hover:${palette.hover}`,
        `--primary-active:${palette.active}`,
        // The focus ring follows the brand: it is the one piece of chrome
        // that appears on every interactive element.
        `--ring:${palette.ring}`,
      );
    }
  }

  if (branding.accentColour) {
    const palette = buildPalette(branding.accentColour);
    if (palette) {
      declarations.push(
        // Accent is a surface rather than a fill — the muted shade is what
        // hover states and highlighted rows actually use.
        `--accent:${palette.muted}`,
        `--accent-foreground:${palette.mutedForeground}`,
        `--accent-solid:${palette.base}`,
        `--accent-solid-foreground:${palette.baseForeground}`,
      );
    }
  }

  if (declarations.length === 0) return '';
  return `:root{${declarations.join(';')}}`;
}

/**
 * The same, for the dark theme.
 *
 * A brand colour chosen against white is usually too dark to read against a
 * near-black background, so the base is lifted rather than reused as-is. The
 * hue and saturation are the brand; the lightness is what has to move.
 */
export function brandThemeDarkCss(
  branding: Pick<Branding, 'primaryColour' | 'accentColour'>,
): string {
  const declarations: string[] = [];

  if (branding.primaryColour) {
    const palette = buildPalette(branding.primaryColour);
    if (palette) {
      const [h, s, l] = palette.base.split(' ');
      const lightness = Number(l?.replace('%', '') ?? 50);
      // Lifted to at least 55% so it reads against a dark surface, but never
      // pushed down if the brand is already light.
      const lifted = Math.max(lightness, 55);
      declarations.push(
        `--primary:${h} ${s} ${lifted}%`,
        // Dark text on a lifted colour: at 55%+ lightness white would fail.
        `--primary-foreground:${h} 40% 10%`,
        `--ring:${h} ${s} ${lifted}%`,
      );
    }
  }

  if (declarations.length === 0) return '';
  return `.dark{${declarations.join(';')}}`;
}

/** Both blocks, ready to drop into a `<style>` element. */
export function brandStyleSheet(
  branding: Pick<Branding, 'primaryColour' | 'accentColour'>,
): string {
  return [brandThemeCss(branding), brandThemeDarkCss(branding)]
    .filter(Boolean)
    .join('');
}
