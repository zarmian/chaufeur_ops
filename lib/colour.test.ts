import { describe, expect, it } from 'vitest';
import {
  AA_NORMAL,
  buildPalette,
  checkContrast,
  contrastRatioHex,
  hexToHsl,
  hexToHslTriplet,
  hexToRgb,
  hslToHex,
  normaliseHex,
  readableForeground,
  rgbToHsl,
  toHslTriplet,
} from './colour';

/**
 * The brand colour is the one setting a customer definitely has an opinion
 * about, and the one most likely to produce an unreadable button. The cases
 * pinned here are the ones that would ship a broken-looking install: a
 * round-trip that drifts, a hover shade that vanishes on a dark brand, and a
 * foreground picked by guesswork rather than measurement.
 */

describe('normaliseHex', () => {
  it('expands the three-digit form', () => {
    expect(normaliseHex('#abc')).toBe('#aabbcc');
    expect(normaliseHex('abc')).toBe('#aabbcc');
  });

  it('lower-cases and adds the hash', () => {
    expect(normaliseHex('AABBCC')).toBe('#aabbcc');
    expect(normaliseHex('  #AABBCC  ')).toBe('#aabbcc');
  });

  it('refuses anything that is not a hex colour', () => {
    for (const bad of ['', 'rebeccapurple', '#12', '#12345', '#gggggg', 'rgb(1,2,3)']) {
      expect(normaliseHex(bad), bad).toBeNull();
    }
  });
});

describe('conversion', () => {
  it('round-trips the primaries', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000']) {
      const hsl = hexToHsl(hex);
      expect(hsl).not.toBeNull();
      expect(hslToHex(hsl!)).toBe(hex);
    }
  });

  it('round-trips an arbitrary brand colour without drifting', () => {
    // A drift of one step per save would walk the colour away over time.
    const hex = '#1f6feb';
    const once = hslToHex(hexToHsl(hex)!);
    const twice = hslToHex(hexToHsl(once)!);
    expect(once).toBe(hex);
    expect(twice).toBe(hex);
  });

  it('reads black and white as achromatic', () => {
    expect(rgbToHsl({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, l: 0 });
    expect(rgbToHsl({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, l: 100 });
  });

  it('produces the triplet form the stylesheet expects', () => {
    // Bare numbers, no hsl() wrapper — Tailwind supplies its own alpha.
    expect(hexToHslTriplet('#ff0000')).toBe('0 100% 50%');
    expect(toHslTriplet({ h: 222.4444, s: 47.1, l: 20 })).toBe('222.4 47.1% 20%');
  });

  it('returns null rather than a wrong colour for bad input', () => {
    expect(hexToRgb('nonsense')).toBeNull();
    expect(hexToHsl('nonsense')).toBeNull();
    expect(hexToHslTriplet('nonsense')).toBeNull();
  });
});

describe('contrast', () => {
  it('measures the documented extremes', () => {
    expect(contrastRatioHex('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatioHex('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('passes a legible pairing silently', () => {
    const check = checkContrast('#ffffff', '#1f2937');
    expect(check?.passesAA).toBe(true);
    expect(check?.message).toBeNull();
  });

  it('warns about white on a pale brand colour', () => {
    // The classic mistake: a bright yellow brand with white button text.
    const check = checkContrast('#ffffff', '#ffe066');
    expect(check?.passesAA).toBe(false);
    expect(check?.message).toMatch(/hard to read/);
  });

  it('distinguishes large-text-only from failing outright', () => {
    const check = checkContrast('#767676', '#ffffff');
    expect(check?.ratio).toBeGreaterThan(4);
    const marginal = checkContrast('#949494', '#ffffff');
    expect(marginal?.passesAA).toBe(false);
    expect(marginal?.passesAALarge).toBe(true);
    expect(marginal?.message).toMatch(/large sizes/);
  });

  it('uses the WCAG AA threshold', () => {
    expect(AA_NORMAL).toBe(4.5);
  });
});

describe('readableForeground', () => {
  it('puts white on a dark brand and black on a light one', () => {
    expect(readableForeground('#0b1f3a')).toBe('#ffffff');
    expect(readableForeground('#ffe066')).toBe('#000000');
  });

  it('measures rather than guessing at the midpoint', () => {
    // Mid-tone colours are where a lightness cut-off gets it wrong. Whatever
    // is returned must be the more legible of the two, by measurement.
    for (const hex of ['#767676', '#808080', '#8a8a8a', '#1f6feb', '#d64545']) {
      const chosen = readableForeground(hex);
      const other = chosen === '#ffffff' ? '#000000' : '#ffffff';
      expect(
        contrastRatioHex(chosen, hex)!,
        `${hex} chose ${chosen}`,
      ).toBeGreaterThanOrEqual(contrastRatioHex(other, hex)!);
    }
  });
});

describe('buildPalette', () => {
  it('derives every shade from one value', () => {
    const palette = buildPalette('#1f6feb');
    expect(palette).not.toBeNull();
    for (const value of Object.values(palette!)) {
      expect(value).toMatch(/^-?[\d.]+ [\d.]+% [\d.]+%$/);
    }
  });

  it('lightens the hover on a dark brand and darkens it on a light one', () => {
    // Always darkening would make a navy brand's hover invisible.
    const lightnessOf = (triplet: string) =>
      Number(triplet.split(' ')[2]!.replace('%', ''));

    const dark = buildPalette('#0b1f3a')!;
    expect(lightnessOf(dark.hover)).toBeGreaterThan(lightnessOf(dark.base));

    const light = buildPalette('#ffe066')!;
    expect(lightnessOf(light.hover)).toBeLessThan(lightnessOf(light.base));
  });

  it('keeps the active state further along than the hover', () => {
    const lightnessOf = (triplet: string) =>
      Number(triplet.split(' ')[2]!.replace('%', ''));
    const palette = buildPalette('#1f6feb')!;
    const distance = (t: string) =>
      Math.abs(lightnessOf(t) - lightnessOf(palette.base));
    expect(distance(palette.active)).toBeGreaterThan(distance(palette.hover));
  });

  it('gives the base a foreground that is actually legible on it', () => {
    for (const hex of ['#0b1f3a', '#ffe066', '#1f6feb', '#d64545', '#ffffff']) {
      const palette = buildPalette(hex)!;
      const foreground = hslToHex({
        h: Number(palette.baseForeground.split(' ')[0]),
        s: Number(palette.baseForeground.split(' ')[1]!.replace('%', '')),
        l: Number(palette.baseForeground.split(' ')[2]!.replace('%', '')),
      });
      expect(contrastRatioHex(foreground, hex)!, hex).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    }
  });

  it('clamps rather than wrapping at the ends of the range', () => {
    // Black must not become white because a shade went below zero.
    const black = buildPalette('#000000')!;
    const white = buildPalette('#ffffff')!;
    const lightnessOf = (t: string) => Number(t.split(' ')[2]!.replace('%', ''));
    expect(lightnessOf(black.active)).toBeGreaterThanOrEqual(0);
    expect(lightnessOf(white.active)).toBeLessThanOrEqual(100);
  });

  it('returns null for a colour it cannot read', () => {
    expect(buildPalette('not a colour')).toBeNull();
  });
});
