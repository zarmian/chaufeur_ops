import { afterEach, describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, setupToken, tokenMatches } from './install';

const ORIGINAL = {
  SETUP_TOKEN: process.env.SETUP_TOKEN,
  CRON_SECRET: process.env.CRON_SECRET,
};

function setEnv(key: 'SETUP_TOKEN' | 'CRON_SECRET', value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  setEnv('SETUP_TOKEN', ORIGINAL.SETUP_TOKEN);
  setEnv('CRON_SECRET', ORIGINAL.CRON_SECRET);
});

describe('setupToken', () => {
  it('prefers SETUP_TOKEN when both are set', () => {
    setEnv('SETUP_TOKEN', 'dedicated');
    setEnv('CRON_SECRET', 'cron');
    expect(setupToken()).toBe('dedicated');
  });

  it('falls back to CRON_SECRET, so a fresh install needs no extra variable', () => {
    setEnv('SETUP_TOKEN', undefined);
    setEnv('CRON_SECRET', 'cron');
    expect(setupToken()).toBe('cron');
  });

  it('is null when neither is configured', () => {
    setEnv('SETUP_TOKEN', undefined);
    setEnv('CRON_SECRET', undefined);
    expect(setupToken()).toBeNull();
  });
});

describe('tokenMatches', () => {
  it('accepts the configured token', () => {
    setEnv('SETUP_TOKEN', 'correct-horse-battery-staple');
    expect(tokenMatches('correct-horse-battery-staple')).toBe(true);
  });

  it('rejects a wrong token', () => {
    setEnv('SETUP_TOKEN', 'correct-horse-battery-staple');
    expect(tokenMatches('wrong')).toBe(false);
    expect(tokenMatches('correct-horse-battery-stapl')).toBe(false);
    expect(tokenMatches('')).toBe(false);
  });

  it('handles a length mismatch without throwing', () => {
    // timingSafeEqual throws on unequal lengths, which is why both sides are
    // hashed to a fixed width first.
    setEnv('SETUP_TOKEN', 'short');
    expect(() => tokenMatches('a-very-much-longer-value')).not.toThrow();
    expect(tokenMatches('a-very-much-longer-value')).toBe(false);
  });

  it('fails closed when no token is configured', () => {
    // An unset token must not mean "anyone may claim this install".
    setEnv('SETUP_TOKEN', undefined);
    setEnv('CRON_SECRET', undefined);
    expect(tokenMatches('')).toBe(false);
    expect(tokenMatches('anything')).toBe(false);
  });
});

describe('password policy', () => {
  it('requires a length that is not trivially guessable', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });
});
