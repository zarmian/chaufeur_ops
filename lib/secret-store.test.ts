import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  encryptionAvailable,
  EncryptionUnavailableError,
  maskSecret,
  safeEqual,
} from './secret-store';

/**
 * Secrets at rest.
 *
 * The rule this protects is that a database backup never contains a usable
 * API key. The two ways that rule gets broken are a silent fallback to
 * plaintext when no key is configured, and a value that decrypts under the
 * wrong key rather than failing — so both are tested for the refusal, not the
 * success.
 */

const ORIGINAL = process.env.SETTINGS_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.SETTINGS_ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
  else process.env.SETTINGS_ENCRYPTION_KEY = ORIGINAL;
});

describe('encryptSecret', () => {
  it('round-trips a value', () => {
    const secret = 'sk_live_abcdef123456';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('never contains the plaintext', () => {
    const stored = encryptSecret('sk_live_abcdef123456');
    expect(stored).not.toContain('sk_live');
    expect(stored).not.toContain('abcdef');
  });

  it('produces a different ciphertext each time', () => {
    // A fresh IV per encryption. Without it, two installs with the same key
    // would produce identical rows, and equal ciphertexts would leak that
    // two secrets are the same.
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same');
    expect(decryptSecret(b)).toBe('same');
  });

  it('handles a key of any length, so a pasted secret just works', () => {
    for (const key of ['short', 'a'.repeat(200)]) {
      process.env.SETTINGS_ENCRYPTION_KEY = key;
      expect(decryptSecret(encryptSecret('value'))).toBe('value');
    }
  });

  it('refuses rather than falling back to plaintext', () => {
    // The whole point. A silent downgrade is how a system ends up with keys
    // in the clear and nobody aware of it.
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    expect(encryptionAvailable()).toBe(false);
    expect(() => encryptSecret('secret')).toThrow(EncryptionUnavailableError);
  });
});

describe('decryptSecret', () => {
  it('returns null under a different key', () => {
    const stored = encryptSecret('secret');
    process.env.SETTINGS_ENCRYPTION_KEY = 'a-different-key';
    expect(decryptSecret(stored)).toBeNull();
  });

  it('returns null for a tampered ciphertext', () => {
    // GCM authenticates as well as encrypts, so a modified value fails to
    // decrypt rather than producing rubbish that then reaches a provider.
    const stored = encryptSecret('secret');
    const parts = stored.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString('base64url');

    expect(decryptSecret(parts.join('.'))).toBeNull();
  });

  it('returns null for anything that is not a stored secret', () => {
    for (const value of ['', 'plaintext', 'v2.a.b.c', 'v1.only.three']) {
      expect(decryptSecret(value)).toBeNull();
    }
  });

  it('returns null with no key configured', () => {
    const stored = encryptSecret('secret');
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    expect(decryptSecret(stored)).toBeNull();
  });
});

describe('maskSecret', () => {
  it('shows only the last four characters', () => {
    expect(maskSecret('sk_live_abcdef123456')).toBe('••••••••3456');
  });

  it('says so when nothing is set', () => {
    expect(maskSecret(null)).toBe('Not set');
  });
});

describe('safeEqual', () => {
  it('matches identical values and rejects everything else', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    // Different lengths must not throw — `timingSafeEqual` does.
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
