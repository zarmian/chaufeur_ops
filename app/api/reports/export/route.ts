import * as XLSX from 'xlsx';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import {
  describeFiltersWithNames,
  dimensionFromParams,
  filtersFromParams,
} from '@/lib/report-shared';
import {
  reportBreakdown,
  reportDetail,
  reportSummary,
  toBreakdownExportRows,
  toDetailExportRows,
} from '@/lib/reports';

/**
 * The report as a spreadsheet — spec 4.6.7.
 *
 * Three sheets: the summary with the filter criteria printed on it, the
 * breakdown, and the jobs behind them. The criteria matter as much as the
 * numbers: a spreadsheet of figures with no statement of what was included
 * is one somebody will read as the whole business.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (request: Request) => {
  await requireCapability('viewReports');

  const params = new URL(request.url).searchParams;
  const filters = filtersFromParams(params);
  const dimension = dimensionFromParams(params);

  const [summary, breakdown, detail, criteria] = await Promise.all([
    reportSummary(filters),
    reportBreakdown(filters, dimension, 500),
    // Unpaginated on purpose: an export that stopped at page one would be
    // the kind of quietly-wrong figure this report exists to replace.
    reportDetail(filters, { skip: 0, take: 10_000 }),
    describeFiltersWithNames(filters),
  ]);

  const book = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.json_to_sheet([
      { Field: 'Criteria', Value: criteria },
      { Field: 'Jobs', Value: summary.jobs },
      { Field: 'Revenue', Value: summary.revenuePence / 100 },
      { Field: 'Costs', Value: summary.costsPence / 100 },
      { Field: 'Gross profit', Value: summary.profitPence / 100 },
      { Field: 'Margin %', Value: summary.marginPct ?? '' },
      // Next to revenue rather than in a footnote: a revenue figure without
      // the unpriced count beside it is misleading.
      { Field: 'Unpriced jobs', Value: summary.unpricedJobs },
    ]),
    'Summary',
  );

  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.json_to_sheet(toBreakdownExportRows(breakdown)),
    'Breakdown',
  );

  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.json_to_sheet(toDetailExportRows(detail.rows)),
    'Jobs',
  );

  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(buffer, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="report-${stamp}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
});
