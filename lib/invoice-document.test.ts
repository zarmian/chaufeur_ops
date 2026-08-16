import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING, type Branding } from './branding';
import {
  escapeHtml,
  renderInvoiceDocument,
  type InvoiceDocumentData,
  type InvoiceDocumentLine,
} from './invoice-document';
import { DEFAULT_LOCALE_CONFIG } from './locale';

/**
 * The invoice as the client sees it.
 *
 * Two things are load-bearing here beyond "does it render". A line has to
 * carry the job — the operator's complaint was an invoice of bare job numbers,
 * which cannot be checked against a diary. And the tax has to be right in the
 * three ways it can differ per line, with parking and drop-off charges kept
 * out of the base in all of them.
 */

const branding: Branding = {
  ...DEFAULT_BRANDING,
  tradingName: 'Northbound Cars',
  legalName: 'Northbound Cars Ltd',
  addressLines: '14 Example Street\nLondon\nEC1A 1AA',
  phone: '020 0000 0000',
  supportEmail: 'accounts@example.test',
  taxNumber: 'GB123456789',
  companyNumber: '01234567',
  bankDetails: 'Sort code 00-00-00\nAccount 12345678',
};

function line(overrides: Partial<InvoiceDocumentLine> = {}): InvoiceDocumentLine {
  return {
    title: 'Airport transfer · JOB-000123',
    details: [
      '1 Aug 2026, 10:30',
      'Pick up: London Heathrow Terminal 3',
      'Drop off: The Marylebone Hotel, 47 Welbeck Street',
    ],
    amountPence: 12_550,
    disbursementPence: 0,
    vatTreatment: 'STANDARD',
    quantity: 1,
    quantityUnit: 'trip',
    unitPricePence: 12_550,
    ...overrides,
  };
}

function document(overrides: Partial<InvoiceDocumentData> = {}) {
  const data: InvoiceDocumentData = {
    number: 'INV-2026-0001',
    issueDate: '5 Aug 2026',
    dueDate: '19 Aug 2026',
    status: 'SENT',
    isCreditNote: false,
    recipientName: 'Halden & Co',
    recipientAddress: '2 Client Row\nLondon',
    recipientEmail: 'pay@halden.test',
    lines: [line()],
    netPence: 12_550,
    vatPence: 2510,
    grossPence: 15_060,
    paidPence: 0,
    vatRatePct: 20,
    paymentTermsDays: 14,
    notes: null,
    signatory: null,
    ...overrides,
  };

  return renderInvoiceDocument(data, {
    branding,
    locale: DEFAULT_LOCALE_CONFIG,
  });
}

