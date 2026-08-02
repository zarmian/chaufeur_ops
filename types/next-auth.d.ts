import type { UserRole } from '@prisma/client';
import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      active: boolean;
    } & DefaultSession['user'];
  }

  interface User {
    role: UserRole;
    active: boolean;
  }
}

declare module 'next-auth/adapters' {
  interface AdapterUser {
    role: UserRole;
    active: boolean;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /** Set for credentials sign-in: the opaque database session token. */
    sessionToken?: string;
  }
}

export {};
