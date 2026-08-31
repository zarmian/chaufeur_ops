import { describe, expect, it } from 'vitest';
import { checkSameOrigin } from './same-origin';

/**
 * The rule that stops another site posting as a signed-in operator.
 *
 * Worth testing at this level rather than only through a running server: the
 * dangerous cases are the ones nobody clicks through by hand — a sibling
 * subdomain, a stripped header, a port that does not match — and each is one
 * line here.
 */

const BASE = {
  method: 'POST',
  origin: null as string | null,
  referer: null as string | null,
  host: 'ops.example.com',
  hasSessionCookie: true,
};

describe('the cross-origin refusal', () => {
  it('lets the application post to itself', () => {
    expect(
      checkSameOrigin({ ...BASE, origin: 'https://ops.example.com' }),
    ).toMatchObject({ ok: true });
  });

  it('refuses another site posting with the operator’s cookie', () => {
    expect(
      checkSameOrigin({ ...BASE, origin: 'https://evil.example.net' }),
    ).toMatchObject({ ok: false, reason: 'origin mismatch' });
  });

  it('refuses a sibling subdomain, which SameSite does not', () => {
    /*
     * The whole reason this exists.
     *
     * `blog.example.com` and `ops.example.com` are the same *site*, so the
     * session cookie is attached to a form post between them and `SameSite`
     * raises no objection. They are not the same *origin*, and this is a
     * white-label product where a customer hosting both under one domain is
     * an ordinary deployment rather than a contrivance.
     */
    expect(
      checkSameOrigin({ ...BASE, origin: 'https://blog.example.com' }),
    ).toMatchObject({ ok: false, reason: 'origin mismatch' });
  });

  it('treats a different port as a different origin', () => {
    // Two applications on one host in development. Letting one post to the
    // other is the same bug wearing a local hostname.
    expect(
      checkSameOrigin({
        ...BASE,
        host: 'localhost:3000',
        origin: 'http://localhost:3001',
      }),
    ).toMatchObject({ ok: false, reason: 'origin mismatch' });
  });

  it('lets a GET through, since it changes nothing', () => {
    expect(
      checkSameOrigin({ ...BASE, method: 'GET', origin: 'https://evil.example.net' }),
    ).toMatchObject({ ok: true, reason: 'safe method' });
  });

  it('lets a webhook through, because it carries no cookie', () => {
    /*
     * Telegram and the payment gateways post server-to-server: no cookie, no
     * `Origin`. Gating the whole check on a session cookie is what lets this
     * rule apply everywhere without a list of exempt paths — and a rule with
     * no exceptions list cannot have the wrong path left off it.
     */
    expect(
      checkSameOrigin({ ...BASE, hasSessionCookie: false }),
    ).toMatchObject({ ok: true, reason: 'no session' });
  });

  it('refuses a cookie-bearing post with no origin at all', () => {
    // Browsers have sent `Origin` on every POST for years. A cookie-bearing
    // one without it is not a browser doing something ordinary.
    expect(checkSameOrigin(BASE)).toMatchObject({
      ok: false,
      reason: 'origin missing',
    });
  });

  it('falls back to the referer when only that survived', () => {
    // A privacy extension or corporate proxy occasionally strips one and not
    // the other. Refusing an operator's legitimate click is its own failure.
    expect(
      checkSameOrigin({ ...BASE, referer: 'https://ops.example.com/jobs/abc' }),
    ).toMatchObject({ ok: true, reason: 'same origin' });
  });

  it('does not accept a referer from somewhere else', () => {
    expect(
      checkSameOrigin({ ...BASE, referer: 'https://evil.example.net/page' }),
    ).toMatchObject({ ok: false, reason: 'origin mismatch' });
  });

  it('refuses the literal string "null"', () => {
    // What a sandboxed iframe or a privacy-stripped origin sends. It matches
    // no host, and parsing it as one would be the bug.
    expect(checkSameOrigin({ ...BASE, origin: 'null' })).toMatchObject({
      ok: false,
      reason: 'origin missing',
    });
  });

  it('refuses rather than throwing on an unparseable origin', () => {
    expect(
      checkSameOrigin({ ...BASE, origin: 'not a url at all' }),
    ).toMatchObject({ ok: false });
  });

  it('is not fooled by a host name that merely contains ours', () => {
    for (const origin of [
      'https://ops.example.com.evil.net',
      'https://notops.example.com',
      'https://ops.example.com@evil.net',
    ]) {
      expect(checkSameOrigin({ ...BASE, origin }), origin).toMatchObject({
        ok: false,
      });
    }
  });
});
