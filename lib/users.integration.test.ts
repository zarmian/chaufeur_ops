import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from './password';
import { createUser, resetPassword, setUserActive, updateUser } from './users';

/**
 * The guards that stop an install locking itself out.
 *
 * Every one of these failures is unrecoverable from inside the product: an
 * install with no active administrator has no way to make another, and the
 * fix is a database console. They are worth a real database to test against.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);
const at = (who: string) => `${who}.${stamp}@example.test`;

async function makeUser(role: 'ADMIN' | 'OPS', who: string, active = true) {
  return raw!.user.create({
    data: {
      email: at(who),
      name: who,
      role,
      active,
      passwordHash: await hashPassword('a-password-nobody-uses'),
    },
  });
}

/**
 * "Only administrator" is a fact about the whole install, so these tests have
 * to own that fact. A seeded database — which CI's is — already has an admin,
 * and the refusals under test would never fire with a spare one sitting
 * there. Any pre-existing active admin is stood down for the duration and put
 * back afterwards.
 */
describe.skipIf(!DATABASE_AVAILABLE)('user guards', () => {
  let standDown: string[] = [];

  beforeAll(async () => {
    if (!raw) return;
    const others = await raw.user.findMany({
      where: { role: 'ADMIN', active: true, NOT: { email: { contains: `.${stamp}@` } } },
      select: { id: true },
    });
    standDown = others.map((user) => user.id);
    await raw.user.updateMany({ where: { id: { in: standDown } }, data: { active: false } });
  });

  beforeEach(async () => {
    // Every test starts from "this install has exactly one administrator",
    // which is the state all the interesting refusals are about.
    await raw!.user.deleteMany({ where: { email: { contains: `.${stamp}@` } } });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.user.deleteMany({ where: { email: { contains: `.${stamp}@` } } });
    await raw.user.updateMany({ where: { id: { in: standDown } }, data: { active: true } });
    await raw.$disconnect();
  });

  it('creates a user with a temporary password they must change', async () => {
    const admin = await makeUser('ADMIN', 'onlyadmin');
    const result = await createUser(
      { name: 'Sam Okafor', email: at('sam'), role: 'OPS' },
      { userId: admin.id },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.temporaryPassword).toMatch(/^[a-z]+(-[a-z]+){3}-\d{2}$/);

    const created = await raw!.user.findUnique({ where: { id: result.value.id } });
    expect(created?.mustChangePassword).toBe(true);
    // The password is returned once and never stored in readable form.
    expect(created?.passwordHash).not.toContain(result.value.temporaryPassword);
    expect(created?.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('refuses a second account on the same email', async () => {
    const admin = await makeUser('ADMIN', 'onlyadmin');
    await createUser({ name: 'Sam', email: at('dup'), role: 'OPS' }, { userId: admin.id });
    const again = await createUser(
      { name: 'Someone Else', email: at('dup'), role: 'VIEWER' },
      { userId: admin.id },
    );
    expect(again.ok).toBe(false);
  });

  it('will not demote the only administrator', async () => {
    const admin = await makeUser('ADMIN', 'onlyadmin');
    const other = await makeUser('ADMIN', 'secondadmin');

    // With two, demoting one is fine.
    const first = await updateUser(
      other.id,
      { name: other.name, email: other.email, role: 'OPS' },
      admin.id,
      { userId: admin.id },
    );
    expect(first.ok).toBe(true);

    // Now there is one left, and it cannot be demoted — by anybody.
    const second = await updateUser(
      admin.id,
      { name: admin.name, email: admin.email, role: 'VIEWER' },
      other.id,
      { userId: other.id },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toMatch(/only administrator/i);
  });

  it('will not let an administrator change their own role', async () => {
    const admin = await makeUser('ADMIN', 'onlyadmin');
    await makeUser('ADMIN', 'spare');

    // Even with a spare admin, self-demotion is refused: it is nearly always
    // a misclick, and the person doing it is the one who cannot undo it.
    const result = await updateUser(
      admin.id,
      { name: admin.name, email: admin.email, role: 'OPS' },
      admin.id,
      { userId: admin.id },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/your own role/i);
  });

  it('will not deactivate the only administrator, or yourself', async () => {
    const admin = await makeUser('ADMIN', 'onlyadmin');
    const other = await makeUser('ADMIN', 'secondadmin');

    const self = await setUserActive(admin.id, false, admin.id, { userId: admin.id });
    expect(self.ok).toBe(false);

    // Switching off the spare is fine…
    expect((await setUserActive(other.id, false, admin.id, { userId: admin.id })).ok).toBe(true);

    // …and now the last one cannot be switched off by anyone.
    const last = await setUserActive(admin.id, false, other.id, { userId: other.id });
    expect(last.ok).toBe(false);
    if (last.ok) return;
    expect(last.reason).toMatch(/only active administrator/i);
  });

  it('reactivates without complaint', async () => {
    const admin = await makeUser('ADMIN', 'onlyadmin');
    const other = await makeUser('OPS', 'ops', false);
    const result = await setUserActive(other.id, true, admin.id, { userId: admin.id });
    expect(result.ok).toBe(true);
    expect((await raw!.user.findUnique({ where: { id: other.id } }))?.active).toBe(true);
  });

  it('ends every session when a password is reset', async () => {
    const admin = await makeUser('ADMIN', 'onlyadmin');
    const user = await makeUser('OPS', 'resettable');
    await raw!.session.create({
      data: {
        userId: user.id,
        sessionToken: `token-${stamp}`,
        expires: new Date(Date.now() + 3_600_000),
      },
    });

    const result = await resetPassword(user.id, { userId: admin.id });
    expect(result.ok).toBe(true);

    // The reason to reset a password is that somebody else may have had it,
    // so leaving their sessions open would defeat the point.
    expect(await raw!.session.count({ where: { userId: user.id } })).toBe(0);
    const after = await raw!.user.findUnique({ where: { id: user.id } });
    expect(after?.mustChangePassword).toBe(true);
  });

  it('ends every session when an account is switched off', async () => {
    const admin = await makeUser('ADMIN', 'onlyadmin');
    const user = await makeUser('OPS', 'leaver');
    await raw!.session.create({
      data: {
        userId: user.id,
        sessionToken: `token2-${stamp}`,
        expires: new Date(Date.now() + 3_600_000),
      },
    });

    await setUserActive(user.id, false, admin.id, { userId: admin.id });
    // The promise database sessions exist to keep: deactivation lands on the
    // next request, not whenever a token would have expired.
    expect(await raw!.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('records who did it, without recording the password', async () => {
    const admin = await makeUser('ADMIN', 'onlyadmin');
    const result = await createUser(
      { name: 'Audited', email: at('audited'), role: 'VIEWER' },
      { userId: admin.id },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entry = await raw!.auditLog.findFirst({
      where: { entity: 'User', entityId: result.value.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry?.userId).toBe(admin.id);
    expect(JSON.stringify(entry?.after)).not.toContain(result.value.temporaryPassword);
    expect(JSON.stringify(entry?.after)).not.toContain('argon2');
  });
});
