import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING, type Branding } from './branding';
import {
  escapeHtml,
  renderInvoiceDocument,
  type InvoiceDocumentData,
} from './invoice-document';
import { DEFAULT_LOCALE_CONFIG } from './locale';

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

function document(overrides: Partial<InvoiceDocumentData> = {}) {
  const data: InvoiceDocumentData = {
    number: 'INV-2026-0001',
    issueDate: '5 Aug 2026',
    dueDate: '19 Aug 2026',
    status: 'SENT',
    isCreditNote: false,
    recipientName: 'Halden & Co',
    recipientAddress: '2 Client Row\nLondon',
    lines: [
      {
        description: 'Job JOB-000123',
        amountPence: 12_550,
        reference: 'JOB-000123',
        occurredOn: '1 Aug 2026',
      },
    ],
    netPence: 12_550,
    vatPence: 2510,
    grossPence: 15_060,
    paidPence: 0,
    vatRatePct: 20,
    paymentTermsDays: 14,
    notes: null,
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
    expect(html).toContain('Northbound Cars');
    expect(html).toContain('14 Example Street');
    expect(html).toContain('VAT number GB123456789');
    expect(html).toContain('Company number 01234567');
  });

  it('prints the bank details and the payment terms', () => {
    const html = document();
    expect(html).toContain('Sort code 00-00-00');
    expect(html).toContain('Payment terms: 14 days');
    expect(html).toContain('Due by 19 Aug 2026');
  });

  it('shows the net, tax and gross breakdown', () => {
    const html = document();
    expect(html).toContain('£125.50');
    expect(html).toContain('VAT at 20%');
    expect(html).toContain('£25.10');
    expect(html).toContain('£150.60');
  });

  it('names each line and the job it came from', () => {
    const html = document();
    expect(html).toContain('Job JOB-000123');
    expect(html).toContain('1 Aug 2026');
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
        lines: [],
        netPence: 0,
        vatPence: 0,
        grossPence: 0,
        paidPence: 0,
        vatRatePct: 20,
        paymentTermsDays: null,
        notes: null,
      },
      { branding: DEFAULT_BRANDING, locale: DEFAULT_LOCALE_CONFIG },
    );

    expect(html).not.toContain('VAT number');
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

  it('shows paid and outstanding only once something has been paid', () => {
    expect(document()).not.toContain('Outstanding');

    const part = document({ paidPence: 5000 });
    expect(part).toContain('Outstanding');
    expect(part).toContain('£100.60');
  });

  it('renders the trading name as a wordmark when there is no logo', () => {
    expect(document()).toContain('class="wordmark">Northbound Cars');
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
        lines: [
          { description: 'A job', amountPence: 10_000, reference: null, occurredOn: null },
        ],
        netPence: 10_000,
        vatPence: 1900,
        grossPence: 11_900,
        paidPence: 0,
        vatRatePct: 19,
        paymentTermsDays: 30,
        notes: null,
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

    expect(html).toContain('MwSt at 19%');
    expect(html).toContain('€');
    expect(html).not.toContain('£');
  });
});
