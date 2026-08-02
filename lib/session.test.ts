import { describe, expect, it } from 'vitest';
import { hashSessionToken, SESSION_COOKIE_NAMES } from './session';

describe('hashSessionToken', () => {
  it('is deterministic', () => {
    expect(hashSessionToken('abc')).toBe(hashSessionToken('abc'));
  });

  it('produces a SHA-256 hex digest', () => {
    expect(hashSessionToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never returns the token it was given', () => {
    // The column stores this, not the token. A dump of the Session table
    // must not hand anyone a live login.
    const token = 'a-secret-session-token';
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it('separates tokens that differ by one character', () => {
    expect(hashSessionToken('token-a')).not.toBe(hashSessionToken('token-b'));
  });
});

describe('session cookie names', () => {
  it('are what middleware looks for', () => {
    // middleware.ts cannot import this module — it runs on the edge and this
    // one reaches Postgres — so the two lists are kept in step by hand and
    // asserted here.
    expect(SESSION_COOKIE_NAMES).toEqual(['ops_session', '__Secure-ops_session']);
  });

  it('carry no company name, so the cookie survives white-labelling', () => {
    for (const name of SESSION_COOKIE_NAMES) {
      expect(name.toLowerCase()).not.toMatch(/welux|chauffeur/);
    }
  });
});
