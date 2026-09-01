import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  createNonce,
  staticSecurityHeaders,
} from './security-headers';

/**
 * The policy, asserted rather than assumed.
 *
 * These headers are invisible when they work and invisible when somebody
 * deletes them, which is exactly the shape of thing that quietly stops being
 * true. Each assertion below names the attack it refuses.
 */
describe('the content security policy', () => {
  const nonce = 'test-nonce-value';
  const policy = contentSecurityPolicy(nonce);

  it('carries the nonce and trusts nothing else to script', () => {
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).toContain("'strict-dynamic'");
  });

  it('never allows inline script', () => {
    // The single line that would make the whole policy decorative.
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(
      policy.split('; ').find((d) => d.startsWith('script-src')),
    ).not.toContain("'unsafe-inline'");
  });

  it('never allows eval in production', () => {
    expect(policy).not.toContain('unsafe-eval');
    // And does in development, because fast refresh needs it.
    expect(contentSecurityPolicy(nonce, { development: true })).toContain(
      'unsafe-eval',
    );
  });

  /*
   * The regression this pair exists for.
   *
   * `connect-src 'self'` was written believing nothing in the browser talked
   * to a third party. Uploads had already moved into the browser by then, so
   * the policy silently blocked every document upload: the request never
   * opened, no progress event fired, and the panel sat at 0% with nothing to
   * report because nothing had failed.
   *
   * A stall is the worst failure shape available — no error, no log, and an
   * operator who tries again. So the hosts are asserted by name.
   */
  it('lets the browser reach Vercel Blob, because uploads go direct', () => {
    const connect = policy.split('; ').find((d) => d.startsWith('connect-src'));

    expect(connect).toContain("'self'");
    // Where `@vercel/blob/client` starts and completes an upload.
    expect(connect).toContain('https://vercel.com');
    // The store's own subdomain, where the object itself is written.
    expect(connect).toContain('https://*.vercel-storage.com');
  });

  it('does not open connect-src to anything else', () => {
    // Widening this to `https:` would make the directive decorative, and it
    // is the one that says where the application legitimately talks out.
    const connect = policy.split('; ').find((d) => d.startsWith('connect-src'));

    expect(connect).not.toContain('connect-src https:');
    expect(connect).not.toContain("'unsafe-inline'");
    expect(connect?.split(' ').filter((s) => s === '*')).toHaveLength(0);
  });

  it('refuses to be framed', () => {
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('pins the base URI, so injected markup cannot re-root every relative URL', () => {
    expect(policy).toContain("base-uri 'self'");
  });

  it('keeps forms pointed at this application', () => {
    // Without it, injected markup can post the operator's next form — session
    // cookie and all — to somewhere else.
    expect(policy).toContain("form-action 'self'");
  });

  it('allows no plugins', () => {
    expect(policy).toContain("object-src 'none'");
  });

  it('upgrades insecure requests only when the request came over TLS', () => {
    /*
     * Keyed on the request, never on the build. CI caught this within the
     * hour of the first attempt, which keyed it on `NODE_ENV`: the E2E job
     * builds for production and serves over `http://127.0.0.1:3000`, so the
     * directive told the browser to rewrite every `fetch` to `https://`,
     * where nothing was listening. Four tests died with
     * `TypeError: Failed to fetch` and 108 passed — the exact shape of a
     * mistake that reaches an HTTP-only install and reads as a network fault.
     */
    expect(contentSecurityPolicy(nonce, { secure: true })).toContain(
      'upgrade-insecure-requests',
    );
    // A production build served over plain HTTP must not carry it.
    expect(contentSecurityPolicy(nonce, { secure: false })).not.toContain(
      'upgrade-insecure-requests',
    );
    expect(policy).not.toContain('upgrade-insecure-requests');
  });
});

describe('the nonce', () => {
  it('differs every time', () => {
    // A reused nonce is not a nonce, and a policy built on one is a policy an
    // injected script can satisfy by copying the value off the page.
    const seen = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(seen.size).toBe(50);
  });
});

describe('the static headers', () => {
  const headers = staticSecurityHeaders();

  it('refuses framing for older browsers too', () => {
    // The finding these exist for: every destructive action here is a form
    // post behind a cookie, and framing turns one into a stolen click.
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('stops content-type sniffing', () => {
    // Exports and blob downloads are served with a declared type; a browser
    // that sniffs past it can be talked into rendering one as HTML.
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('does not leak record identifiers to other sites', () => {
    // Paths here carry job references, driver ids and name-board tokens —
    // and the board token is a credential, not just an identifier.
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sets HSTS only on a request that arrived over TLS', () => {
    expect(
      staticSecurityHeaders({ secure: true })['Strict-Transport-Security'],
    ).toContain('max-age=31536000');
    // Browsers ignore it on a plain HTTP response anyway, and a stray HSTS
    // entry for localhost is remarkably annoying to clear.
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('sets the framing and sniffing defences regardless of scheme', () => {
    // These do not depend on TLS, and an http-only install needs them just as
    // much — more, if anything.
    for (const set of [staticSecurityHeaders({ secure: true }), headers]) {
      expect(set['X-Frame-Options']).toBe('DENY');
      expect(set['X-Content-Type-Options']).toBe('nosniff');
    }
  });
});
