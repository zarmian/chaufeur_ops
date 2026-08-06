import type { Branding } from './branding';
import type { LocaleConfig } from './locale';
import { formatMoney } from './money';

/**
 * The invoice as a printed document — spec 4.3.8.
 *
 * A pure HTML builder. It takes everything it needs as arguments and reaches
 * nothing: no database, no settings lookup, no `Date.now()`. That makes the
 * document testable without a browser, and means the same markup serves the
 * on-screen preview and the PDF rather than two templates drifting apart.
 *
 * Everything identifying the company comes from branding. There is no
 * customer name in this file, and CI would fail if there were.
 */

export interface InvoiceDocumentLine {
  description: string;
  amountPence: number;
  reference: string | null;
  /** Shown under the description — the date the work happened. */
  occurredOn: string | null;
}

export interface InvoiceDocumentData {
  number: string;
  issueDate: string;
  dueDate: string;
  status: string;
  isCreditNote: boolean;
  recipientName: string;
  recipientAddress: string | null;
  lines: InvoiceDocumentLine[];
  netPence: number;
  vatPence: number;
  grossPence: number;
  paidPence: number;
  vatRatePct: number;
  paymentTermsDays: number | null;
  notes: string | null;
}

export interface InvoiceDocumentOptions {
  branding: Branding;
  locale: LocaleConfig;
  /** Absolute or app-relative URL. Omitted when there is no logo set. */
  logoSrc?: string | null;
}

/**
 * Escape for HTML text and attributes.
 *
 * Every value in this document is operator-typed — a client name, a line
 * description, bank details pasted from a letter. None of it is trusted, and
 * a template that builds a string by concatenation has to say so somewhere.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Multi-line settings fields (address, bank details) as HTML paragraphs. */
function lines(value: string | null): string {
  if (!value) return '';
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('');
}

