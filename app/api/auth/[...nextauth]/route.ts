import { handlers } from '@/lib/auth';

export const { GET, POST } = handlers;

// Argon2 and Prisma both need the Node runtime.
export const runtime = 'nodejs';
