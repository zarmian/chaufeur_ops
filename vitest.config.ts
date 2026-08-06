import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@/*` -> `./*` mapping in tsconfig.json.
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    // `include` and `exclude` live in `vitest.workspace.ts`, one set per
    // project. They are deliberately not here: a workspace project extending
    // this file *merges* the patterns rather than replacing them, so an
    // `include` at this level would make every project run every test.
    exclude: ['node_modules/**', '.next/**', 'tests/e2e/**'],
  },
});
