import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { getBulkOperation } from '@/lib/bulk';

/**
 * `GET /api/jobs/bulk/:id` — progress for a background bulk action, spec 6.5.4.
 *
 * The counterpart to running the work behind the response. A batch that
 * disappears from the screen the moment it is submitted is one the operator
 * has to guess about, and guessing usually means submitting it again.
 *
 * Deliberately small: counts, status, and the refusals by reference. The
 * refusals are the part worth waiting for — the successes speak for
 * themselves on the job list.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    await requireCapability('editJobs');
    const { id } = await context.params;

    const operation = await getBulkOperation(id);
    if (!operation) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'No such operation' } },
        { status: 404 },
      );
    }

    return NextResponse.json(
      {
        status: operation.status,
        total: operation.total,
        succeeded: operation.succeeded,
        failed: operation.failed,
        failures: operation.failures,
        finishedAt: operation.finishedAt,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  },
);
