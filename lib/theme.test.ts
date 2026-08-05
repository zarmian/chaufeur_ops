import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from './branding';
import { brandStyleSheet, brandThemeCss, brandThemeDarkCss } from './theme';

/**
 * The theme override is the entire white-label mechanism: one custom property
 * on `:root` and every `bg-primary` in the application follows. What is
 * guarded here is that it stays *only* that — a brand colour must not reach
 * the semantic states, or an expired document stops being red.
 */

describe('brandThemeCss', () => {
  it('emits nothing when no colour is configured', () => {
    // A fresh install renders the neutral default from the stylesheet, and
    // looks deliberate rather than unfinished.
    expect(brandThemeCss(DEFAULT_BRANDING)).toBe('');
    expect(brandStyleSheet(DEFAULT_BRANDING)).toBe('');
  });

  it('overrides the primary tokens from one hex value', () => {
    const css = brandThemeCss({ primaryColour: '#1f6feb', accentColour: null });
    expect(css).toContain(':root{');
    expect(css).toContain('--primary:');
    expect(css).toContain('--primary-foreground:');
    expect(css).toContain('--primary-hover:');
    expect(css).toContain('--ring:');
  });

  it('writes triplets, not hsl() calls', () => {
    // Tailwind wraps these with its own alpha channel, which only works on a
    // bare triplet: hsl(var(--primary) / 0.5).
    const css = brandThemeCss({ primaryColour: '#ff0000', accentColour: null });
    expect(css).toContain('--primary:0 100% 50%');
    expect(css).not.toContain('hsl(');
  });

  it('never touches the semantic states', () => {
    // A red that means "expired" must not become a customer's brand colour.
    const css = brandStyleSheet({
      primaryColour: '#d64545',
      accentColour: '#1f6feb',
    });
    for (const token of ['--destructive', '--success', '--warning']) {
      expect(css, token).not.toContain(token);
    }
  });

  it('ignores a colour it cannot read rather than emitting broken CSS', () => {
    // One malformed value would otherwise break every token in the block.
    expect(
      brandThemeCss({ primaryColour: 'rebeccapurple', accentColour: null }),
    ).toBe('');
  });

  it('uses the pale shade for the accent surface', () => {
    const css = brandThemeCss({ primaryColour: null, accentColour: '#1f6feb' });
    expect(css).toContain('--accent:');
    expect(css).toContain('--accent-foreground:');
    expect(css).toContain('--accent-solid:');
  });
});

describe('brandThemeDarkCss', () => {
  const lightnessOf = (css: string, token: string) => {
    const match = new RegExp(`${token}:([^;}]+)`).exec(css);
    return Number(match![1]!.trim().split(' ')[2]!.replace('%', ''));
  };

  it('lifts a dark brand so it reads against a dark surface', () => {
    const css = brandThemeDarkCss({
      primaryColour: '#0b1f3a',
      accentColour: null,
    });
    expect(css).toContain('.dark{');
    expect(lightnessOf(css, '--primary')).toBeGreaterThanOrEqual(55);
  });

  it('leaves an already-light brand alone', () => {
    // Pushing it down would be as wrong as leaving a navy at 12%. `#ffe066`
    // is 70% light, so it should come through untouched.
    const light = brandThemeDarkCss({
      primaryColour: '#ffe066',
      accentColour: null,
    });
    const asRoot = brandThemeCss({ primaryColour: '#ffe066', accentColour: null });
    expect(lightnessOf(light, '--primary')).toBe(lightnessOf(asRoot, '--primary'));
  });

  it('puts dark text on the lifted colour', () => {
    const css = brandThemeDarkCss({
      primaryColour: '#0b1f3a',
      accentColour: null,
    });
    expect(lightnessOf(css, '--primary-foreground')).toBeLessThan(20);
  });

  it('emits nothing without a brand colour', () => {
    expect(brandThemeDarkCss({ primaryColour: null, accentColour: '#1f6feb' })).toBe(
      '',
    );
  });
});

describe('brandStyleSheet', () => {
  it('joins both blocks', () => {
    const css = brandStyleSheet({
      primaryColour: '#1f6feb',
      accentColour: '#d64545',
    });
    expect(css).toContain(':root{');
    expect(css).toContain('.dark{');
  });

  it('produces no stray semicolons or unclosed braces', () => {
    const css = brandStyleSheet({
      primaryColour: '#1f6feb',
      accentColour: '#d64545',
    });
    expect(css.split('{').length).toBe(css.split('}').length);
    expect(css).not.toContain(';}');
    expect(css).not.toContain(';;');
  });
});
