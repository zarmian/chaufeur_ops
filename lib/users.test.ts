import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from './permissions';
import {
  ROLES,
  ROLE_DESCRIPTIONS,
  generateTemporaryPassword,
  passwordSchema,
  userSchema,
} from './users';
import { MIN_PASSWORD_LENGTH } from './install';

/**
 * The parts of user management that hold without a database.
 *
 * The lock-out guards — last administrator, cannot demote yourself — need
 * real rows and live in `users.integration.test.ts`.
 */

describe('roles', () => {
  it('covers exactly the roles the permission table knows about', () => {
    // A role added to the schema but not here would be invisible on the form,
    // so nobody could ever be given it.
    const inCapabilities = new Set(Object.values(CAPABILITIES).flat());
    expect(new Set(ROLES)).toEqual(inCapabilities);
  });

  it('describes every role it offers', () => {
    for (const role of ROLES) {
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
    }
  });

  it('keeps money away from OPS and operations away from ACCOUNTS', () => {
    // The split the whole role table exists for. Stated here so a well-meant
    // widening of one capability has to argue with a test.
    expect(CAPABILITIES.editJobFinances).not.toContain('OPS');
    expect(CAPABILITIES.viewRevenue).not.toContain('OPS');
    expect(CAPABILITIES.editJobs).not.toContain('ACCOUNTS');
    expect(CAPABILITIES.dispatch).not.toContain('ACCOUNTS');
    // VIEWER may look at anything and change nothing.
    for (const [name, roles] of Object.entries(CAPABILITIES)) {
      if (name.startsWith('view')) continue;
      expect(roles, `${name} must not be granted to VIEWER`).not.toContain('VIEWER');
    }
  });

  it('reserves users, settings and deletes for ADMIN alone', () => {
    expect(CAPABILITIES.manageUsers).toEqual(['ADMIN']);
    expect(CAPABILITIES.manageSettings).toEqual(['ADMIN']);
    expect(CAPABILITIES.deleteRecords).toEqual(['ADMIN']);
  });
});

describe('userSchema', () => {
  it('lowercases and trims the email, which is the login', () => {
    const parsed = userSchema.parse({
      name: '  Sam Okafor ',
      email: '  Sam.Okafor@Example.COM ',
      role: 'OPS',
    });
    expect(parsed.email).toBe('sam.okafor@example.com');
    expect(parsed.name).toBe('Sam Okafor');
  });

  it('refuses a blank name and a malformed email', () => {
    expect(userSchema.safeParse({ name: '  ', email: 'a@b.co', role: 'OPS' }).success).toBe(false);
    expect(userSchema.safeParse({ name: 'Sam', email: 'not-an-email', role: 'OPS' }).success).toBe(false);
  });

  it('refuses a role that is not one of the four', () => {
    expect(userSchema.safeParse({ name: 'Sam', email: 'a@b.co', role: 'SUPERUSER' }).success).toBe(false);
  });
});

describe('temporary passwords', () => {
  it('meets the same length rule as any other password', () => {
    // Generated, not typed — but it is still a password, and a generator that
    // drifted under the minimum would be rejected at the point of use.
    for (let i = 0; i < 20; i += 1) {
      const password = generateTemporaryPassword();
      expect(password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
      expect(passwordSchema.safeParse(password).success).toBe(true);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, generateTemporaryPassword));
    expect(seen.size).toBe(200);
  });

  it('is readable aloud: words, hyphens and digits only', () => {
    // It gets read off one screen and typed into another. Anything needing
    // "capital O, not zero" sends the person straight back to whoever issued it.
    expect(generateTemporaryPassword()).toMatch(/^[a-z]+(-[a-z]+){3}-\d{2}$/);
  });
});

describe('passwordSchema', () => {
  it('holds the installer’s minimum', () => {
    expect(passwordSchema.safeParse('x'.repeat(MIN_PASSWORD_LENGTH)).success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(MIN_PASSWORD_LENGTH - 1)).success).toBe(false);
  });
});
