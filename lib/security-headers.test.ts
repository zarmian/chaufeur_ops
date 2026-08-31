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
    expect(policy.split('; ').find((d) => d.startsWith('script-src'))).not.toContain(
      "'unsafe-inline'",
    );
  });

  it('never allows eval in production', () => {
    expect(policy).not.toContain('unsafe-eval');
    // And does in development, because fast refresh needs it.
    expect(contentSecurityPolicy(nonce, { development: true })).toContain(
      'unsafe-eval',
    );
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

  it('upgrades insecure requests in production only', () => {
    expect(policy).toContain('upgrade-insecure-requests');
    expect(contentSecurityPolicy(nonce, { development: true })).not.toContain(
      'upgrade-insecure-requests',
    );
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

  it('sets HSTS in production and not in development', () => {
    expect(headers['Strict-Transport-Security']).toContain('max-age=31536000');
    // A stray HSTS entry for localhost is remarkably annoying to clear.
    expect(
      staticSecurityHeaders({ development: true })['Strict-Transport-Security'],
    ).toBeUndefined();
  });
});
