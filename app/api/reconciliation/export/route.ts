import * as XLSX from 'xlsx';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { requireExportBudget } from '@/lib/rate-limit';
import {
  toTransactionExportRows,
  transactionsForExport,
} from '@/lib/bank/list';

/**
 * The statement, with its classifications and allocations — spec 4.8.5.5.
 *
 * Honours whatever filters the page was showing, so what lands in the sheet
 * is what the operator was looking at. Generated on demand rather than
 * stored, so it can never be stale.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (request: Request) => {
  const user = await requireCapability('viewInvoices');
  // Spec 6.7.5. An unpaginated spreadsheet is the most expensive thing a
  // signed-in user can ask for, so it is the one worth a budget.
  await requireExportBudget(user.id);

  const params = new URL(request.url).searchParams;
  const stamp = new Date().toISOString().slice(0, 10);

  const rows = toTransactionExportRows(
    await transactionsForExport({
      q: filter(params, 'q'),
      kind: filter(params, 'kind'),
      statementId: filter(params, 'statementId'),
      from: date(params, 'from'),
      to: date(params, 'to'),
      state: filter(params, 'state'),
    }),
  );

  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Reconciliation');

  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });

  return new Response(buffer, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="reconciliation-${stamp}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
});

function filter(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  if (!value || value === 'all') return null;
  return value;
}

function date(params: URLSearchParams, key: string): Date | null {
  const value = params.get(key);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T00:00:00.000Z`);
}