describe('escapeHtml', () => {
  it('neutralises markup in operator-typed values', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('escapes quotes, which reach attributes', () => {
    expect(escapeHtml('a "b" \'c\'')).toBe('a &quot;b&quot; &#39;c&#39;');
  });
});

describe('renderInvoiceDocument', () => {
  it('prints the letterhead from settings', () => {
    const html = document();
    expect(html).toContain('Northbound Cars Ltd');
    expect(html).toContain('14 Example Street');
    expect(html).toContain('Company number 01234567');
  });

  it('prints the bank details and the payment terms', () => {
    const html = document();
    expect(html).toContain('Sort code 00-00-00');
    expect(html).toContain('Payment terms: 14 days');
    expect(html).toContain('Due by 19 Aug 2026');
  });

  it('lists the job, not just its number', () => {
    // The complaint this exists for. A line reading "JOB-000123" tells the
    // person paying it nothing, and reconciling an invoice against a diary
    // meant opening every job in turn.
    const html = document();
    expect(html).toContain('Airport transfer · JOB-000123');
    expect(html).toContain('Pick up: London Heathrow Terminal 3');
    expect(html).toContain('Drop off: The Marylebone Hotel');
    expect(html).toContain('1 Aug 2026, 10:30');
  });

  it('shows how the price was arrived at', () => {
    // "10 hrs at £140" is what the client agreed. A bare £1,400 invites a
    // phone call.
    const html = document({
      lines: [
        line({
          title: 'As directed · JOB-000200',
          quantity: 10,
          quantityUnit: 'hrs',
          unitPricePence: 14_000,
          amountPence: 140_000,
        }),
      ],
      netPence: 140_000,
      vatPence: 28_000,
      grossPence: 168_000,
    });
    expect(html).toContain('>10</strong>');
    expect(html).toContain('(hrs)');
    expect(html).toContain('£140.00');
  });

  it('leaves the quantity columns empty rather than inventing a quantity', () => {
    const html = document({
      lines: [line({ quantity: null, quantityUnit: null, unitPricePence: null })],
    });
    expect(html).toContain('<td class="qty"></td><td class="rate"></td>');
  });

  it('adds tax on top of a standard-rated line', () => {
    const html = document();
    expect(html).toContain('£125.50'); // subtotal
    expect(html).toContain('VAT no. GB123456789 at 20%');
    expect(html).toContain('£25.10');
    expect(html).toContain('£150.60'); // total
  });

  it('backs tax out of a price that already contains it', () => {
    // £120 inclusive is £100 of work and £20 of tax — not £120 plus £24. The
    // failure this guards charges the client 20% they have already paid.
    const html = document({
      lines: [
        line({
          amountPence: 12_000,
          vatTreatment: 'INCLUSIVE',
          quantity: null,
          quantityUnit: null,
          unitPricePence: null,
        }),
      ],
      vatRatePct: 20,
    });
    expect(html).toContain('(included above)');
    expect(html).toContain('£20.00'); // the tax inside the price
    expect(html).toContain('£100.00'); // the net it was backed out to
    // …and nothing was added: what is owed is still the £120 agreed.
    expect(html).toContain('£120.00');
    expect(html).not.toContain('£144.00');
  });

  it('adds nothing to work that is not tax-qualifying', () => {
    const html = document({
      lines: [line({ vatTreatment: 'EXEMPT' })],
    });
    expect(html).toContain('VAT — not chargeable');
    expect(html).not.toContain('£25.10');
  });

  it('keeps parking and drop-off charges out of the tax base', () => {
    // Asked for explicitly: tax is charged on the fare, never on a charge
    // paid on the client's behalf. £5,200 hire + £75 congestion at 20% is
    // £1,040 of tax, not £1,055.
    const html = document({
      lines: [
        line({
          title: 'Range Rover hire',
          details: [],
          amountPence: 527_500,
          disbursementPence: 7500,
          quantity: null,
          quantityUnit: null,
          unitPricePence: null,
        }),
      ],
      vatRatePct: 20,
    });
    expect(html).toContain('£1,040.00');
    expect(html).not.toContain('£1,055.00');
    expect(html).toContain('£6,315.00'); // total
    // And the line says why, next to the money it applies to.
    expect(html).toContain('£75.00 paid on your behalf');
  });

  it('prints one band per treatment when an invoice mixes them', () => {
    const html = document({
      lines: [
        line({ amountPence: 10_000, vatTreatment: 'STANDARD' }),
        line({ amountPence: 12_000, vatTreatment: 'INCLUSIVE' }),
        line({ amountPence: 5000, vatTreatment: 'EXEMPT' }),
      ],
    });
    expect(html).toContain('VAT no. GB123456789 at 20%<');
    expect(html).toContain('(included above)');
    expect(html).toContain('VAT — not chargeable');
  });

  it('leaves out an identifier that has not been configured', () => {
    // A letterhead reading "VAT number:" with nothing after it looks like a
    // system that lost the number, which on a client-facing document is worse
    // than not printing the row at all.
    const html = renderInvoiceDocument(
      {
        number: 'INV-2026-0002',
        issueDate: '5 Aug 2026',
        dueDate: '19 Aug 2026',
        status: 'DRAFT',
        isCreditNote: false,
        recipientName: 'Someone',
        recipientAddress: null,
        recipientEmail: null,
        lines: [],
        netPence: 0,
        vatPence: 0,
        grossPence: 0,
        paidPence: 0,
        vatRatePct: 20,
        paymentTermsDays: null,
        notes: null,
        signatory: null,
      },
      { branding: DEFAULT_BRANDING, locale: DEFAULT_LOCALE_CONFIG },
    );

    expect(html).not.toContain('VAT no.');
    expect(html).not.toContain('Company number');
    expect(html).toContain('Payment is due by');
  });

  it('escapes a client name containing markup', () => {
    const html = document({ recipientName: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('calls itself a credit note when it is one', () => {
    expect(document({ isCreditNote: true })).toContain('<h1>Credit note</h1>');
    expect(document()).toContain('<h1>Invoice</h1>');
  });

  it('shows what has been paid, and what is left', () => {
    expect(document()).not.toContain('Paid</span>');

    const part = document({ paidPence: 5000 });
    expect(part).toContain('Paid');
    expect(part).toContain('£100.60');
  });

  it('signs it, from settings', () => {
    // White label: the name under the rule is configuration, not a template
    // somebody edits.
    expect(document({ signatory: 'A. Patel, Director' })).toContain(
      'A. Patel, Director',
    );
    expect(document()).toContain('For and on behalf of Northbound Cars');
  });

  it('renders the trading name as a wordmark when there is no logo', () => {
    expect(document()).toContain('class="wordmark">Northbound Cars');
  });

  it('declares no page margin, so the footer band survives', () => {
    // The same failure the hire agreement had: `@page { margin }` silently
    // wins over the margin `page.pdf()` is given, so declaring one here
    // removes the band reserved for the running footer and body text prints
    // straight through it.
    const pageRule = /@page\s*\{([^}]*)\}/.exec(document())?.[1] ?? '';
    expect(pageRule).toContain('size');
    expect(pageRule).not.toContain('margin');
  });

  it('formats money in the configured currency, not a hardcoded pound', () => {
    const html = renderInvoiceDocument(
      {
        number: 'INV-2026-0003',
        issueDate: '5 Aug 2026',
        dueDate: '19 Aug 2026',
        status: 'SENT',
        isCreditNote: false,
        recipientName: 'Somebody',
        recipientAddress: null,
        recipientEmail: null,
        lines: [
          {
            title: 'A job',
            details: [],
            amountPence: 10_000,
            disbursementPence: 0,
            vatTreatment: 'STANDARD',
            quantity: null,
            quantityUnit: null,
            unitPricePence: null,
          },
        ],
        netPence: 10_000,
        vatPence: 1900,
        grossPence: 11_900,
        paidPence: 0,
        vatRatePct: 19,
        paymentTermsDays: 30,
        notes: null,
        signatory: null,
      },
      {
        branding,
        locale: {
          ...DEFAULT_LOCALE_CONFIG,
          currency: 'EUR',
          locale: 'de-DE',
          taxName: 'MwSt',
        },
      },
    );

    expect(html).toContain('MwSt no. GB123456789 at 19%');
    expect(html).toContain('€');
    expect(html).not.toContain('£');
  });
});
