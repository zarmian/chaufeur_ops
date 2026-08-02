import { randomUUID } from 'node:crypto';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { encode as defaultEncode } from 'next-auth/jwt';
import { z } from 'zod';
import { prismaSessionAdapter } from './auth-adapter';
import { verifyPassword } from './password';
import { prisma } from './prisma';
import {
  checkLoginRateLimit,
  clientIpFrom,
  recordLoginAttempt,
} from './rate-limit';

const SESSION_MAX_AGE_DAYS = Number(process.env.SESSION_MAX_AGE_DAYS ?? 30);
export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60;

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

/**
 * Auth.js v5, credentials provider, database sessions.
 *
 * Credentials sign-in does not natively create a database session, so the
 * `jwt` callback mints an opaque session token, writes the `Session` row
 * through the adapter, and `jwt.encode` returns that token as the cookie
 * value. Auth.js then reads the cookie as a session token and resolves it
 * through `getSessionAndUser` — the row in Postgres is the authority, which
 * is what lets an admin revoke access immediately.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: prismaSessionAdapter,
  session: {
    strategy: 'database',
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
  pages: {
    signIn: '/login',
  },
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(rawCredentials, request) {
        const parsed = credentialsSchema.safeParse(rawCredentials);
        const ip = clientIpFrom(request.headers);

        if (!parsed.success) {
          await recordLoginAttempt(ip, null, false);
          return null;
        }

        const { email, password } = parsed.data;

        // Checked again here as well as in the sign-in action: the action
        // gives the user a useful lockout message, this stops anyone posting
        // straight at the endpoint.
        const limit = await checkLoginRateLimit(ip);
        if (!limit.allowed) return null;

        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            active: true,
            passwordHash: true,
          },
        });

        // Verify against a dummy hash when the user is missing so the
        // response time does not reveal which emails exist.
        const storedHash = user?.passwordHash ?? DUMMY_HASH;
        const passwordMatches = await verifyPassword(storedHash, password);

        if (!user || !user.active || !passwordMatches) {
          await recordLoginAttempt(ip, email, false);
          return null;
        }

        await Promise.all([
          prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
          }),
          recordLoginAttempt(ip, email, true),
        ]);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          active: user.active,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, account }) {
      if (account?.provider === 'credentials' && user?.id) {
        const sessionToken = randomUUID();
        const expires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
        await prismaSessionAdapter.createSession?.({
          sessionToken,
          userId: user.id,
          expires,
        });
        token.sessionToken = sessionToken;
      }
      return token;
    },
    async session({ session, user }) {
      if (user) {
        session.user.id = user.id;
        session.user.role = user.role;
        session.user.active = user.active;
      }
      return session;
    },
  },
  jwt: {
    async encode(params) {
      // For credentials sign-in the cookie carries the database session
      // token verbatim rather than an encrypted JWT.
      if (params.token?.sessionToken) {
        return params.token.sessionToken;
      }
      return defaultEncode(params);
    },
  },
});

/**
 * Argon2id hash of a value no one knows, used to keep the failure path's
 * timing similar to the success path.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$8kD4ZQXqZmZ0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Y';
