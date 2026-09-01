import { formatDate } from '../dates';
import { getLocaleConfig } from '../locale-store';
import { formatMoney } from '../money';
import type { PayoutDraft, PayoutExclusion } from '../payout-lines';
import { currentPayoutWeek, type PayoutWeek } from '../payout-period';
import { draftFor } from '../payout-store';
import { prisma } from '../prisma';
import { escapeMarkdown } from './protocol';

/**
 * What a driver has earned, answered in the app they already have open.
 *
 * Drivers are not users here — no dashboard, no login, nothing but the bot.
 * So the only way any of them could find out what this week was worth was to
 * ring the office and ask somebody to look, which is a phone call the office
 * takes over and over on a Monday and an answer the driver has waited for.
 *
 * Two rules shape it.
 *
 * **The figure must be the real one.** It is not recomputed here from
 * whatever the jobs table happens to hold; it is `draftFor` — the same
 * function the generate-payouts screen previews and the same one the payout
 * is actually built from. A driver reading one number in Telegram and a
 * different one on their statement would be worse than telling them nothing,
 * because now the statement is in question too.
 *
 * **It must say what it is not.** The week in progress is provisional: a job
 * booked but not yet completed is not in it, a shift not yet approved is not
 * in it, and a price the office has still to settle can move it. The message
 * says so rather than presenting a running total as a promise.
 *
 * Exclusions are shown for the same reason they are shown on the operator's
 * screen: a driver who can see that two jobs are waiting to be priced does
 * not have to wonder whether they were forgotten.
 */

export interface DriverStatement {
  periodStart: Date;
  periodEnd: Date;
  totalPence: number;
  status: string;
  paidAt: Date | null;
  paymentReference: string | null;
}

export interface DriverEarnings {
  /** The Monday-to-Sunday week in progress. */
  week: PayoutWeek;
  /** What that week is worth so far, on the same rules a payout uses. */
  soFar: PayoutDraft;
  /** How many completed jobs are behind the job figure. */
  jobCount: number;
  /** The most recent statement, whatever state it is in. */
  latest: DriverStatement | null;
  /** Statements approved but not yet paid — money owed right now. */
  awaitingPayment: DriverStatement[];
}

const STATEMENT_FIELDS = {
  periodStart: true,
  periodEnd: true,
  totalPence: true,
  status: true,
  paidAt: true,
  paymentReference: true,
} as const;

export async function driverEarnings(
  driverId: string,
  now = new Date(),
): Promise<DriverEarnings> {
  const { timeZone } = await getLocaleConfig();
  const week = currentPayoutWeek(now, timeZone);

  const [soFar, latest, awaitingPayment] = await Promise.all([
    draftFor(driverId, week),
    prisma.driverPayout.findFirst({
      where: { driverId },
      orderBy: { periodEnd: 'desc' },
      select: STATEMENT_FIELDS,
    }),
    prisma.driverPayout.findMany({
      where: { driverId, status: 'APPROVED' },
      orderBy: { periodEnd: 'asc' },
      select: STATEMENT_FIELDS,
      take: 5,
    }),
  ]);

  return {
    week,
    soFar,
    jobCount: soFar.lines.filter((line) => line.source === 'JOB').length,
    latest,
    awaitingPayment,
  };
}

/**
 * The same exclusions the operator sees, in words aimed at the driver.
 *
 * The operator's phrasing tells the office what to do about it. A driver
 * wants to know whether it is coming and whether it is on them, so "price it
 * before paying it" becomes "waiting for the office to price it" and an
 * unended shift becomes something they can go and fix themselves.
 */
function driverReason(code: PayoutExclusion): string {
  switch (code) {
    case 'ALREADY_PAID':
      return 'already on an earlier statement';
    case 'SHIFT_COVERED':
      return 'paid as part of a shift';
    case 'UNPRICED':
      return 'waiting for the office to price it';
    case 'SHIFT_OPEN':
      return 'shift not ended yet';
    case 'SHIFT_UNAPPROVED':
      return 'shift waiting to be approved';
    case 'SHIFT_NO_HOURS':
      return 'no payable hours after the break';
  }
}

