import * as XLSX from 'xlsx';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { requireExportBudget } from '@/lib/rate-limit';
import { buildComplianceReport, toExportRows } from '@/lib/compliance-report';
import { getComplianceThresholds } from '@/lib/settings';

/**
 * The compliance list as a spreadsheet.
 *
 * Operators forward this to whoever chases renewals, and licensing audits ask
 * for it. Generated on demand rather than stored, so it can never be stale.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const user = await requireCapability('viewJobs');
  // Spec 6.7.5. An unpaginated spreadsheet is the most expensive thing a
  // signed-in user can ask for, so it is the one worth a budget.
  await requireExportBudget(user.id);

  const thresholds = await getComplianceThresholds();
  const report = await buildComplianceReport(thresholds);
  const rows = toExportRows(report);

  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Compliance');

  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(buffer, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="compliance-${stamp}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
});
