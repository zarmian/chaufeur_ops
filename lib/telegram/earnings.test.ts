import { describe, expect, it } from 'vitest';
import type { PayoutDraft } from '../payout-lines';
import { earningsText, type DriverEarnings } from './earnings';

/**
 * The message, without a database.
 *
 * What matters here is not the arithmetic — that is `payout-lines.test.ts` —
 * but what a driver is told. Three things have to hold whatever the figures
 * are: the total is never presented as settled, an excluded job is visible
 * rather than silently missing, and nothing in the text is phrased as an
 * instruction to the office.
 */

const FORMAT = { locale: 'en-GB', timeZone: 'Europe/London', currency: 'GBP' };

/**
 * The message with Telegram's escaping taken back off.
 *
 * `escapeMarkdown` puts a backslash in front of every reserved character, so
 * `£229.20` reaches the driver as `£229\.20`. Asserting on the escaped form
 * would tie each expectation to the escaper rather than to what the driver
 * reads; the one test that cares about escaping asserts on the raw text.
 */
function plain(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

const WEEK = {
  from: new Date('2026-08-30T23:00:00Z'), // Monday 31 August, local.
  to: new Date('2026-09-06T22:59:59.999Z'), // Sunday 6 September, local.
};

function draft(over: Partial<PayoutDraft> = {}): PayoutDraft {
  return {
    lines: [],
    jobPence: 0,
    shiftPence: 0,
    expensePence: 0,
    totalPence: 0,
    excluded: [],
    ...over,
  };
}

function jobLine(amountPence: number, reference: string) {
  return {
    source: 'JOB' as const,
    jobId: reference,
    shiftId: null,
    amountPence,
    description: `Job ${reference}`,
    occurredAt: new Date('2026-09-01T08:00:00Z'),
  };
}

function earnings(over: Partial<DriverEarnings> = {}): DriverEarnings {
  return {
    week: WEEK,
    soFar: draft(),
    jobCount: 0,
    latest: null,
    awaitingPayment: [],
    ...over,
  };
}

describe('earningsText', () => {
  it('adds the week up and shows the local dates it covers', () => {
    const text = earningsText(
      earnings({
        soFar: draft({
          lines: [jobLine(9000, 'J-1'), jobLine(12_500, 'J-2')],
          jobPence: 21_500,
          expensePence: 1420,
          totalPence: 22_920,
        }),
        jobCount: 2,
      }),
      FORMAT,
    );

    expect(plain(text)).toContain('31 Aug 2026');
    expect(plain(text)).toContain('6 Sept 2026');
    expect(plain(text)).toContain('2 jobs');
    expect(plain(text)).toContain('£215.00');
    expect(plain(text)).toContain('£14.20');
    expect(plain(text)).toContain('Total so far');
    expect(plain(text)).toContain('£229.20');
  });

  it('never presents the running total as settled', () => {
    // The line that stops `/pay` becoming a promise the office has to keep.
    const text = earningsText(
      earnings({
        soFar: draft({ jobPence: 9000, totalPence: 9000 }),
        jobCount: 1,
      }),
      FORMAT,
    );
    expect(plain(text)).toContain('provisional');
  });

  it('says so plainly when nothing has been completed yet', () => {
    const text = earningsText(earnings(), FORMAT);
    expect(plain(text)).toContain('Nothing completed yet this week');
    expect(plain(text)).not.toContain('Total so far');
  });

  it('shows what is missing, in words aimed at the driver', () => {
    const text = earningsText(
      earnings({
        soFar: draft({
          excluded: [
            {
              reference: 'J-9',
              reason: 'No driver price recorded — price it before paying it',
              code: 'UNPRICED',
            },
            {
              reference: 'S-4',
              reason: 'Not approved yet',
              code: 'SHIFT_UNAPPROVED',
            },
          ],
        }),
      }),
      FORMAT,
    );

    expect(plain(text)).toContain('Not counted yet');
    expect(plain(text)).toContain('J-9');
    expect(plain(text)).toContain('waiting for the office to price it');
    expect(plain(text)).toContain('shift waiting to be approved');

    // The operator's phrasing is an instruction to the office. Sending it to
    // the person waiting for the money reads as their fault.
    expect(plain(text)).not.toContain('price it before paying it');
  });

  it('caps a long list rather than sending a wall of references', () => {
    const text = earningsText(
      earnings({
        soFar: draft({
          excluded: Array.from({ length: 9 }, (_, index) => ({
            reference: `J-${index}`,
            reason: 'No driver price recorded — price it before paying it',
            code: 'UNPRICED' as const,
          })),
        }),
      }),
      FORMAT,
    );

    expect(plain(text)).toContain('and 4 more');
    expect(plain(text)).not.toContain('J-8');
  });

  it('reports a paid statement with its date and reference', () => {
    const text = earningsText(
      earnings({
        latest: {
          periodStart: new Date('2026-08-23T23:00:00Z'),
          periodEnd: new Date('2026-08-30T22:59:59.999Z'),
          totalPence: 51_840,
          status: 'PAID',
          paidAt: new Date('2026-09-03T10:00:00Z'),
          paymentReference: 'FPS-8891',
        },
      }),
      FORMAT,
    );

    expect(plain(text)).toContain('Last statement');
    expect(plain(text)).toContain('£518.40');
    expect(plain(text)).toContain('Paid 3 Sept 2026');
    expect(plain(text)).toContain('FPS-8891');
  });

  it('calls a draft statement “being prepared” rather than a draft', () => {
    // "Draft" invites a question the office would rather answer once.
    const text = earningsText(
      earnings({
        latest: {
          periodStart: new Date('2026-08-23T23:00:00Z'),
          periodEnd: new Date('2026-08-30T22:59:59.999Z'),
          totalPence: 51_840,
          status: 'DRAFT',
          paidAt: null,
          paymentReference: null,
        },
      }),
      FORMAT,
    );

    expect(plain(text)).toContain('Being prepared');
    expect(plain(text)).not.toContain('Draft');
  });

  it('totals what has been approved and not yet paid', () => {
    const text = earningsText(
      earnings({
        awaitingPayment: [
          {
            periodStart: new Date('2026-08-16T23:00:00Z'),
            periodEnd: new Date('2026-08-23T22:59:59.999Z'),
            totalPence: 40_000,
            status: 'APPROVED',
            paidAt: null,
            paymentReference: null,
          },
          {
            periodStart: new Date('2026-08-23T23:00:00Z'),
            periodEnd: new Date('2026-08-30T22:59:59.999Z'),
            totalPence: 11_840,
            status: 'APPROVED',
            paidAt: null,
            paymentReference: null,
          },
        ],
      }),
      FORMAT,
    );

    expect(plain(text)).toContain('Approved and waiting to be paid');
    expect(plain(text)).toContain('£518.40');
  });

  it('formats money in the configured currency rather than assuming sterling', () => {
    // Locale is a setting. A euro install must not be told its week in pounds.
    const text = earningsText(
      earnings({
        soFar: draft({ jobPence: 9000, totalPence: 9000 }),
        jobCount: 1,
      }),
      { locale: 'en-IE', timeZone: 'Europe/Dublin', currency: 'EUR' },
    );

    expect(plain(text)).toContain('€90.00');
    expect(plain(text)).not.toContain('£');
  });

  it('escapes the markdown Telegram would otherwise choke on', () => {
    const text = earningsText(
      earnings({
        soFar: draft({
          excluded: [
            {
              reference: 'J-1_2*3',
              reason: 'Not approved yet',
              code: 'SHIFT_UNAPPROVED',
            },
          ],
        }),
      }),
      FORMAT,
    );

    expect(text).toContain('J\\-1\\_2\\*3');
  });
});
