import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Secrets held in the database, encrypted at rest.
 *
 * Payment gateway keys and transactional email keys are configured per
 * install rather than per deployment — a white-label customer changes their
 * own SumUp key without a redeploy, which is the whole point of Settings.
 * But an API key sitting in plaintext in a `Setting` row is one database
 * backup away from being somebody else's, so nothing goes in unencrypted.
 *
 * AES-256-GCM, key from `SETTINGS_ENCRYPTION_KEY`. GCM rather than CBC
 * because it authenticates as well as encrypts: a tampered ciphertext fails
 * to decrypt rather than silently producing rubbish that then gets sent to a
 * payment provider.
 *
 * With no key configured, storing a secret is **refused** rather than falling
 * back to plaintext. A silent downgrade is how a system ends up with secrets
 * in the clear and nobody aware of it.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'No SETTINGS_ENCRYPTION_KEY is configured, so secrets cannot be stored. Generate one with `openssl rand -hex 32` and set it before saving credentials.',
    );
    this.name = 'EncryptionUnavailableError';
  }
}

/**
 * The key, derived so any length of configured value works.
 *
 * Hashed rather than required to be exactly 32 bytes: an operator pasting a
 * 40-character secret should get a working install, not a stack trace.
 */
function key(): Buffer | null {
  const configured = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (!configured) return null;
  return createHash('sha256').update(configured).digest();
}

export function encryptionAvailable(): boolean {
  return key() !== null;
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const secret = key();
  if (!secret) throw new EncryptionUnavailableError();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, secret, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt, or null.
 *
 * Null covers a missing key, a value from a different key, and a tampered
 * one. All three mean the same thing to a caller — this credential cannot be
 * used — and distinguishing them in a return value would only invite code
 * that treats one of them as recoverable.
 */
export function decryptSecret(stored: string): string | null {
  const secret = key();
  if (!secret) return null;

  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      secret,
      Buffer.from(parts[1]!, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * What a stored secret looks like on screen.
 *
 * Never the value. An operator needs to know whether a key is set and
 * roughly which one it is; showing the rest would put it in a screenshot,
 * a support ticket and a browser cache.
 */
export function maskSecret(plaintext: string | null): string {
  if (!plaintext) return 'Not set';
  const tail = plaintext.slice(-4);
  return `${'•'.repeat(8)}${tail}`;
}

/**
 * Constant-time comparison, for webhook signatures.
 *
 * `===` on a signature leaks its prefix through timing. That matters here:
 * a webhook endpoint is public by necessity, and an attacker who can guess a
 * signature can post payments that were never received.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Length is not secret, and `timingSafeEqual` throws on a mismatch.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
