import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { getBranding } from '@/lib/branding-store';
import { formatDateTime } from '@/lib/dates';
import { absoluteLogoSrc } from '@/lib/invoice-pdf';
import { getLocaleConfig } from '@/lib/locale-store';
import { tryRenderPdf } from '@/lib/pdf';
import { renderReportDocument } from '@/lib/report-document';
import {
  describeFiltersWithNames,
  dimensionFromParams,
  filtersFromParams,
} from '@/lib/report-shared';
import { reportBreakdown, reportSummary, reportTrend } from '@/lib/reports';

/**
 * `GET /api/reports/pdf` — spec 4.6.7, with the criteria in the header.
 *
 * `?format=html` serves the same markup unrendered, which is what a
 * deployment without headless Chromium prints from and what the E2E test
 * reads.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DIMENSION_LABELS: Record<string, string> = {
  jobType: 'job type',
  client: 'client',
  account: 'account',
  driver: 'driver',
  vehicle: 'vehicle',
};

export const GET = withErrorHandling(async (request: Request) => {
  await requireCapability('viewReports');

  const params = new URL(request.url).searchParams;
  const filters = filtersFromParams(params);
  const dimension = dimensionFromParams(params);

  const [summary, breakdown, trend, criteria, branding, locale, logoSrc] =
    await Promise.all([
      reportSummary(filters),
      reportBreakdown(filters, dimension, 100),
      reportTrend(filters),
      describeFiltersWithNames(filters),
      getBranding(),
      getLocaleConfig(),
      absoluteLogoSrc(request.url),
    ]);

  const html = renderReportDocument(
    {
      title: 'Operations report',
      criteria,
      generatedAt: formatDateTime(new Date()),
      summary,
      dimensionLabel: DIMENSION_LABELS[dimension] ?? dimension,
      breakdown,
      trend,
    },
    { branding, locale, logoSrc },
  );

  if (params.get('format') === 'html') {
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const rendered = await tryRenderPdf(html, { landscape: true });
  if (!rendered.ok) {
    // 503 rather than 500: nothing is wrong with the report, and the same
    // document is available as HTML with `?format=html`.
    return new Response(rendered.message, {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(new Uint8Array(rendered.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="report-${stamp}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
});
