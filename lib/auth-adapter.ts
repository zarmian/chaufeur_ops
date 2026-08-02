import type { Adapter, AdapterSession, AdapterUser } from 'next-auth/adapters';
import { includeDeleted, prisma } from './prisma';

/**
 * A minimal Auth.js adapter over our own tables.
 *
 * `@auth/prisma-adapter` is not used for two reasons: it expects a model
 * called `Account` for OAuth links, and our domain already has an `Account`
 * (the booker); and credentials-only auth never touches the OAuth or
 * verification-token tables, so most of that adapter would be dead schema.
 *
 * Sessions live in the database rather than a JWT, so an admin disabling a
 * user's access takes effect on their next request instead of whenever a
 * token happens to expire.
 */

function toAdapterUser(user: {
  id: string;
  email: string;
  name: string;
  role: AdapterUser['role'];
  active: boolean;
}): AdapterUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: null,
    role: user.role,
    active: user.active,
  };
}

const USER_FIELDS = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
} as const;

export const prismaSessionAdapter: Adapter = {
  async getUser(id) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: USER_FIELDS,
    });
    return user ? toAdapterUser(user) : null;
  },

  async getUserByEmail(email) {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: USER_FIELDS,
    });
    return user ? toAdapterUser(user) : null;
  },

  async createSession(session) {
    const created = await prisma.session.create({
      data: {
        sessionToken: session.sessionToken,
        userId: session.userId,
        expires: session.expires,
      },
    });
    return {
      sessionToken: created.sessionToken,
      userId: created.userId,
      expires: created.expires,
    };
  },

  async getSessionAndUser(sessionToken) {
    const session = await prisma.session.findUnique({
      where: { sessionToken },
      include: {
        // The soft-delete extension does not reach nested includes, so the
        // filter is explicit here: a deleted or deactivated user must not
        // keep a live session.
        user: { select: { ...USER_FIELDS, deletedAt: true } },
      },
    });

    if (!session) return null;
    if (session.user.deletedAt !== null || !session.user.active) {
      await prisma.session.deleteMany({ where: { sessionToken } });
      return null;
    }
    if (session.expires.getTime() <= Date.now()) {
      await prisma.session.deleteMany({ where: { sessionToken } });
      return null;
    }

    const adapterSession: AdapterSession = {
      sessionToken: session.sessionToken,
      userId: session.userId,
      expires: session.expires,
    };
    return { session: adapterSession, user: toAdapterUser(session.user) };
  },

  async updateSession(session) {
    const updated = await prisma.session.update({
      where: { sessionToken: session.sessionToken },
      data: { expires: session.expires },
    });
    return {
      sessionToken: updated.sessionToken,
      userId: updated.userId,
      expires: updated.expires,
    };
  },

  async deleteSession(sessionToken) {
    // Sessions are genuinely deleted — they are not a business record, and a
    // revoked session that lingers is a security bug.
    await prisma.session.deleteMany({ where: { sessionToken } });
    return null;
  },
};

/** Drop every session for a user. Used when access is revoked or a role changes. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { userId } });
  return count;
}

/** Housekeeping for expired rows. Called by the daily cron. */
export async function purgeExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expires: { lt: new Date() } },
  });
  return count;
}

export { includeDeleted };
