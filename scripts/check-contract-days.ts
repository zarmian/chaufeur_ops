/**
 * Are there days still on the board for contracts that have already ended?
 *
 *   npx tsx scripts/check-contract-days.ts          # report only
 *   npx tsx scripts/check-contract-days.ts --fix    # and cancel them
 *
 * Ending a contract now calls off the days it had already booked — stopping it
 * does, and so does bringing its end date forward. That is the behaviour from
 * here on. It does nothing for the contracts that ended *before* it existed,
 * and those are the ones this finds: an arrangement the office ended weeks ago
 * with a fortnight of days still sitting on the board, each one a car that
 * will be dispatched to a client who cancelled.
 *
 * Worth keeping rather than running once. A day can end up beyond its
 * contract by other routes — a cron run that overlapped an edit, a contract
 * restarted and stopped again, an import — and the cost of finding out late is
 * a driver at a door nobody opens.
 *
 * **It reports by default and changes nothing.** `--fix` cancels what it
 * found, through exactly the same path the screens use: each day becomes a
 * CANCELLED job with an event on it, its driver is told, and any offer still
 * out is withdrawn. Nothing is deleted, a day that has already run is never
 * touched, and an invoiced day is refused and named so the invoice can be
 * credited first.
 */

import {
  cancelContractJobsFrom,
  contractEndedFrom,
  type CancelResult,
} from '../lib/contracts';
import { formatDateTime, toDateOnlyString } from '../lib/dates';
import { getLocaleConfig } from '../lib/locale-store';
import { prisma } from '../lib/prisma';

/**
 * Who the audit log records for the cancellations.
 *
 * No user, because there is not one — this runs from a terminal. The audit row
 * still carries the before and after, which is what makes a day cancelled by
 * this distinguishable from one cancelled by hand.
 */
const audit = { userId: null, ip: null };

/** A day that has run, is running, or was already called off is not in scope. */
const STANDING = ['DRAFT', 'PENDING', 'ASSIGNED', 'ACCEPTED'] as const;

interface Orphan {
  contractId: string;
  reference: string;
  label: string;
  /** Why it is over: stopped, past its end date, or both. */
  because: string;
  from: Date;
  days: Array<{ reference: string; scheduledAt: Date }>;
}

async function main(): Promise<void> {
  const fix = process.argv.includes('--fix');
  const { timeZone, locale } = await getLocaleConfig();
  const now = new Date();
  const when = (value: Date) => formatDateTime(value, { locale, timeZone });

  console.log('Checking for days booked against contracts that have ended.\n');

  /*
   * Only contracts that could possibly be over. A running, open-ended contract
   * has no beyond, and on an install with hundreds of them that is most of the
   * table — there is no reason to walk it.
   */
  const contracts = await prisma.jobContract.findMany({
    where: { OR: [{ active: false }, { endsOn: { not: null } }] },
    select: {
      id: true,
      reference: true,
      label: true,
      active: true,
      endsOn: true,
    },
    orderBy: { reference: 'asc' },
  });

  if (contracts.length === 0) {
    console.log('No contract on this install has been stopped or given an end date.');
    console.log('\nNothing to check.');
    return;
  }

  console.log(
    `${contracts.length} contract(s) are stopped or have an end date. Checking their days…\n`,
  );

  const orphans: Orphan[] = [];

  for (const contract of contracts) {
    const from = contractEndedFrom(contract, now, timeZone);
    if (!from) continue;

    const days = await prisma.job.findMany({
      where: {
        contractId: contract.id,
        scheduledAt: { gte: from },
        status: { in: [...STANDING] },
      },
      select: { reference: true, scheduledAt: true },
      orderBy: { scheduledAt: 'asc' },
    });
    if (days.length === 0) continue;

    orphans.push({
      contractId: contract.id,
      reference: contract.reference,
      label: contract.label,
      because: describeWhy(contract, now),
      from,
      days,
    });
  }

  if (orphans.length === 0) {
    console.log('Every ended contract is clean — no day is booked beyond it.');
    return;
  }

  const total = orphans.reduce((count, orphan) => count + orphan.days.length, 0);
  console.log(
    `${total} day(s) across ${orphans.length} contract(s) are still booked beyond the end:\n`,
  );

  for (const orphan of orphans) {
    console.log(`  ${orphan.reference}  ${orphan.label.slice(0, 44)}`);
    console.log(`    ${orphan.because}, so nothing from ${when(orphan.from)}`);
    for (const day of orphan.days.slice(0, 8)) {
      console.log(`      ${day.reference.padEnd(14)} ${when(day.scheduledAt)}`);
    }
    if (orphan.days.length > 8) {
      console.log(`      …and ${orphan.days.length - 8} more`);
    }
    console.log('');
  }

  if (!fix) {
    console.log('Nothing has been changed.');
    console.log(
      'Re-run with --fix to cancel these. The drivers on them will be told,',
    );
    console.log('and any day that has been invoiced will be left alone and named.');
    return;
  }

  console.log('Cancelling them.\n');

  let cancelled = 0;
  const refused: CancelResult['refused'] = [];

  for (const orphan of orphans) {
    const result = await cancelContractJobsFrom(orphan.contractId, orphan.from, audit);
    cancelled += result.cancelled;
    refused.push(...result.refused);
    console.log(
      `  ${orphan.reference.padEnd(12)} ${result.cancelled} cancelled${
        result.refused.length > 0 ? `, ${result.refused.length} refused` : ''
      }`,
    );
  }

  console.log(`\n${cancelled} day(s) cancelled.`);

  if (refused.length > 0) {
    console.log(`\n${refused.length} could not be cancelled:`);
    for (const refusal of refused) {
      console.log(`  ${refusal.reference.padEnd(14)} ${refusal.reason}`);
    }
    console.log(
      '\nAn invoiced day is the usual reason — the client is holding a figure for',
    );
    console.log(
      'it. Credit the invoice first, then cancel the job, or let it run.',
    );
  }
}

/**
 * Why this contract owes nothing beyond the cut-off, in an operator's words.
 *
 * The end date is stated rather than characterised, and its tense is checked:
 * a contract that ends next week has not "passed its end date", it has days
 * booked past one it has not reached — which is a different thing to read on a
 * Monday morning, and the sort of wrongness that makes somebody distrust the
 * rest of the output.
 */
function describeWhy(
  contract: { active: boolean; endsOn: Date | null },
  now: Date,
): string {
  const stopped = contract.active ? null : 'Stopped';
  // `toDateOnlyString`, not the zoned one: `endsOn` is a `@db.Date` and comes
  // back as midnight UTC. Shifting a date-only column into a timezone is what
  // turns the 1st into the 31st on an install west of here.
  const dated = contract.endsOn
    ? `${contract.endsOn < now ? 'Ended' : 'Ends'} ${toDateOnlyString(contract.endsOn)}`
    : null;

  if (stopped && dated) return `${stopped}, and ${dated.toLowerCase()}`;
  return stopped ?? dated ?? 'Over';
}

main()
  .catch((error) => {
    console.error('\nCould not complete the check:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
