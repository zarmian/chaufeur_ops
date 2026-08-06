import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { importStatement } from '@/lib/bank/store';
import { clientIpFrom } from '@/lib/rate-limit';
import { normaliseMapping } from '../preview/route';

/**
 * `POST /api/reconciliation/import` — write the statement.
 *
 * The rows already present are skipped rather than updated, so re-uploading
 * an overlapping period is safe and does not reset a classification somebody
 * has already corrected.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CSV_BYTES = 8 * 1024 * 1024;

export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireCapability('editInvoices');

  const body = (await request.json()) as {
    filename?: string;
    csv?: string;
    mapping?: Record<string, string>;
  };
  const csv = String(body.csv ?? '');

  if (csv.length === 0 || csv.length > MAX_CSV_BYTES) {
    return NextResponse.json(
      { message: 'That file could not be read.' },
      { status: 400 },
    );
  }

  const result = await importStatement(
    {
      filename: String(body.filename ?? 'statement.csv').slice(0, 200),
      csv,
      mapping: normaliseMapping(body.mapping),
    },
    { userId: user.id, ip: clientIpFrom(await headers()) },
  );

  if (!result.ok) {
    return NextResponse.json({ message: result.message }, { status: 400 });
  }

  return NextResponse.json({
    statementId: result.outcome.statementId,
    imported: result.outcome.imported,
    duplicates: result.outcome.duplicates,
    problems: result.outcome.problems,
  });
});
