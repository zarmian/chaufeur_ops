/**
 * Where a redirect is allowed to send somebody.
 *
 * Its own module rather than a helper beside the login action, for two
 * reasons. `app/(auth)/actions.ts` carries `'use server'`, so everything it
 * exports has to be an async server function — a pure string check cannot
 * live there and still be importable by a test. And the rule is wanted in
 * more than one place: two of this system's redirects are already route
 * handlers emitting a real `Location` header, which is the context where
 * getting this wrong actually costs something.
 */

/**
 * A path on this application, or `/`.
 *
 * Every rejected shape below is a way of writing "somewhere else" that still
 * begins with a slash:
 *
 * `//evil.com` is protocol-relative. The browser reads it as another origin
 * entirely. This is the classic form and was already caught.
 *
 * `/\evil.com` is the same attack wearing a backslash. Browsers normalise `\`
 * to `/` inside a URL, so it becomes the case above — and this one was **not**
 * caught. It escaped the filter in testing; the only reason it did not escape
 * the origin is that a Server Action redirect goes through Next's client
 * router rather than a `Location` header, which is a property of the
 * mechanism and not of the check.
 *
 * Control characters — tab, newline, NUL — are stripped by browsers *before*
 * the URL is parsed, so `/<tab>/evil.com` can pass a naive prefix test and
 * then resolve somewhere else once the tab is gone.
 *
 * Anything not starting with `/` is absolute, a scheme, or a relative path
 * that could climb somewhere unintended.
 */
export function safeInternalPath(candidate: string | undefined | null): string {
  if (!candidate) return '/';

  // First, because what the browser parses is this string with them removed,
  // and that is the string worth judging.
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return '/';

  if (candidate.includes('\\')) return '/';
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//')) return '/';

  return candidate;
}
