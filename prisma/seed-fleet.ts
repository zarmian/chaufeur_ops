import type { PrismaClient } from '@prisma/client';

/**
 * Synthetic drivers and their cars, behind SEED_DRIVER_COUNT.
 *
 * The Phase 6 definition of done asks for the system to hold up at 50,000
 * jobs and 200 drivers. Jobs alone do not test that: the dispatch board's
 * cost is a row per driver, the compliance report walks every driver and
 * every vehicle, and both look instant against the five sample drivers
 * `seed-phase1` creates. Two hundred is the first customer's actual fleet
 * size, so it is the number worth being sure about.
 *
 * One vehicle each, assigned — which is the real shape. A driver without a
 * car would never be offered work, so a fleet of unassigned drivers would
 * make the board look faster than it is.
 *
 * Every document here is in date. Compliance blocks assignment, so a fleet
 * seeded with lapsed badges would leave the dispatch board with nobody
 * legally able to take anything, and the perf run would measure the empty
 * case. `seed-phase1` already provides the lapsed examples the compliance
 * screens need.
 *
 *   SEED_DRIVER_COUNT=200 SEED_JOB_COUNT=50000 npm run db:seed
 */

const MAKES = [
  ['Mercedes-Benz', 'E-Class', 'EXECUTIVE'],
  ['Mercedes-Benz', 'S-Class', 'LUXURY'],
  ['Mercedes-Benz', 'V-Class', 'MPV'],
  ['BMW', '5 Series', 'EXECUTIVE'],
  ['BMW', '7 Series', 'LUXURY'],
  ['Audi', 'A6', 'EXECUTIVE'],
  ['Tesla', 'Model S', 'ELECTRIC_EXECUTIVE'],
  ['Range Rover', 'Sport', 'SUV'],
] as const;

const FIRST = [
  'James', 'Mohammed', 'David', 'Ahmed', 'Michael', 'Ali', 'Robert', 'Hassan',
  'John', 'Omar', 'Peter', 'Karim', 'Paul', 'Ibrahim', 'Andrew', 'Yusuf',
];

const LAST = [
  'Khan', 'Smith', 'Ahmed', 'Patel', 'Jones', 'Hussain', 'Williams', 'Ali',
  'Brown', 'Rahman', 'Taylor', 'Begum', 'Wilson', 'Iqbal', 'Davies', 'Malik',
];

/** The same seeded PRNG `seed-jobs` uses, for the same reason. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function daysFromNow(days: number): Date {
  const date = new Date(Date.now() + days * 86_400_000);
  return new Date(date.toISOString().slice(0, 10));
}

export async function seedFleet(prisma: PrismaClient): Promise<void> {
  const count = Number(process.env.SEED_DRIVER_COUNT ?? 0);
  if (!Number.isFinite(count) || count <= 0) return;

  const random = makeRandom(20260806);

  // Continue the series rather than colliding with drivers already there.
  const existing = await prisma.driver.count();
  const start = existing + 1;

  let created = 0;

  for (let i = 0; i < count; i += 1) {
    const sequence = start + i;
    const suffix = String(sequence).padStart(4, '0');

    const spec = MAKES[Math.floor(random() * MAKES.length)]!;
    const registration = `SD${suffix.slice(0, 2)} ${suffix.slice(2)}${String.fromCharCode(65 + (sequence % 26))}`;

    const name = `${FIRST[sequence % FIRST.length]} ${LAST[(sequence * 7) % LAST.length]}`;
    const phone = `+4477${String(10_000_000 + sequence).slice(0, 8)}`;

    // Documents valid for between three months and two years, so the
    // compliance report has a real spread to sort rather than one cliff.
    const licenceDays = 90 + Math.floor(random() * 640);
    const badgeDays = 90 + Math.floor(random() * 640);

    try {
      const vehicle = await prisma.vehicle.create({
        data: {
          registration,
          normalisedRegistration: registration.replace(/[^A-Z0-9]/g, ''),
          make: spec[0],
          model: spec[1],
          vehicleClass: spec[2],
          seats: spec[2] === 'MPV' ? 7 : 4,
          motExpiry: daysFromNow(90 + Math.floor(random() * 275)),
          insuranceExpiry: daysFromNow(90 + Math.floor(random() * 275)),
          phvLicenceExpiry: daysFromNow(90 + Math.floor(random() * 275)),
          // Owner-drivers, which is what this fleet is.
          ownership: 'DRIVER_OWNED',
        },
      });

      const driver = await prisma.driver.create({
        data: {
          reference: `DRV-S${suffix}`,
          name,
          phone,
          normalisedPhone: phone.replace(/[^0-9]/g, ''),
          dvlaLicenceExpiry: daysFromNow(licenceDays),
          phvBadgeExpiry: daysFromNow(badgeDays),
          assignedVehicleId: vehicle.id,
          status: 'ACTIVE',
        },
      });

      // The car belongs to its driver, which is what makes its running costs
      // the driver's rather than the company's.
      await prisma.vehicle.update({
        where: { id: vehicle.id },
        data: { ownerDriverId: driver.id },
      });

      created += 1;
    } catch {
      // A registration or reference collision means this row already exists
      // from an earlier run. Skipping is right: the seed is meant to be
      // re-runnable, and a half-seeded fleet is worse than a short one.
      continue;
    }
  }

  console.log(`✓ ${created} synthetic drivers with a car each (SEED_DRIVER_COUNT)`);
  console.log('  All documents in date — the lapsed examples come from the sample data.');
}
