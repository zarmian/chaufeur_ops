import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { buildComplianceReport, toApiShape } from '@/lib/compliance-report';
import { getComplianceThresholds } from '@/lib/settings';

/**
 * `GET /api/compliance/expiring?days=N` — the structure in docs/api-spec.md.
 *
 * `days` widens the warning threshold for this call only; the critical
 * threshold stays as configured, so "everything lapsing this quarter" is one
 * query without changing what the dashboard shows everyone else.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (request: Request) => {
  await requireCapability('viewJobs');

  const url = new URL(request.url);
  const requestedDays = Number(url.searchParams.get('days'));

  const configured = await getComplianceThresholds();
  const thresholds =
    Number.isFinite(requestedDays) && requestedDays > 0
      ? { ...configured, warningDays: Math.floor(requestedDays) }
      : configured;

  const report = await buildComplianceReport(thresholds);
  return NextResponse.json(toApiShape(report));
});
