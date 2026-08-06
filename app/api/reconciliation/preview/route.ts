import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { previewImport } from '@/lib/bank/store';
import { detectLayout } from '@/lib/bank/statement';
import { parseCsvRows } from '@/lib/csv';

/**
 * `POST /api/reconciliation/preview` — what an import would do.
 *
 * Writes nothing. Answers the two questions a browser cannot: how many of
 * these rows are already here, and can the columns be read at all.
 *
 * A statement is not enormous but it is not tiny either, so the body is
 * capped — a 40 MB paste should be refused rather than parsed.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CSV_BYTES = 8 * 1024 * 1024;

export const POST = withErrorHandling(async (request: Request) => {
  await requireCapability('editInvoices');

  const body = (await request.json()) as {
    csv?: string;
    mapping?: Record<string, string>;
  };
  const csv = String(body.csv ?? '');

  if (csv.length === 0) {
    return NextResponse.json(
      { message: 'There was nothing in that file.' },
      { status: 400 },
    );
  }
  if (csv.length > MAX_CSV_BYTES) {
    return NextResponse.json(
      { message: 'That file is larger than a bank statement should be.' },
      { status: 413 },
    );
  }

  const mapping = normaliseMapping(body.mapping);
  const preview = await previewImport(csv, mapping);

  const rawHeaders = parseCsvRows(csv)[0] ?? [];
  // Only asks for a mapping when the columns were genuinely unrecognised and
  // the operator has not already supplied one.
  const needsMapping =
    preview.parse.rows.length === 0 && !detectLayout(rawHeaders) && !mapping;

  return NextResponse.json({
    layout: preview.layout,
    fresh: preview.fresh,
    duplicates: preview.duplicates,
    problems: preview.parse.problems,
    periodStart: preview.periodStart?.toISOString().slice(0, 10) ?? null,
    periodEnd: preview.periodEnd?.toISOString().slice(0, 10) ?? null,
    headers: rawHeaders,
    needsMapping,
    rows: preview.parse.rows.slice(0, 25).map((row) => ({
      occurredOn: row.occurredOn.toISOString().slice(0, 10),
      description: row.description,
      amountPence: row.amountPence,
      bankRef: row.bankRef,
    })),
  });
});

/** A mapping is only a mapping if it names at least a date and a description. */
export function normaliseMapping(
  input: Record<string, string> | undefined,
):
  | {
      date: string;
      description: string;
      amount?: string;
      debit?: string;
      credit?: string;
    }
  | undefined {
  if (!input) return undefined;
  const date = (input.date ?? '').trim();
  const description = (input.description ?? '').trim();
  if (!date || !description) return undefined;

  return {
    date,
    description,
    ...(input.amount?.trim() ? { amount: input.amount.trim() } : {}),
    ...(input.debit?.trim() ? { debit: input.debit.trim() } : {}),
    ...(input.credit?.trim() ? { credit: input.credit.trim() } : {}),
  };
}
