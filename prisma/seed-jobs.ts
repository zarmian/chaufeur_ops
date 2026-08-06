import type { PrismaClient } from '@prisma/client';

/**
 * Synthetic job volume, behind SEED_JOB_COUNT.
 *
 * The Phase 2 definition of done requires the list, its filters and its sorts
 * to stay under 500ms at 10,000 jobs. That number cannot be proven against a
 * handful of sample rows: server-side pagination and a missing index behave
 * identically until the table is big, which is exactly how the legacy
 * Overview ended up rendering 704 rows at once and getting slower every week.
 *
 * The spread matters as much as the count. Roughly a third of these jobs are
 * deliberately left unpriced, because the unpriced filter and its count are
 * the things most likely to be slow — they scan the same table twice — and a
 * seed where everything is priced would never exercise them.
 *
 *   SEED_JOB_COUNT=10000 npm run db:seed
 */

const PICKUPS = [
  'The Dorchester',
  'Claridges',
  'The Savoy',
  'Canary Wharf',
  'St Pancras International',
  'The Shard',
  'Mayfair',
  'Kensington',
];

const DROPOFFS = [
  'Heathrow Terminal 5',
  'Gatwick North',
  'London City Airport',
  'Luton Airport',
  'Stansted Airport',
  'Battersea',
  'Chelsea',
  'The City',
];

const JOB_TYPES = ['TRANSFER', 'AIRPORT_TRANSFER', 'AS_DIRECTED'] as const;
const STATUSES = [
  'PENDING',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

/**
 * A small deterministic PRNG.
 *
 * Seeded rather than `Math.random` so a slow query can be investigated
 * against the same data it was measured on — "it was fast on my machine"
 * usually means a different distribution of rows.
 */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export async function seedJobs(prisma: PrismaClient): Promise<void> {
  const count = Number(process.env.SEED_JOB_COUNT ?? 0);
  if (!Number.isFinite(count) || count <= 0) return;

  const [drivers, vehicles, clients, accounts] = await Promise.all([
    prisma.driver.findMany({ select: { id: true }, take: 200 }),
    prisma.vehicle.findMany({ select: { id: true }, take: 200 }),
    prisma.client.findMany({ select: { id: true }, take: 200 }),
    prisma.account.findMany({ select: { id: true }, take: 50 }),
  ]);

  const random = makeRandom(20260804);
  const pick = <T>(items: T[]): T | null =>
    items.length === 0 ? null : (items[Math.floor(random() * items.length)] ?? null);

  // Continue the existing series rather than colliding with real bookings.
  const existing = await prisma.job.count();
  const start = existing + 1;

  const now = Date.now();
  const rows = [];

  for (let i = 0; i < count; i += 1) {
    const sequence = start + i;

    // Spread across roughly a year either side of today, so date-range
    // filters have something to actually narrow.
    const offsetDays = Math.floor(random() * 730) - 365;
    const scheduledAt = new Date(
      now + offsetDays * 86_400_000 + Math.floor(random() * 86_400_000),
    );

    const jobType = JOB_TYPES[Math.floor(random() * JOB_TYPES.length)]!;
    const status = STATUSES[Math.floor(random() * STATUSES.length)]!;

    // ~30% unpriced, matching the shape of the problem being solved.
    const unpriced = random() < 0.3;
    const clientPricePence = unpriced ? null : 5000 + Math.floor(random() * 40000);

    rows.push({
      reference: `SEED-${String(sequence).padStart(6, '0')}`,
      jobType,
      status,
      scheduledAt,
      pickupText: PICKUPS[Math.floor(random() * PICKUPS.length)]!,
      dropoffText: DROPOFFS[Math.floor(random() * DROPOFFS.length)]!,
      driverId: random() < 0.85 ? pick(drivers)?.id ?? null : null,
      vehicleId: random() < 0.85 ? pick(vehicles)?.id ?? null : null,
      clientId: random() < 0.9 ? pick(clients)?.id ?? null : null,
      accountId: random() < 0.7 ? pick(accounts)?.id ?? null : null,
      clientPricePence,
      driverPricePence:
        clientPricePence === null ? null : Math.floor(clientPricePence * 0.65),
      flightNumber:
        jobType === 'AIRPORT_TRANSFER'
          ? `BA${100 + Math.floor(random() * 800)}`
          : null,
    });
  }

  // Chunked, because a single 10,000-row insert exhausts the parameter limit
  // on a pooled connection.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.job.createMany({
      data: rows.slice(i, i + CHUNK),
      skipDuplicates: true,
    });
  }

  console.log(`✓ ${count} synthetic jobs (SEED_JOB_COUNT)`);
  console.log('  Roughly a third are deliberately unpriced.');
  console.log('  References are prefixed SEED- so they never look like real bookings.');

  await seedFinances(prisma, start, start + count - 1);
}

/**
 * A finance row for every priced job in the batch.
 *
 * The reports left-join `JobFinance`, so a volume seed without it measures a
 * join that never matches — which is the fast case, and not the one anybody
 * needs reassuring about. Revenue and profit reports are the slowest thing
 * in the application and they are slow precisely because of this join.
 *
 * The arithmetic is deliberately trivial. This is not testing the pricing
 * rules; it is giving the aggregates rows with plausible spread to sum.
 */
async function seedFinances(
  prisma: PrismaClient,
  fromSequence: number,
  toSequence: number,
): Promise<void> {
  const CHUNK = 1000;
  let written = 0;

  for (let low = fromSequence; low <= toSequence; low += CHUNK) {
    const high = Math.min(low + CHUNK - 1, toSequence);

    const jobs = await prisma.job.findMany({
      where: {
        reference: {
          in: Array.from({ length: high - low + 1 }, (_, offset) =>
            `SEED-${String(low + offset).padStart(6, '0')}`,
          ),
        },
        clientPricePence: { not: null },
      },
      select: { id: true, clientPricePence: true, driverPricePence: true },
    });

    const rows = jobs.map((job) => {
      const base = job.clientPricePence ?? 0;
      const driverPayment = job.driverPricePence ?? Math.floor(base * 0.65);
      return {
        jobId: job.id,
        baseFarePence: base,
        totalClientPence: base,
        driverPaymentPence: driverPayment,
        totalCostsPence: driverPayment,
        grossProfitPence: base - driverPayment,
      };
    });

    if (rows.length === 0) continue;

    await prisma.jobFinance.createMany({ data: rows, skipDuplicates: true });
    written += rows.length;
  }

  console.log(`✓ ${written} finance rows, so the reports have something to join`);
}
