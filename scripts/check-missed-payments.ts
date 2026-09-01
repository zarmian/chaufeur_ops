/**
 * Did any gateway payment go unrecorded while the webhook was unreachable?
 *
 *   npx tsx scripts/check-missed-payments.ts
 *
 * `/api/payments/webhooks` was missing from the middleware's public prefix
 * list, so Revolut and SumUp were redirected to `/login` and the handler
 * behind them never ran. Fixed in the security pass; the question this
 * answers is what it cost in the meantime.
 *
 * It fails **closed**, which is the good direction: nothing was recorded that
 * should not have been, and no invoice was marked paid in error. What may
 * have happened is the opposite — a client paid through a link, the money
 * reached the merchant account, and the invoice here still reads as
 * outstanding. That is a client being chased for money they have already
 * sent.
 *
 * The check runs in three steps, and stops early when it can:
 *
 *   1. Was a gateway ever configured at all? On an install that records every
 *      payment by hand there is nothing to find, and that is most of them.
 *   2. Has *any* payment ever arrived by webhook? A gateway that is enabled
 *      with no gateway-sourced payment in its whole history is the signature
 *      of this bug.
 *   3. Which invoices are still outstanding, so they can be read against the
 *      provider's own dashboard.
 *
 * Step 3 is deliberately a list to compare, not a verdict. Only the merchant
 * account knows what it actually received; this cannot reach it, and an
 * invoice outstanding here is far more often a client who has simply not paid
 * yet. Nothing is written — this only reads.
 */

import { creditedTotalPence, outstandingPence } from '../lib/invoices';
import { formatMoney } from '../lib/money';
import { rawPrismaClient } from '../lib/raw-prisma';
import { decryptSecret } from '../lib/secret-store';

const prisma = rawPrismaClient(
  process.env.DIRECT_URL || process.env.DATABASE_URL,
);

/** The day the fix went out. Anything before it is in the affected window. */
const FIXED_AT = new Date('2026-08-31T17:49:00Z');

async function main(): Promise<void> {
  console.log('Checking for payments the webhook may have missed.\n');

  const gateways = await configuredGateways();

  if (gateways.length === 0) {
    console.log('No payment gateway is configured on this install.');
    console.log(
      'Every payment here is recorded by hand, so the webhook being unreachable cost nothing.',
    );
    console.log('\nNothing to do.');
    return;
  }

  console.log(`Gateways configured: ${gateways.join(', ')}\n`);

  const [byGateway, everByGateway] = await Promise.all([
    prisma.payment.count({
      where: { gateway: { not: 'manual' }, receivedAt: { lt: FIXED_AT } },
    }),
    prisma.payment.count({ where: { gateway: { not: 'manual' } } }),
  ]);

  if (everByGateway === 0) {
    console.log(
      'No payment has *ever* been recorded through a gateway on this install.',
    );
    console.log(
      'With a gateway enabled, that is the signature of the webhook never having',
    );
    console.log('reached its handler. Reconcile the list below by hand.\n');
  } else if (byGateway === 0) {
    console.log(
      `${everByGateway} gateway payment(s) recorded, all of them since the fix.`,
    );
    console.log('Nothing arrived by webhook before it, as expected.\n');
  } else {
    console.log(
      `${byGateway} gateway payment(s) recorded before the fix — unexpected, and worth a look.`,
    );
    console.log('The webhook should not have been reachable then.\n');
  }

  await reportOutstanding();
}

/**
 * Which gateways this install has switched on.
 *
 * Enabled *and* holding a key: a row left half-filled by somebody who opened
 * the settings screen and changed their mind never took a payment.
 */
async function configuredGateways(): Promise<string[]> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: 'gateway.' } },
  });

  const live: string[] = [];
  for (const row of rows) {
    const value = (row.value ?? {}) as Record<string, unknown>;
    if (value.enabled !== true) continue;

    // Decrypted only to check a key is present and readable. The value is
    // never printed: this output gets pasted into chat messages.
    const key =
      typeof value.apiKey === 'string' ? decryptSecret(value.apiKey) : null;
    if (!key) continue;

    live.push(row.key.replace('gateway.', ''));
  }
  return live;
}

/**
 * Invoices sent before the fix and still owed.
 *
 * Sent, because a draft was never payable. Not credited or cancelled, because
 * those are settled by a document rather than by money. Ordered oldest first,
 * which is the order somebody reconciling would want them.
 */
async function reportOutstanding(): Promise<void> {
  const rows = await prisma.invoice.findMany({
    where: {
      status: { in: ['SENT', 'PART_PAID', 'OVERDUE'] },
      issueDate: { lt: FIXED_AT },
    },
    select: {
      id: true,
      number: true,
      issueDate: true,
      grossPence: true,
      paidPence: true,
      account: { select: { name: true } },
      client: { select: { name: true } },
      /*
       * The credit notes raised against this invoice.
       *
       * Loaded rather than left out, because `outstandingPence` treats an
       * absent `creditedPence` as "not loaded" and falls back to the old,
       * wrong answer. The first draft of this script did exactly that and
       * printed rows reading **-£96.00 owed** — a credit note is not a debt,
       * and a reconciliation list that says a client owes a negative amount
       * is one nobody can act on.
       */
      creditNotes: { select: { grossPence: true } },
    },
    orderBy: { issueDate: 'asc' },
    take: 500,
  });

  const invoices = rows
    .map((invoice) => ({
      ...invoice,
      owed: outstandingPence({
        grossPence: invoice.grossPence,
        paidPence: invoice.paidPence,
        creditedPence: creditedTotalPence(invoice.creditNotes),
      }),
    }))
    // A fully credited or fully settled invoice owes nothing and does not
    // belong on a list somebody is going to chase.
    .filter((invoice) => invoice.owed > 0);

  if (invoices.length === 0) {
    console.log('No invoice issued before the fix is still outstanding.');
    console.log('Nothing was lost.');
    return;
  }

  const locale = await localeConfig();
  const money = (pence: number) => formatMoney(pence, locale);

  let total = 0;
  console.log(
    `${invoices.length} invoice(s) issued before the fix are still outstanding:\n`,
  );

  for (const invoice of invoices) {
    total += invoice.owed;
    const who = invoice.account?.name ?? invoice.client?.name ?? 'unknown';
    const partly =
      invoice.paidPence > 0 ? ` (part paid ${money(invoice.paidPence)})` : '';
    console.log(
      `  ${invoice.number.padEnd(14)} ${who.slice(0, 32).padEnd(34)} ${money(invoice.owed)}${partly}`,
    );
  }

  console.log(`\n  Total outstanding: ${money(total)}`);
  console.log(
    '\nCompare these against the merchant account for the same period. Any that',
  );
  console.log(
    'the provider shows as settled were paid and never recorded here — record',
  );
  console.log('them on the invoice, which will also stop the overdue chasing.');
  console.log(
    '\nMost of this list is almost certainly clients who have simply not paid.',
  );
}

/** The install's own currency, so a euro install is not reported in pounds. */
async function localeConfig(): Promise<{ currency: string; locale: string }> {
  const row = await prisma.setting.findUnique({ where: { key: 'locale' } });
  const stored = (row?.value ?? {}) as Record<string, unknown>;
  return {
    currency: typeof stored.currency === 'string' ? stored.currency : 'GBP',
    locale: typeof stored.locale === 'string' ? stored.locale : 'en-GB',
  };
}

main()
  .catch((error) => {
    console.error('\nCould not complete the check:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
