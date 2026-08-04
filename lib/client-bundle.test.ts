import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No Client Component may reach server-only code.
 *
 * This exists because of a real Phase 1 defect. `driver-form.tsx` imported
 * its status options from `lib/drivers.ts`, which imports `lib/prisma.ts`.
 * That put `PrismaClient` in the browser bundle, and Prisma's browser build
 * throws the moment a property is read — during hydration. The forms rendered
 * from the server, then threw and were replaced by the error boundary, so
 * every create and edit screen showed "Something went wrong". Nothing in the
 * type checker, the linter or the build noticed: it is a runtime failure in
 * the browser, and only an end-to-end run against a real browser catches it.
 *
 * So it is caught here instead, statically, on every push. The check walks
 * the import graph out of each `'use client'` module and fails if it reaches
 * anything that only works on a server.
 *
 * If this test fails: move the value you need into a leaf module that imports
 * nothing server-side — `lib/enum-options.ts` is the precedent — rather than
 * relaxing the check.
 */

const ROOT = resolve(__dirname, '..');
const SOURCE_DIRS = ['app', 'components', 'lib'];

/** Bare specifiers that mean "this module cannot run in a browser". */
const SERVER_ONLY_PACKAGES = [
  '@prisma/client',
  '@node-rs/argon2',
  '@vercel/blob',
  'next/server',
  'next/headers',
  'next/cache',
];

function isServerOnlyPackage(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return SERVER_ONLY_PACKAGES.some(
    (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Import specifiers, ignoring `import type` — those are erased by the
 * compiler and never reach the bundle.
 */
function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:^|\n)\s*import\s+(?!type\s)([\s\S]*?)from\s*['"]([^'"]+)['"]/g;

  for (const match of source.matchAll(pattern)) {
    const clause = match[1] ?? '';
    const specifier = match[2];
    if (!specifier) continue;
    // `import { type A, type B } from '…'` is also fully erased.
    const named = clause.match(/\{([\s\S]*)\}/)?.[1];
    if (named !== undefined && clause.trim().startsWith('{')) {
      const entries = named.split(',').map((e) => e.trim()).filter(Boolean);
      if (entries.length > 0 && entries.every((e) => e.startsWith('type '))) {
        continue;
      }
    }
    specifiers.push(specifier);
  }

  // Side-effect imports carry no clause and the pattern above misses them.
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
    if (match[1]) specifiers.push(match[1]);
  }

  return specifiers;
}

/** Resolve a relative or `@/` specifier to a file on disk, or null. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = join(ROOT, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return null;
  }

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

const allFiles = SOURCE_DIRS.flatMap((dir) => walk(join(ROOT, dir)));

const clientEntrypoints = allFiles.filter((file) =>
  /^\s*['"]use client['"]/.test(readFileSync(file, 'utf8')),
);

/**
 * Walk out from a Client Component and return the first path that reaches
 * server-only code, as a readable import chain.
 */
function findServerOnlyPath(entry: string): string | null {
  const seen = new Set<string>();
  const queue: Array<{ file: string; chain: string[] }> = [
    { file: entry, chain: [relative(ROOT, entry)] },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (seen.has(current.file)) continue;
    seen.add(current.file);

    const source = readFileSync(current.file, 'utf8');
    // A `'use server'` module is a network boundary, not a bundled import:
    // Next replaces it with a stub on the client, so it is not followed.
    if (current.file !== entry && /^\s*['"]use server['"]/.test(source)) {
      continue;
    }

    for (const specifier of importsOf(source)) {
      if (isServerOnlyPackage(specifier)) {
        return [...current.chain, specifier].join('\n    -> ');
      }
      const next = resolveLocal(specifier, current.file);
      if (next) {
        queue.push({ file: next, chain: [...current.chain, relative(ROOT, next)] });
      }
    }
  }

  return null;
}

describe('client bundle safety', () => {
  it('finds the Client Components to check', () => {
    // A refactor that renames directories must not silently empty this suite.
    expect(clientEntrypoints.length).toBeGreaterThan(5);
  });

  it.each(clientEntrypoints.map((file) => [relative(ROOT, file), file]))(
    '%s reaches no server-only module',
    (_label, file) => {
      const offending = findServerOnlyPath(file);
      expect(
        offending,
        `This Client Component pulls server-only code into the browser bundle:\n\n    ${offending}\n\n` +
          'Prisma throws during hydration when bundled for the browser, which the\n' +
          'user sees as "Something went wrong". Move the value into a leaf module\n' +
          'that imports nothing server-side (see lib/enum-options.ts).',
      ).toBeNull();
    },
  );
});
