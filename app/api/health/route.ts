import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * Uptime monitoring hits this. It checks the database rather than just
 * returning 200, because an app that renders but cannot reach Postgres is
 * down as far as the ops team is concerned.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: 'ok',
      database: 'ok',
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Health check failed', error);
    return NextResponse.json(
      {
        status: 'error',
        database: 'unreachable',
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
