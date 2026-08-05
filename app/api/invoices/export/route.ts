import * as XLSX from 'xlsx';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import {
  agingReport,
  invoicesForExport,
  toAgingExportRows,
  toLedgerExportRows,
} from '@/lib/invoice-list';

/**
 * The ledger and the aging report as spreadsheets — spec 4.4.5.
 *
 * The ledger export honours whatever filters the page was showing, so what
 * lands in the sheet is what the operator was looking at. Generated on demand
 * rather than stored, so it can never be stale.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (request: Request) => {
  await requireCapability('viewInvoices');

  const params = new URL(request.url).searchParams;
  const stamp = new Date().toISOString().slice(0, 10);

  const { name, rows } =
    params.get('report') === 'aging'
      ? { name: 'Aging', rows: toAgingExportRows((await agingReport()).rows) }
      : {
          name: 'Invoices',
          rows: toLedgerExportRows(
            await invoicesForExport({
              status: filter(params, 'status'),
              clientId: filter(params, 'clientId'),
              accountId: filter(params, 'accountId'),
              from: date(params, 'from'),
              to: date(params, 'to'),
              overdueOnly: params.get('overdue') === 'true',
            }),
          ),
        };

  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, name);

  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });

  return new Response(buffer, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${name.toLowerCase()}-${stamp}.xlsx"`,
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
