import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id, at the parameters OWASP recommends for interactive logins.
 *
 * @node-rs/argon2 ships prebuilt native binaries, so it works on Vercel's
 * Node runtime without a compiler — unlike the `argon2` npm package.
 */
const OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length === 0) {
    throw new Error('Refusing to hash an empty password');
  }
  return hash(plaintext, OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed hash,
 * so a corrupted row is a failed login and not a 500.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, OPTIONS);
  } catch {
    return false;
  }
}
