import type { Branding } from './branding';
import type { LocaleConfig } from './locale';
import { formatMoney } from './money';
import { invoiceTax, type TaxBand, type VatTreatment } from './vat';

/**
 * The invoice as a printed document — spec 4.3.8.
 *
 * A pure HTML builder. It takes everything it needs as arguments and reaches
 * nothing: no database, no settings lookup, no `Date.now()`. That makes the
 * document testable without a browser, and means the same markup serves the
 * on-screen preview and the PDF rather than two templates drifting apart.
 *
 * The layout follows the format the operator has been sending by hand:
 * masthead, From and Bill To side by side, an itemised table with quantity and
 * rate columns, payment details in a box beside the totals, and a signature.
 * What changed underneath is the line and the totals. A line used to read
 * "WLX-000767 — Heathrow to Marylebone" on one row; it now carries the same
 * facts the jobs list shows, because an invoice of bare job numbers cannot be
 * checked against a diary. And the totals print one band per tax treatment, so
 * an invoice mixing taxed, tax-inclusive and non-qualifying work says which is
 * which instead of averaging them into a figure that matches nothing.
 *
 * Everything identifying the company comes from branding. There is no
 * customer name in this file, and CI would fail if there were.
 */

export interface InvoiceDocumentLine {
  /** First line of the stored description: the title, set in bold. */
  title: string;
  /** The rest: date, pickup, drop-off — one per row, beneath the title. */
  details: string[];
  amountPence: number;
  /** Pass-through part of the amount. Shown as a note, never taxed. */
  disbursementPence: number;
  vatTreatment: VatTreatment;
  /** Null when the line has no honest quantity — see `buildJobLine`. */
  quantity: number | null;
  quantityUnit: string | null;
  unitPricePence: number | null;
}

