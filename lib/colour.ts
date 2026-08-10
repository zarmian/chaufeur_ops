/**
 * Brand colour maths: hex in, a coherent palette out.
 *
 * An operator picks one colour. They should not also have to pick a hover
 * shade, an active shade, a focus ring and a legible foreground — and if they
 * did, most installs would end up with a button whose label cannot be read
 * against it.
 *
 * Everything is expressed as an HSL triplet string (`"222 47% 20%"`) because
 * that is the form `app/globals.css` already stores its tokens in. Writing
 * `--primary: 14 90% 48%` on `:root` makes `bg-primary` follow the
 * configured colour with no component change anywhere.
 *
 * Imports nothing. It is reached from Client Components.
 */

/**
 * Starting points for the branding screen's colour pickers.
 *
 * They live here rather than in the component because component code may not
 * contain hex literals — that is the lint rule which keeps theming
 * configurable. The branding screen is the one place where a hex value is the
 * subject matter rather than a style, and this is where those values belong.
 *
 * Neither is a brand. They are a neutral blue and a neutral red, offered so
 * the picker opens somewhere sensible rather than on black.
 */
export const SUGGESTED_PRIMARY = '#1f6feb';
export const SUGGESTED_ACCENT = '#d64545';

/** What the native colour input shows when the typed value is unparseable. */
export const PICKER_FALLBACK = '#000000';

/**
 * The light theme's page background, per `--background` in `globals.css`.
 *
 * The surface a brand colour sits on when it is used as *text* — a link, an
 * active nav label, a figure. That pairing is the one that actually fails:
 * against its own derived foreground a brand always passes, because
 * `readableForeground` picks the better of black and white and the worst case
 * for that is about 4.6:1. Checking the fill would be reassurance dressed up
 * as a warning.
 */
export const LIGHT_SURFACE = '#ffffff';

/**
 * The page background in each scheme, as hex.
 *
 * `--background` in `globals.css` is authoritative and these mirror it:
 * `hsl(210 40% 98%)` and `hsl(222 47% 8%)`. Kept here because `<meta
 * name="theme-color">` takes a colour, not a custom property, and component
 * code may not hold hex literals — that rule exists to keep *brand* colours
 * configurable, and these are the fixed neutral surfaces underneath them.
 *
 * If `--background` ever changes, change these with it: their whole job is to
 * stop the phone's browser chrome being a different colour from the page.
 */
