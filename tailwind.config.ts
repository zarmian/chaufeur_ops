import tailwindcssAnimate from 'tailwindcss-animate';
import defaultTheme from 'tailwindcss/defaultTheme';
import type { Config } from 'tailwindcss';

/**
 * Every colour resolves to a CSS custom property. Phase 3 writes those
 * properties from branding settings, so `bg-primary` follows configuration
 * without a single component change. No hex literals belong in this file
 * or in component code.
 */
const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      /**
       * The "Dashboard Data" pairing: Fira Sans for the interface, Fira Code
       * for anything that is really a token — a job reference, a
       * registration, a figure in a column. Loaded through `next/font` in
       * the root layout, which self-hosts them, so neither the browser nor
       * the operator waits on fonts.googleapis.com.
       *
       * Both fall back to the system stack, so a font that fails to load
       * degrades to what was there before rather than to serif.
       */
      fontFamily: {
        sans: ['var(--font-sans)', ...defaultTheme.fontFamily.sans],
        mono: ['var(--font-mono)', ...defaultTheme.fontFamily.mono],
      },
      /**
       * Type as a set, not a size.
       *
       * Tracking is size-specific: letters read too far apart as they grow,
       * so large text is tightened, and too close together as they shrink, so
       * small text is opened up. A single `letter-spacing` for the whole
       * scale is wrong at one end or the other. Leading moves the other way —
       * tight on a heading, comfortable on body copy.
       *
       * These override Tailwind's defaults for the same keys, so `text-2xl`
       * carries its own leading and tracking and nothing has to remember to
       * add them.
       */
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1.5', letterSpacing: '0.01em' }],
        sm: ['0.875rem', { lineHeight: '1.5', letterSpacing: '0.005em' }],
        base: ['1rem', { lineHeight: '1.5', letterSpacing: '0' }],
        lg: ['1.125rem', { lineHeight: '1.45', letterSpacing: '-0.005em' }],
        xl: ['1.25rem', { lineHeight: '1.4', letterSpacing: '-0.01em' }],
        '2xl': ['1.5rem', { lineHeight: '1.3', letterSpacing: '-0.015em' }],
        '3xl': ['1.875rem', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
        '4xl': ['2.25rem', { lineHeight: '1.1', letterSpacing: '-0.025em' }],
      },
      transitionDuration: {
        press: 'var(--duration-press)',
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
      },
      /** Paired, so a reversible transition can mirror its own curve. */
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        in: 'var(--ease-in)',
      },
      /** Bigger surfaces read as thicker. */
      boxShadow: {
        chip: 'var(--shadow-chip)',
        panel: 'var(--shadow-panel)',
        sheet: 'var(--shadow-sheet)',
      },
      backdropBlur: {
        chrome: 'var(--blur-chrome)',
        sheet: 'var(--blur-sheet)',
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        scrim: 'var(--scrim)',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          // Written by `lib/theme.ts` from branding settings since Phase 3,
          // and until now consumed by nothing — a configured brand reached a
          // button's resting state but not its hover or its press.
          hover: 'hsl(var(--primary-hover))',
          active: 'hsl(var(--primary-active))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
          // The accent as a fill rather than as a surface.
          solid: 'hsl(var(--accent-solid))',
          'solid-foreground': 'hsl(var(--accent-solid-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
