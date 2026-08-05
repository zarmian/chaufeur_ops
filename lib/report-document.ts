import type { Branding } from './branding';
import { escapeHtml } from './invoice-document';
import type { LocaleConfig } from './locale';
import { formatMoney } from './money';
import type { BreakdownRow, ReportSummary, TrendPoint } from './reports';

/**
 * The report as a printed document — spec 4.6.7.
 *
 * A pure HTML builder, like the invoice and the statement. The filter
 * criteria are printed at the top, not in a footnote: a page of figures with
 * no statement of what was included is one somebody will read as the whole
 * business, and then forward.
 *
 * The unpriced count sits in the same row as revenue for the same reason it
 * does on screen. A revenue total that silently excludes the jobs nobody
 * priced reads as a smaller business rather than a data-quality problem.
 */

export interface ReportDocumentData {
  title: string;
  criteria: string;
  generatedAt: string;
  summary: ReportSummary;
  dimensionLabel: string;
  breakdown: BreakdownRow[];
  trend: TrendPoint[];
}

export function renderReportDocument(
  data: ReportDocumentData,
  options: { branding: Branding; locale: LocaleConfig; logoSrc?: string | null },
): string {
  const { branding, locale } = options;
  const money = (pence: number) =>
    formatMoney(pence, { currency: locale.currency, locale: locale.locale });

  const heading = options.logoSrc
    ? `<img class="logo" src="${escapeHtml(options.logoSrc)}" alt="${escapeHtml(branding.tradingName)}" />`
    : `<div class="wordmark">${escapeHtml(branding.tradingName)}</div>`;

  const tiles = [
    { label: 'Jobs', value: String(data.summary.jobs) },
    { label: 'Revenue', value: money(data.summary.revenuePence) },
    { label: 'Costs', value: money(data.summary.costsPence) },
    { label: 'Gross profit', value: money(data.summary.profitPence) },
    {
      label: 'Margin',
      value:
        data.summary.marginPct === null ? '—' : `${data.summary.marginPct}%`,
    },
    {
      label: 'Unpriced',
      value: String(data.summary.unpricedJobs),
      warn: data.summary.unpricedJobs > 0,
    },
  ]
    .map(
      (tile) => `
      <div class="tile${tile.warn ? ' warn' : ''}">
        <div class="tile-label">${escapeHtml(tile.label)}</div>
        <div class="tile-value">${escapeHtml(tile.value)}</div>
      </div>`,
    )
    .join('');

  const breakdownRows = data.breakdown
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.label)}</td>
        <td class="num">${row.jobs}</td>
        <td class="num">${escapeHtml(money(row.revenuePence))}</td>
        <td class="num">${escapeHtml(money(row.costsPence))}</td>
        <td class="num${row.profitPence < 0 ? ' bad' : ''}">${escapeHtml(money(row.profitPence))}</td>
        <td class="num">${row.marginPct === null ? '—' : `${row.marginPct}%`}</td>
      </tr>`,
    )
    .join('');

  const trendRows = data.trend
    .map(
      (point) => `
      <tr>
        <td>${escapeHtml(point.month)}</td>
        <td class="num">${point.jobs}</td>
        <td class="num">${escapeHtml(money(point.revenuePence))}</td>
        <td class="num${point.profitPence < 0 ? ' bad' : ''}">${escapeHtml(money(point.profitPence))}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(data.title)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font: 10px/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111827; margin: 0; }
  .sheet { padding: 6mm 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .logo { max-height: 44px; max-width: 180px; }
  .wordmark { font-size: 17px; font-weight: 700; }
  .meta { text-align: right; font-size: 9px; color: #6b7280; }
  h1 { font-size: 18px; margin: 18px 0 2px; }
  .criteria { font-size: 10px; color: #4b5563; margin: 0 0 14px; }
  .tiles { display: flex; gap: 8px; margin-bottom: 16px; }
  .tile { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; }
  .tile.warn { border-color: #fcd34d; background: #fffbeb; }
  .tile-label { font-size: 8px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; }
  .tile-value { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
  h2 { font-size: 12px; margin: 16px 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; border-bottom: 1px solid #d1d5db; padding: 0 6px 5px 0; }
  td { padding: 5px 6px 5px 0; border-bottom: 1px solid #f3f4f6; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.bad { color: #b91c1c; font-weight: 700; }
  footer { margin-top: 16px; font-size: 8px; color: #6b7280; }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <div>${heading}</div>
    <div class="meta">Generated ${escapeHtml(data.generatedAt)}</div>
  </header>

  <h1>${escapeHtml(data.title)}</h1>
  <p class="criteria">${escapeHtml(data.criteria)}</p>

  <div class="tiles">${tiles}</div>

  <h2>By ${escapeHtml(data.dimensionLabel)}</h2>
  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th class="num">Jobs</th>
        <th class="num">Revenue</th>
        <th class="num">Cost</th>
        <th class="num">Profit</th>
        <th class="num">Margin</th>
      </tr>
    </thead>
    <tbody>${breakdownRows}</tbody>
  </table>

  <h2>Month on month</h2>
  <table>
    <thead>
      <tr>
        <th>Month</th>
        <th class="num">Jobs</th>
        <th class="num">Revenue</th>
        <th class="num">Gross profit</th>
      </tr>
    </thead>
    <tbody>${trendRows}</tbody>
  </table>

  <footer>
    Figures are computed from job finance records. Cancelled work is excluded
    unless the criteria above say otherwise.
  </footer>
</div>
</body>
</html>`;
}
