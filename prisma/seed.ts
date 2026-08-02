import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../lib/password';

/**
 * Seeds the minimum a fresh install needs to be usable: one administrator,
 * the standard London zones and a default rate card.
 *
 * Safe to re-run — everything is an upsert keyed on a natural identifier, so
 * running it twice does not create a second admin or duplicate zones.
 *
 * Nothing here names a customer. The example company is generic; Phase 3's
 * setup wizard captures the real details.
 */

// The seed client is intentionally unextended: it must be able to see and
// repair soft-deleted rows.
const prisma = new PrismaClient();

const ZONES: Array<{ name: string; postcodes: string[] }> = [
  { name: 'Heathrow', postcodes: ['TW6', 'TW14', 'UB7', 'UB3'] },
  { name: 'Gatwick', postcodes: ['RH6'] },
  { name: 'Luton', postcodes: ['LU2'] },
  { name: 'Stansted', postcodes: ['CM24'] },
  { name: 'London City', postcodes: ['E16'] },
  {
    name: 'Central London',
    postcodes: [
      'W1', 'W2', 'SW1', 'SW3', 'SW7', 'WC1', 'WC2', 'EC1', 'EC2', 'EC3',
      'EC4', 'NW1', 'SE1',
    ],
  },
  {
    name: 'Greater London',
    postcodes: [
      'E', 'N', 'NW', 'SE', 'SW', 'W', 'BR', 'CR', 'DA', 'EN', 'HA', 'IG',
      'KT', 'RM', 'SM', 'TW', 'UB', 'WD',
    ],
  },
  { name: 'Outside M25', postcodes: [] },
];

async function seedAdmin(): Promise<void> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com')
    .trim()
    .toLowerCase();
  const name = process.env.SEED_ADMIN_NAME ?? 'Administrator';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`✓ Admin ${email} already exists — left untouched`);
    return;
  }

  // A generated password beats a well-known default that survives to
  // production because nobody got round to changing it.
  const password =
    process.env.SEED_ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');

  await prisma.user.create({
    data: {
      email,
      name,
      role: 'ADMIN',
      passwordHash: await hashPassword(password),
    },
  });

  console.log(`✓ Created ADMIN ${email}`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(`  Password: ${password}`);
    console.log('  Save it now — it is not stored anywhere and not recoverable.');
  }
}

async function seedZones(): Promise<void> {
  for (const zone of ZONES) {
    await prisma.zone.upsert({
      where: { name: zone.name },
      update: { postcodes: zone.postcodes },
      create: { name: zone.name, postcodes: zone.postcodes },
    });
  }
  console.log(`✓ ${ZONES.length} zones`);
}

async function seedRateCard(): Promise<void> {
  const existing = await prisma.rateCard.findFirst({
    where: { isDefault: true, deletedAt: null },
  });
  if (existing) {
    console.log('✓ Default rate card already exists — left untouched');
    return;
  }

  const card = await prisma.rateCard.create({
    data: {
      name: 'Standard',
      activeFrom: new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)),
      isDefault: true,
    },
  });

  // Placeholder rules with zero fares. Real commercial rates are a business
  // decision, captured in Phase 4 — seeding invented prices would put
  // fictional numbers into revenue reports.
  await prisma.rateCardRule.createMany({
    data: [
      {
        rateCardId: card.id,
        jobType: 'AIRPORT_TRANSFER',
        // Airport pickups get the longer free wait: a delayed flight is not
        // the client's fault and 15 minutes never survives a baggage hall.
        freeWaitMinutes: 45,
        priority: 10,
      },
      {
        rateCardId: card.id,
        jobType: 'TRANSFER',
        freeWaitMinutes: 15,
        priority: 10,
      },
      {
        rateCardId: card.id,
        jobType: 'AS_DIRECTED',
        freeWaitMinutes: 15,
        priority: 10,
      },
    ],
  });

  console.log('✓ Default rate card with one rule per job type');
  console.log('  Fares are zero — set the real rates in Phase 4.');
}

async function main(): Promise<void> {
  console.log('Seeding…');
  await seedAdmin();
  await seedZones();
  await seedRateCard();
  console.log('Done.');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