export interface InvoiceDocumentData {
  number: string;
  issueDate: string;
  dueDate: string;
  status: string;
  isCreditNote: boolean;
  recipientName: string;
  recipientAddress: string | null;
  recipientEmail: string | null;
  lines: InvoiceDocumentLine[];
  netPence: number;
  vatPence: number;
  grossPence: number;
  paidPence: number;
  vatRatePct: number;
  paymentTermsDays: number | null;
  notes: string | null;
  /** Printed under the signature rule. Null leaves the rule blank to sign. */
  signatory: string | null;
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

/** Multi-line settings fields (address, bank details) as HTML rows. */
function lines(value: string | null): string {
  if (!value) return '';
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('');
}

/** A quantity as a person would write it: `10`, not `10.00`; `2.5` stays. */
function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * What a tax band is called on the document.
 *
 * Named by what it does to the money rather than by the enum, because the
 * person reading it is being asked to pay and "INCLUSIVE" explains nothing.
 * The tax's own name comes from locale, so a non-UK install says its own word.
 */
function bandLabel(
  band: TaxBand,
  taxName: string,
  number: string | null,
  money: (pence: number) => string,
): string {
  const identified = number ? `${taxName} no. ${number}` : taxName;
  // The exempt band's own figure is always zero, and a bare "£0.00" beside it
  // reads as an oversight. Naming what it is zero *on* is the useful half.
  if (band.treatment === 'EXEMPT') {
    return `${taxName} — not chargeable on ${money(band.netPence + band.disbursementPence)}`;
  }
  if (band.treatment === 'INCLUSIVE') {
    return `${identified} at ${band.ratePct}% (included above)`;
  }
  return `${identified} at ${band.ratePct}%`;
}

export function renderInvoiceDocument(
  data: InvoiceDocumentData,
  options: InvoiceDocumentOptions,
): string {
  const { branding, locale } = options;
  const money = (pence: number) =>
    formatMoney(pence, { currency: locale.currency, locale: locale.locale });

  const title = data.isCreditNote ? 'Credit note' : 'Invoice';

  // Recomputed from the lines rather than taken from the header, so the bands
  // and the total on the page cannot disagree with each other. The header's
  // stored figures are what the ledger reconciles against; if the two ever
  // diverge, the document is the one that has to add up in front of a client.
  const tax = invoiceTax(
    data.lines.map((line) => ({
      amountPence: line.amountPence,
      disbursementPence: line.disbursementPence,
      treatment: line.vatTreatment,
    })),
    data.vatRatePct,
  );

  // From the total this document prints, not the stored one. Subtracting a
  // payment from a figure the page never shows produces a "Due" that does not
  // follow from anything above it.
  const outstanding = tax.grossPence - data.paidPence;

  const heading = options.logoSrc
    ? `<img class="logo" src="${escapeHtml(options.logoSrc)}" alt="${escapeHtml(branding.tradingName)}" />`
    : `<div class="wordmark">${escapeHtml(branding.tradingName)}</div>`;

  const fromLines = [
    branding.legalName ?? branding.tradingName,
    ...(branding.addressLines ?? '').split(/\r?\n/),
    [branding.supportEmail, branding.phone].filter(Boolean).join(', '),
    branding.companyNumber ? `Company number ${branding.companyNumber}` : '',
  ]
    .map((line) => line.trim())
    .filter(Boolean);

  const lineRows = data.lines
    .map((line, index) => {
      const quantity =
        line.quantity === null
          ? '<td class="qty"></td><td class="rate"></td>'
          : `<td class="qty"><strong>${escapeHtml(formatQuantity(line.quantity))}</strong>${
              line.quantityUnit
                ? ` <span class="muted">(${escapeHtml(line.quantityUnit)})</span>`
                : ''
            }</td><td class="rate">${
              line.unitPricePence === null
                ? ''
                : escapeHtml(money(line.unitPricePence))
            }</td>`;

      // Named on the line it belongs to, not only in the totals. A client
      // querying "why is there no tax on £7.50 of this" should find the
      // answer next to the £7.50.
      const disbursement =
        line.disbursementPence !== 0
          ? `<div class="note">Includes ${escapeHtml(money(line.disbursementPence))} paid on your behalf, not subject to ${escapeHtml(locale.taxName)}</div>`
          : '';

      return `
        <tr>
          <td class="idx">${index + 1}.</td>
          <td class="desc">
            <div class="line-title">${escapeHtml(line.title)}</div>
            ${line.details.map((detail) => `<div class="detail">${escapeHtml(detail)}</div>`).join('')}
            ${disbursement}
          </td>
          ${quantity}
          <td class="amount">${escapeHtml(money(line.amountPence))}</td>
        </tr>`;
    })
    .join('');

  const bandRows = tax.bands
    .map(
      (band) =>
        `<div class="row muted-row"><span>${escapeHtml(bandLabel(band, locale.taxName, branding.taxNumber, money))}</span><span>${escapeHtml(money(band.taxPence))}</span></div>`,
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
  /* No margin declared here on purpose. A CSS page margin silently overrides
     the one page.pdf() is given, which is how body text ends up printing
     through the running footer. Margins for this document live in
     lib/pdf.ts. */
  @page { size: A4; }
  * { box-sizing: border-box; }
  body {
    font: 11px/1.55 "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #1f2937;
    margin: 0;
  }
  .sheet { max-width: 190mm; margin: 0 auto; }

  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  .logo { max-height: 60px; max-width: 240px; }
  .wordmark { font-size: 22px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
  .masthead { text-align: right; }
  h1 { font-size: 26px; margin: 0 0 8px; letter-spacing: -0.01em; font-weight: 700; }
  .masthead div { margin-top: 3px; }
  .masthead .k { font-weight: 700; }

  .rule { height: 1px; background: #e5e7eb; margin: 16px 0 20px; }

  .parties { display: flex; gap: 32px; }
  .parties section { flex: 1; }
  .label { font-size: 12px; font-weight: 700; margin-bottom: 6px; }
  .party-name { text-transform: uppercase; margin-bottom: 6px; }
  .parties .muted { color: #6b7280; }

  table { width: 100%; border-collapse: collapse; margin-top: 24px; }
  thead th {
    background: #eef2f6; color: #6b7280; font-weight: 600;
    text-align: left; padding: 10px 8px; font-size: 11px;
  }
  tbody td { padding: 12px 8px; border-bottom: 1px solid #eef2f6; vertical-align: middle; }
  /* A row is kept whole where the page allows it. A pickup address orphaned
     from its own price is the one break that makes an invoice unreadable. */
  tbody tr { break-inside: avoid; page-break-inside: avoid; }
  td.idx { width: 5%; color: #6b7280; }
  td.desc { width: 47%; }
  .line-title { font-weight: 700; }
  .detail { color: #4b5563; }
  .note { color: #6b7280; font-style: italic; margin-top: 3px; }
  th.qty, td.qty { width: 14%; }
  th.rate, td.rate, th.amount, td.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th.rate, td.rate { width: 14%; }
  th.amount, td.amount { width: 20%; }
  td.rate, td.amount { font-weight: 700; }
  .muted { color: #6b7280; font-weight: 400; }

  .foot { display: flex; gap: 32px; margin-top: 24px; align-items: flex-start; }
  .pay { background: #eef2f6; padding: 14px 16px; width: 62mm; }
  .pay .label { margin-bottom: 4px; }
  .pay div { line-height: 1.5; }
  .totals { margin-left: auto; width: 74mm; }
  .totals .row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; }
  /* Uppercase is for the named totals — Subtotal, Total, Due. A band label
     carries a registration number and a rate, and shouting it makes it
     harder to read, not more prominent. */
  .totals .row:not(.muted-row) span:first-child { text-transform: uppercase; font-weight: 700; letter-spacing: 0.02em; }
  .totals .muted-row span { color: #6b7280; font-weight: 600; }
  .totals .grand { border-top: 1px solid #d1d5db; margin-top: 4px; padding-top: 10px; font-size: 17px; }
  .totals .grand span { font-weight: 700; }
  .totals .due span { font-weight: 700; }
  .totals .amount-cell { font-variant-numeric: tabular-nums; }

  .notes { margin-top: 20px; white-space: pre-wrap; color: #4b5563; }
  .sign { margin-top: 36px; margin-left: auto; width: 74mm; break-inside: avoid; }
  .sign .line { border-bottom: 1px solid #9ca3af; height: 28px; }
  .sign .who { margin-top: 6px; color: #6b7280; }
  .terms { margin-top: 24px; color: #6b7280; }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <div>${heading}</div>
    <div class="masthead">
      <h1>${title}</h1>
      <div><span class="k">${title === 'Invoice' ? 'Invoice No' : 'Credit note no'}:</span> ${escapeHtml(data.number)}</div>
      <div><span class="k">Date:</span> ${escapeHtml(data.issueDate)}</div>
      <div><span class="k">Due Date:</span> ${escapeHtml(data.dueDate)}</div>
    </div>
  </header>

  <div class="rule"></div>

  <div class="parties">
    <section>
      <div class="label">From</div>
      <div class="party-name">${escapeHtml(fromLines[0] ?? branding.tradingName)}</div>
      <div class="muted">${fromLines.slice(1).map((line) => `<div>${escapeHtml(line)}</div>`).join('')}</div>
    </section>
    <section>
      <div class="label">Bill To</div>
      <div class="party-name">${escapeHtml(data.recipientName)}</div>
      <div class="muted">
        ${lines(data.recipientAddress)}
        ${data.recipientEmail ? `<div>${escapeHtml(data.recipientEmail)}</div>` : ''}
      </div>
    </section>
  </div>

  <table>
    <thead>
      <tr>
        <th class="idx">ID</th>
        <th class="desc">Description</th>
        <th class="qty">Quantity</th>
        <th class="rate">Rate</th>
        <th class="amount">Amount</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  <div class="foot">
    ${
      branding.bankDetails
        ? `<div class="pay">
      <div class="label">Payment Info</div>
      ${lines(branding.bankDetails)}
    </div>`
        : ''
    }
    <div class="totals">
      <div class="row"><span>Subtotal</span><span class="amount-cell">${escapeHtml(money(tax.netPence))}</span></div>
      ${bandRows}
      <div class="row grand"><span>Total</span><span class="amount-cell">${escapeHtml(money(tax.grossPence))}</span></div>
      ${
        data.paidPence !== 0
          ? `<div class="row muted-row"><span>Paid</span><span class="amount-cell">${escapeHtml(money(data.paidPence))}</span></div>`
          : ''
      }
      <div class="row due"><span>Due</span><span class="amount-cell">${escapeHtml(money(outstanding))}</span></div>
    </div>
  </div>

  ${data.notes ? `<div class="notes">${escapeHtml(data.notes)}</div>` : ''}

  <div class="terms">${terms}${
    branding.supportEmail || branding.phone
      ? ` Queries: ${escapeHtml([branding.supportEmail, branding.phone].filter(Boolean).join(' · '))}, quoting ${escapeHtml(data.number)}.`
      : ''
  }</div>

  <div class="sign">
    <div class="line"></div>
    <div class="who">${data.signatory ? escapeHtml(data.signatory) : `For and on behalf of ${escapeHtml(branding.tradingName)}`}</div>
  </div>
</div>
</body>
</html>`;
}