export const SURFACE_LIGHT = '#f8fafc';
export const SURFACE_DARK = '#0b111e';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Normalise `#abc`, `abc`, `#AABBCC` to `#aabbcc`. Null if it is not a hex colour. */
export function normaliseHex(input: string): string | null {
  const match = HEX.exec(input.trim());
  if (!match) return null;
  const body = match[1]!.toLowerCase();
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  return `#${full}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const normalised = normaliseHex(hex);
  if (!normalised) return null;
  return {
    r: parseInt(normalised.slice(1, 3), 16),
    g: parseInt(normalised.slice(3, 5), 16),
    b: parseInt(normalised.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sn = s / 100;
  const ln = l / 100;

  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));

  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  const m = ln - c / 2;
  return {
    r: (rgb[0] + m) * 255,
    g: (rgb[1] + m) * 255,
    b: (rgb[2] + m) * 255,
  };
}

export function hexToHsl(hex: string): Hsl | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHsl(rgb) : null;
}

export function hslToHex(hsl: Hsl): string {
  return rgbToHex(hslToRgb(hsl));
}

/**
 * The CSS custom-property form: `"14 90% 48%"`.
 *
 * Bare numbers rather than `hsl(...)` so Tailwind can wrap them with its own
 * alpha channel — `hsl(var(--primary) / 0.5)` only works on a triplet.
 */
export function toHslTriplet(hsl: Hsl): string {
  const round = (n: number) => Math.round(n * 10) / 10;
  return `${round(hsl.h)} ${round(hsl.s)}% ${round(hsl.l)}%`;
}

export function hexToHslTriplet(hex: string): string | null {
  const hsl = hexToHsl(hex);
  return hsl ? toHslTriplet(hsl) : null;
}

// ------------------------------------------------------------- contrast

/** Relative luminance, per WCAG 2.1. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function contrastRatioHex(a: string, b: string): number | null {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return null;
  return contrastRatio(ra, rb);
}

/** WCAG AA: 4.5:1 for body text, 3:1 for large text and UI components. */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

export interface ContrastCheck {
  ratio: number;
  passesAA: boolean;
  passesAALarge: boolean;
  message: string | null;
}

/**
 * Whether a foreground is legible on a background.
 *
 * Reported rather than enforced. A brand colour is the customer's decision
 * and refusing to save it would mean the product arguing with the person who
 * owns the brand — but they should know before they find out from a user who
 * cannot read the button.
 */
export function checkContrast(
  foregroundHex: string,
  backgroundHex: string,
): ContrastCheck | null {
  const ratio = contrastRatioHex(foregroundHex, backgroundHex);
  if (ratio === null) return null;

  const rounded = Math.round(ratio * 100) / 100;
  const passesAA = ratio >= AA_NORMAL;
  const passesAALarge = ratio >= AA_LARGE;

  return {
    ratio: rounded,
    passesAA,
    passesAALarge,
    message: passesAA
      ? null
      : passesAALarge
        ? `Contrast is ${rounded}:1 — readable at large sizes but below the ${AA_NORMAL}:1 WCAG AA needs for ordinary text.`
        : `Contrast is only ${rounded}:1. WCAG AA needs ${AA_NORMAL}:1, so text on this colour will be hard to read.`,
  };
}

/**
 * Black or white, whichever is more legible on the given colour.
 *
 * Not a luminance threshold guess: both are measured and the better one wins,
 * so a mid-tone brand colour lands the right way round rather than sitting on
 * whichever side of an arbitrary cut-off it happens to fall.
 */
export function readableForeground(backgroundHex: string): string {
  const background = hexToRgb(backgroundHex);
  if (!background) return '#ffffff';

  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };

  return contrastRatio(white, background) >= contrastRatio(black, background)
    ? '#ffffff'
    : '#000000';
}

// ------------------------------------------------------------- shades

/** Lighten (positive) or darken (negative) by a percentage of lightness. */
export function shift(hsl: Hsl, byPercent: number): Hsl {
  return { ...hsl, l: Math.max(0, Math.min(100, hsl.l + byPercent)) };
}

export interface Palette {
  /** The colour itself. */
  base: string;
  baseForeground: string;
  hover: string;
  active: string;
  /** A desaturated, pale version for backgrounds and subtle fills. */
  muted: string;
  mutedForeground: string;
  ring: string;
}

/**
 * A coherent palette from one hex value, as HSL triplets.
 *
 * Hover goes *away* from the midpoint rather than always darker: a dark navy
 * brand needs a lighter hover to register at all, and a bright yellow needs a
 * darker one. Always darkening would make half of all brands look broken.
 */
export function buildPalette(hex: string): Palette | null {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;

  const dark = hsl.l < 50;
  const step = dark ? 6 : -6;

  const muted: Hsl = {
    h: hsl.h,
    s: Math.max(12, hsl.s * 0.35),
    l: dark ? 94 : 92,
  };

  return {
    base: toHslTriplet(hsl),
    baseForeground: toHslTriplet(
      hexToHsl(readableForeground(hex)) ?? { h: 0, s: 0, l: 100 },
    ),
    hover: toHslTriplet(shift(hsl, step)),
    active: toHslTriplet(shift(hsl, step * 2)),
    muted: toHslTriplet(muted),
    // Readable text on the pale fill: the base colour taken well down, so it
    // stays recognisably the brand rather than reverting to grey.
    mutedForeground: toHslTriplet({
      h: hsl.h,
      s: Math.max(20, hsl.s * 0.6),
      l: 28,
    }),
    ring: toHslTriplet(hsl),
  };
}