export function renderInvoiceDocument(
  data: InvoiceDocumentData,
  options: InvoiceDocumentOptions,
): string {
  const { branding, locale } = options;
  const money = (pence: number) =>
    formatMoney(pence, { currency: locale.currency, locale: locale.locale });

  const title = data.isCreditNote ? 'Credit note' : 'Invoice';
  const outstanding = Math.max(0, data.grossPence - data.paidPence);

  const heading = options.logoSrc
    ? `<img class="logo" src="${escapeHtml(options.logoSrc)}" alt="${escapeHtml(branding.tradingName)}" />`
    : `<div class="wordmark">${escapeHtml(branding.tradingName)}</div>`;

  // Identifiers only when they exist. A letterhead reading "VAT number:" with
  // nothing after it looks like a system that lost the number, and on a
  // document going to a client that is worse than not printing the row.
  const identifiers = [
    branding.legalName ? escapeHtml(branding.legalName) : null,
    branding.companyNumber
      ? `Company number ${escapeHtml(branding.companyNumber)}`
      : null,
    branding.taxNumber
      ? `${escapeHtml(locale.taxName)} number ${escapeHtml(branding.taxNumber)}`
      : null,
  ]
    .filter(Boolean)
    .map((line) => `<div>${line}</div>`)
    .join('');

  const contact = [
    branding.phone ? escapeHtml(branding.phone) : null,
    branding.supportEmail ? escapeHtml(branding.supportEmail) : null,
    branding.websiteUrl ? escapeHtml(branding.websiteUrl) : null,
  ]
    .filter(Boolean)
    .map((line) => `<div>${line}</div>`)
    .join('');

  const lineRows = data.lines
    .map(
      (line) => `
        <tr>
          <td>
            <div>${escapeHtml(line.description)}</div>
            ${line.occurredOn ? `<div class="muted small">${escapeHtml(line.occurredOn)}</div>` : ''}
          </td>
          <td class="ref">${line.reference ? escapeHtml(line.reference) : ''}</td>
          <td class="amount">${escapeHtml(money(line.amountPence))}</td>
        </tr>`,
    )
    .join('');

  const terms =
    data.paymentTermsDays === null
      ? `Payment is due by ${escapeHtml(data.dueDate)}.`
      : `Payment terms: ${data.paymentTermsDays} days. Due by ${escapeHtml(data.dueDate)}.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(data.number)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body {
    font: 11px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #111827;
    margin: 0;
  }
  .sheet { max-width: 190mm; margin: 0 auto; padding: 8mm 0; }
  header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .logo { max-height: 56px; max-width: 220px; }
  .wordmark { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
  .from { text-align: right; font-size: 10px; color: #4b5563; }
  h1 { font-size: 22px; margin: 28px 0 4px; letter-spacing: -0.01em; }
  .number { font-size: 13px; color: #4b5563; margin: 0; }
  .parties { display: flex; justify-content: space-between; gap: 24px; margin: 24px 0 8px; }
  .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin-bottom: 4px; }
  .dates { text-align: right; }
  .dates div + div { margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; border-bottom: 1px solid #d1d5db; padding: 0 0 6px; }
  td { padding: 8px 0; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  th.amount, td.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th.ref, td.ref { color: #6b7280; font-variant-numeric: tabular-nums; width: 22%; }
  .muted { color: #6b7280; }
  .small { font-size: 10px; }
  .totals { margin-left: auto; width: 62mm; margin-top: 12px; }
  .totals div { display: flex; justify-content: space-between; padding: 3px 0; }
  .totals .grand { border-top: 1px solid #111827; margin-top: 4px; padding-top: 6px; font-weight: 700; font-size: 13px; }
  .totals .outstanding { border-top: 1px solid #d1d5db; margin-top: 4px; padding-top: 6px; font-weight: 700; }
  footer { margin-top: 28px; border-top: 1px solid #e5e7eb; padding-top: 12px; display: flex; gap: 32px; }
  footer section { flex: 1; }
  .notes { margin-top: 16px; white-space: pre-wrap; }
  @media print { .sheet { padding: 0; } }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <div>${heading}</div>
    <div class="from">
      ${lines(branding.addressLines)}
      ${contact}
      ${identifiers}
    </div>
  </header>

  <h1>${title}</h1>
  <p class="number">${escapeHtml(data.number)}</p>

  <div class="parties">
    <div>
      <div class="label">Billed to</div>
      <div><strong>${escapeHtml(data.recipientName)}</strong></div>
      ${lines(data.recipientAddress)}
    </div>
    <div class="dates">
      <div><span class="label">Issued</span> ${escapeHtml(data.issueDate)}</div>
      <div><span class="label">Due</span> ${escapeHtml(data.dueDate)}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th class="ref">Reference</th>
        <th class="amount">Amount</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  <div class="totals">
    <div><span>Net</span><span>${escapeHtml(money(data.netPence))}</span></div>
    <div><span>${escapeHtml(locale.taxName)} at ${data.vatRatePct}%</span><span>${escapeHtml(money(data.vatPence))}</span></div>
    <div class="grand"><span>Total</span><span>${escapeHtml(money(data.grossPence))}</span></div>
    ${
      data.paidPence !== 0
        ? `<div><span>Paid</span><span>${escapeHtml(money(data.paidPence))}</span></div>
    <div class="outstanding"><span>Outstanding</span><span>${escapeHtml(money(outstanding))}</span></div>`
        : ''
    }
  </div>

  ${data.notes ? `<div class="notes small muted">${escapeHtml(data.notes)}</div>` : ''}

  <footer>
    <section>
      <div class="label">Payment</div>
      <div class="small">${terms}</div>
      ${branding.bankDetails ? `<div class="small" style="margin-top:6px">${lines(branding.bankDetails)}</div>` : ''}
    </section>
    <section>
      <div class="label">Queries</div>
      <div class="small muted">
        ${branding.supportEmail ? `<div>${escapeHtml(branding.supportEmail)}</div>` : ''}
        ${branding.phone ? `<div>${escapeHtml(branding.phone)}</div>` : ''}
        <div>Quote ${escapeHtml(data.number)}.</div>
      </div>
    </section>
  </footer>
</div>
</body>
</html>`;
}
