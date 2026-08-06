import { defineWorkspace } from 'vitest/config';

/**
 * Two projects, because the integration tests share one database and the unit
 * tests share nothing.
 *
 * Vitest runs test files in parallel by default, which is right for pure
 * functions and wrong for anything asserting on a global count. Several
 * assertions in this suite are necessarily global — `countUnpricedCompleted`
 * counts every unpriced completed job, `peekNextJobReference` reads one shared
 * counter, and a report total is a total. When two files touch those at once,
 * the assertion fails for reasons that have nothing to do with the code.
 *
 * That produced a failure appearing in roughly one full-suite run in six and
 * never in isolation — the worst possible shape, because it trains people to
 * re-run until it passes. The fix is to stop the overlap rather than to weaken
 * the assertions: a total that is only checked loosely is a total nobody is
 * really checking.
 *
 * So integration files run one at a time, and everything else keeps running in
 * parallel. The serial half is still seconds.
 *
 * **The serialisation lives in `package.json`, not here.** A project-level
 * `fileParallelism: false` is accepted by the config and then ignored — it was
 * set here first, and the failure carried on at the same rate. Only the CLI
 * flag takes effect, which is why `test:integration` passes
 * `--no-file-parallelism` and `npm test` runs the two projects as two
 * commands. If that flag is ever dropped, the intermittent failure comes back.
 */
export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['**/*.test.ts', '**/*.test.tsx'],
      exclude: [
        'node_modules/**',
        '.next/**',
        'tests/e2e/**',
        '**/*.integration.test.ts',
      ],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['**/*.integration.test.ts'],
      exclude: ['node_modules/**', '.next/**', 'tests/e2e/**'],
      // Nothing here enforces the serialisation — see the note above. The
      // project exists so `--no-file-parallelism` can be aimed at exactly
      // these files and not at the fast half of the suite.
    },
  },
]);
