import * as XLSX from 'xlsx';
import { withErrorHandling, MAX_PAGE_SIZE } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { listPayouts, toPayoutExportRows } from '@/lib/payout-store';

/**
 * The payout list as a spreadsheet.
 *
 * Honours the filters the page was showing, so what lands in the sheet is
 * what the operator was looking at. Generated on demand rather than stored,
 * so it can never be stale.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (request: Request) => {
  await requireCapability('viewInvoices');

  const params = new URL(request.url).searchParams;

  const { rows } = await listPayouts(
    {
      page: 1,
      pageSize: MAX_PAGE_SIZE,
      skip: 0,
      // Unpaginated on purpose: an export that stopped at page one would be
      // the kind of quietly-wrong figure this exists to replace.
      take: 10_000,
      q: null,
      sort: 'periodStart',
      dir: 'desc',
    },
    {
      driverId: filter(params, 'driverId'),
      status: filter(params, 'status'),
      from: date(params, 'from'),
      to: date(params, 'to'),
    },
  );

  const sheet = XLSX.utils.json_to_sheet(toPayoutExportRows(rows));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Payouts');

  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(buffer, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="payouts-${stamp}.xlsx"`,
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
