import type { Branding } from './branding';
import { escapeHtml } from './invoice-document';
import type { LocaleConfig } from './locale';
import { formatMoney } from './money';

/**
 * The driver statement — spec 4.5.5.
 *
 * A pure HTML builder, like the invoice document, and for the same reason:
 * the statement is what a driver checks their own records against, so it has
 * to be testable without a browser.
 *
 * It shows every line with its date, route and amount, because a driver who
 * disagrees with a total needs to find *which* run is wrong. A statement that
 * says only "£1,240" invites a phone call nobody can answer.
 */

export interface StatementLine {
  date: string;
  description: string;
  route: string | null;
  amountPence: number;
}

export interface StatementData {
  driverName: string;
  driverReference: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  paidOn: string | null;
  paymentReference: string | null;
  lines: StatementLine[];
  totalPence: number;
}

export function renderPayoutStatement(
  data: StatementData,
  options: { branding: Branding; locale: LocaleConfig; logoSrc?: string | null },
): string {
  const { branding, locale } = options;
  const money = (pence: number) =>
    formatMoney(pence, { currency: locale.currency, locale: locale.locale });

  const heading = options.logoSrc
    ? `<img class="logo" src="${escapeHtml(options.logoSrc)}" alt="${escapeHtml(branding.tradingName)}" />`
    : `<div class="wordmark">${escapeHtml(branding.tradingName)}</div>`;

  const rows = data.lines
    .map(
      (line) => `
        <tr>
          <td class="date">${escapeHtml(line.date)}</td>
          <td>
            <div>${escapeHtml(line.description)}</div>
            ${line.route ? `<div class="muted small">${escapeHtml(line.route)}</div>` : ''}
          </td>
          <td class="amount">${escapeHtml(money(line.amountPence))}</td>
        </tr>`,
    )
    .join('');

  // Stated whether or not it has been paid, and it says which. A statement
  // that reads the same before and after the money moves is one a driver
  // cannot use to tell whether they have been paid.
  const settlement =
    data.paidOn === null
      ? `<div class="notice">Not yet paid. This statement shows what is owed for the period.</div>`
      : `<div class="notice paid">Paid ${escapeHtml(data.paidOn)}${
          data.paymentReference
            ? `, reference ${escapeHtml(data.paymentReference)}`
            : ''
        }.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Statement ${escapeHtml(data.driverReference)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 11px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111827; margin: 0; }
  .sheet { max-width: 190mm; margin: 0 auto; padding: 8mm 0; }
  header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .logo { max-height: 56px; max-width: 220px; }
  .wordmark { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
  .from { text-align: right; font-size: 10px; color: #4b5563; }
  h1 { font-size: 22px; margin: 28px 0 4px; letter-spacing: -0.01em; }
  .period { font-size: 13px; color: #4b5563; margin: 0; }
  .who { margin: 20px 0 4px; }
  .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; border-bottom: 1px solid #d1d5db; padding: 0 0 6px; }
  td { padding: 8px 0; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  th.amount, td.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th.date, td.date { width: 20%; color: #6b7280; font-variant-numeric: tabular-nums; }
  .muted { color: #6b7280; }
  .small { font-size: 10px; }
  .total { display: flex; justify-content: space-between; margin: 12px 0 0; padding-top: 8px; border-top: 1px solid #111827; font-weight: 700; font-size: 14px; }
  .notice { margin-top: 20px; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 10px; color: #4b5563; }
  .notice.paid { border-color: #a7f3d0; background: #ecfdf5; color: #065f46; }
  footer { margin-top: 24px; font-size: 10px; color: #6b7280; }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <div>${heading}</div>
    <div class="from">
      ${multiline(branding.addressLines)}
      ${branding.supportEmail ? `<div>${escapeHtml(branding.supportEmail)}</div>` : ''}
    </div>
  </header>

  <h1>Driver statement</h1>
  <p class="period">${escapeHtml(data.periodStart)} — ${escapeHtml(data.periodEnd)}</p>

  <div class="who">
    <div class="label">Driver</div>
    <div><strong>${escapeHtml(data.driverName)}</strong> · ${escapeHtml(data.driverReference)}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="date">Date</th>
        <th>Work</th>
        <th class="amount">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="total">
    <span>Total</span>
    <span>${escapeHtml(money(data.totalPence))}</span>
  </div>

  ${settlement}

  <footer>
    Queries about this statement
    ${branding.supportEmail ? `to ${escapeHtml(branding.supportEmail)}` : ''}
    ${branding.phone ? `or ${escapeHtml(branding.phone)}` : ''}. Quote
    ${escapeHtml(data.driverReference)} and the period above.
  </footer>
</div>
</body>
</html>`;
}

function multiline(value: string | null): string {
  if (!value) return '';
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('');
}
