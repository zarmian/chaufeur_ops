import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

/**
 * Flat config, because ESLint 9 stopped reading `.eslintrc.json`.
 *
 * `eslint-config-next` 16 publishes flat configs directly, so they are spread
 * in as they come rather than translated. Rewriting somebody else's ruleset
 * by hand is how a rule quietly stops being enforced, and the project's own
 * additions sit below where they can be read as additions.
 */
const config = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'next-env.d.ts',
      /*
       * Vendored tooling, not this project's code.
       *
       * `.eslintrc` was invoked as `eslint . --ext .ts,.tsx`, which quietly
       * limited it to two extensions. Flat config takes its file list from
       * the config itself, so `eslint .` now reaches every `.cjs` and `.mjs`
       * in the tree — including installed skill scripts, which are somebody
       * else's code held to somebody else's rules. Linting them produces
       * sixteen errors nobody can act on.
       */
      '.claude/**',
    ],
  },

  ...nextCoreWebVitals,
  ...nextTypescript,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  /**
   * No hex colours in component code — the white-label guardrail.
   *
   * Brand colours reach components as CSS custom properties, so `bg-primary`
   * follows whatever the install has configured. A literal `#1a2b3c` in a
   * component is a colour that cannot be themed, and the second customer gets
   * the first customer's palette in one corner of one screen.
   *
   * Tests are excluded because a test may legitimately assert on a specific
   * value it has just configured.
   */
  {
    files: ['components/**/*.tsx', 'app/**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#(?:[0-9a-fA-F]{3}){1,2}\\b/]',
          message:
            'No hex colour literals in component code. Brand colours arrive as CSS custom properties (see tailwind.config.ts) so theming stays configurable.',
        },
      ],
    },
  },

  /**
   * Two React Compiler rules, downgraded for the dispatch board alone.
   *
   * Next 16 brought compiler-aware lint rules with it. Most of what they
   * found was worth fixing and has been — a ref written during render, a
   * clock read while rendering, a state reset that cost an extra pass. These
   * two are different:
   *
   * `set-state-in-effect` fires on a functional update that returns the
   * previous value unchanged when nothing has changed. React bails out of
   * that without re-rendering; the rule cannot see the bail-out.
   *
   * `immutability` fires on the `requestAnimationFrame` loop, where the
   * callback schedules itself. That is how a rAF loop is written.
   *
   * Both sit in the drag-and-drop auto-scroll on the busiest screen in the
   * product. Restructuring them to satisfy the analyser is a real change to
   * pointer handling, and it should be its own piece of work with the board
   * exercised by hand — not a footnote to a dependency upgrade. `warn` rather
   * than `off` so they stay visible, and scoped to this file so new code
   * anywhere else still fails on them.
   */
  {
    files: ['app/(dashboard)/dispatch/dispatch-board.tsx'],
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },

  // Last, so it can switch off anything the rules above turned on that
  // Prettier is going to reformat anyway.
  prettier,
];

export default config;
