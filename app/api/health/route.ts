import { NextResponse } from 'next/server';
import { checkDatabase } from '@/lib/db-health';

/**
 * Uptime monitoring hits this, and so does anyone diagnosing a fresh install.
 *
 * It checks the database rather than just returning 200, because an app that
 * renders but cannot reach Postgres is down as far as the ops team is
 * concerned — and it distinguishes "unreachable" from "reachable but no
 * tables", which are different mistakes with different fixes.
 *
 * Deliberately says nothing about credentials, hosts or install state.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const database = await checkDatabase();
  const timestamp = new Date().toISOString();

  if (database.ok) {
    return NextResponse.json({
      status: 'ok',
      database: 'ok',
      schema: 'ok',
      latencyMs: database.latencyMs,
      timestamp,
    });
  }

  console.error('Health check failed', database.reason, database.summary);

  return NextResponse.json(
    {
      status: 'error',
      database: database.reason === 'no_schema' ? 'ok' : 'unreachable',
      schema: database.reason === 'no_schema' ? 'missing' : 'unknown',
      reason: database.reason,
      detail: database.summary,
      remedy: database.remedy,
      latencyMs: database.latencyMs,
      timestamp,
    },
    { status: 503 },
  );
}