export interface EarningsFormat {
  locale: string;
  timeZone: string;
  currency: string;
}

/** The message a driver gets back from `/pay`. Markdown, already escaped. */
export function earningsText(
  earnings: DriverEarnings,
  format: EarningsFormat,
): string {
  const money = (pence: number) =>
    formatMoney(pence, { currency: format.currency, locale: format.locale });
  const day = (instant: Date) =>
    formatDate(instant, { locale: format.locale, timeZone: format.timeZone });

  const lines: string[] = ['*Your pay*', ''];

  lines.push(
    escapeMarkdown(
      `This week (${day(earnings.week.from)} to ${day(earnings.week.to)})`,
    ),
  );

  const { soFar } = earnings;
  if (soFar.totalPence === 0 && soFar.excluded.length === 0) {
    lines.push(escapeMarkdown('Nothing completed yet this week.'));
  } else {
    if (soFar.jobPence > 0) {
      const count = earnings.jobCount;
      lines.push(
        escapeMarkdown(
          `${count} job${count === 1 ? '' : 's'} — ${money(soFar.jobPence)}`,
        ),
      );
    }
    if (soFar.shiftPence > 0) {
      lines.push(escapeMarkdown(`Shifts — ${money(soFar.shiftPence)}`));
    }
    if (soFar.expensePence > 0) {
      lines.push(
        escapeMarkdown(`Expenses to pay back — ${money(soFar.expensePence)}`),
      );
    }
    lines.push(
      `*${escapeMarkdown(`Total so far — ${money(soFar.totalPence)}`)}*`,
    );
  }

  if (soFar.excluded.length > 0) {
    lines.push('', escapeMarkdown('Not counted yet'));
    for (const item of soFar.excluded.slice(0, EXCLUDED_SHOWN)) {
      lines.push(
        escapeMarkdown(`• ${item.reference} — ${driverReason(item.code)}`),
      );
    }
    const hidden = soFar.excluded.length - EXCLUDED_SHOWN;
    if (hidden > 0) {
      lines.push(escapeMarkdown(`• and ${hidden} more`));
    }
  }

  if (earnings.latest) {
    const statement = earnings.latest;
    lines.push(
      '',
      escapeMarkdown('Last statement'),
      escapeMarkdown(
        `${day(statement.periodStart)} to ${day(statement.periodEnd)} — ${money(statement.totalPence)}`,
      ),
      escapeMarkdown(statementState(statement, day)),
    );
  }

  const owed = earnings.awaitingPayment.reduce(
    (total, statement) => total + statement.totalPence,
    0,
  );
  if (owed > 0) {
    lines.push(
      '',
      escapeMarkdown(`Approved and waiting to be paid — ${money(owed)}`),
    );
  }

  lines.push(
    '',
    escapeMarkdown(
      'This week’s figure is provisional — it counts completed work only, and the office settles it when the week ends.',
    ),
  );

  return lines.join('\n');
}

/** How many exclusions are worth reading on a phone before it is a wall. */
const EXCLUDED_SHOWN = 5;

function statementState(
  statement: DriverStatement,
  day: (instant: Date) => string,
): string {
  if (statement.status === 'PAID') {
    const reference = statement.paymentReference
      ? ` (${statement.paymentReference})`
      : '';
    return statement.paidAt
      ? `Paid ${day(statement.paidAt)}${reference}`
      : `Paid${reference}`;
  }
  if (statement.status === 'APPROVED') return 'Approved, payment on its way';
  // A draft is the office still working on it, and saying "draft" to a driver
  // invites a question nobody in the office wants to answer twice.
  return 'Being prepared';
}

/** Everything `/pay` needs, fetched and formatted. */
export async function earningsFor(driverId: string): Promise<string> {
  const { locale, timeZone, currency } = await getLocaleConfig();
  const earnings = await driverEarnings(driverId);
  return earningsText(earnings, { locale, timeZone, currency });
}
