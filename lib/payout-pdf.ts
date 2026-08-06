import { getBranding } from './branding-store';
import { formatDate } from './dates';
import { getLocaleConfig } from './locale-store';
import {
  renderPayoutStatement,
  type StatementData,
} from './payout-document';
import { getPayout } from './payout-store';

/**
 * Gathering a payout into the shape the statement wants.
 *
 * Separate from `lib/payout-document.ts` on purpose: the template is pure and
 * testable, and this is the part that talks to Postgres and to settings.
 */
export async function payoutStatementHtml(
  payoutId: string,
  options: { logoSrc?: string | null } = {},
): Promise<string | null> {
  const payout = await getPayout(payoutId);
  if (!payout) return null;

  const [branding, locale] = await Promise.all([
    getBranding(),
    getLocaleConfig(),
  ]);

  const lines = payout.lines
    .map((line) => ({
      at: line.job?.scheduledAt ?? line.shift?.startedAt ?? payout.periodStart,
      line,
    }))
    // Chronological, so the statement reads as the week happened rather than
    // in whatever order the rows came back.
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(({ at, line }) => ({
      date: formatDate(at),
      description:
        line.description ??
        line.job?.reference ??
        line.shift?.reference ??
        'Adjustment',
      route: line.job ? `${line.job.pickupText} → ${line.job.dropoffText}` : null,
      amountPence: line.amountPence,
    }));

  const data: StatementData = {
    driverName: payout.driver.name,
    driverReference: payout.driver.reference,
    periodStart: formatDate(payout.periodStart),
    periodEnd: formatDate(payout.periodEnd),
    status: payout.status,
    paidOn: payout.paidAt ? formatDate(payout.paidAt) : null,
    paymentReference: payout.paymentReference,
    lines,
    totalPence: payout.totalPence,
  };

  return renderPayoutStatement(data, {
    branding,
    locale,
    logoSrc: options.logoSrc ?? null,
  });
}
