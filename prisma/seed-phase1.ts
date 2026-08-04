import type { PrismaClient } from '@prisma/client';

/**
 * Sample records for Phase 1, behind SEED_SAMPLE_DATA.
 *
 * The point of it is the *spread* of compliance states. A seed where
 * everything is in date proves nothing: the four-state indicator, the
 * blocked-assignment path and the "expiry not recorded" bucket all need a
 * record that exercises them. So this deliberately includes a lapsed PHV
 * badge, an MOT expiring inside a week, and a driver whose licence has no
 * date at all.
 *
 * Dates are relative to the run, so the fixtures never go stale.
 *
 * Names are invented and generic — nothing here names the real customer.
 */

function dateIn(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export async function seedSampleData(prisma: PrismaClient): Promise<void> {
  if (process.env.SEED_SAMPLE_DATA !== 'true') return;

  const existing = await prisma.driver.count();
  if (existing > 0) {
    console.log('✓ Sample data already present — left untouched');
    return;
  }

  const accounts = await Promise.all(
    [
      { name: 'House Account', kind: 'INTERNAL' as const, paymentTermsDays: 0 },
      { name: 'Northgate Travel', kind: 'AGENCY' as const, paymentTermsDays: 30 },
      { name: 'Fenwick Partners', kind: 'CORPORATE' as const, paymentTermsDays: 14 },
    ].map((account) =>
      prisma.account.upsert({
        where: { name: account.name },
        update: {},
        create: account,
      }),
    ),
  );

  const vehicles = await Promise.all(
    [
      {
        registration: 'KR22 RRZ',
        make: 'Mercedes-Benz',
        model: 'EQE',
        vehicleClass: 'ELECTRIC_EXECUTIVE' as const,
        seats: 4,
        motExpiry: dateIn(240),
        insuranceExpiry: dateIn(150),
        phvLicenceExpiry: dateIn(200),
      },
      {
        registration: 'LT71 XKD',
        make: 'Mercedes-Benz',
        model: 'V-Class',
        vehicleClass: 'MPV' as const,
        seats: 7,
        // Inside the critical window: the amber-to-red transition.
        motExpiry: dateIn(4),
        insuranceExpiry: dateIn(180),
        phvLicenceExpiry: dateIn(90),
      },
      {
        registration: 'BD70 OME',
        make: 'Range Rover',
        model: 'Sport',
        vehicleClass: 'SUV' as const,
        seats: 5,
        motExpiry: dateIn(60),
        // Lapsed: this vehicle must be unassignable.
        insuranceExpiry: dateIn(-12),
        phvLicenceExpiry: dateIn(120),
      },
      {
        registration: 'YE19 PTU',
        make: 'Mercedes-Benz',
        model: 'S-Class',
        vehicleClass: 'LUXURY' as const,
        seats: 4,
        motExpiry: dateIn(21),
        insuranceExpiry: dateIn(300),
        // No date recorded — the state the legacy system left everything in.
        phvLicenceExpiry: null,
      },
      {
        registration: 'GX23 LMN',
        make: 'BMW',
        model: '5 Series',
        vehicleClass: 'EXECUTIVE' as const,
        seats: 4,
        motExpiry: dateIn(400),
        insuranceExpiry: dateIn(220),
        phvLicenceExpiry: dateIn(340),
      },
    ].map((vehicle) =>
      prisma.vehicle.create({
        data: {
          ...vehicle,
          normalisedRegistration: vehicle.registration.replace(/[^A-Z0-9]/g, ''),
        },
      }),
    ),
  );

  const drivers = [
    {
      reference: 'DRV-0001',
      name: 'Amara Okafor',
      phone: '07700 900101',
      dvlaLicenceExpiry: dateIn(500),
      phvBadgeExpiry: dateIn(210),
      phvIssuingAuthority: 'TfL',
      assignedVehicleId: vehicles[0]!.id,
    },
    {
      reference: 'DRV-0002',
      name: 'Tomasz Wilk',
      phone: '07700 900102',
      dvlaLicenceExpiry: dateIn(430),
      // Compliant himself, but his van's MOT is days away.
      phvBadgeExpiry: dateIn(95),
      phvIssuingAuthority: 'TfL',
      assignedVehicleId: vehicles[1]!.id,
    },
    {
      reference: 'DRV-0003',
      name: 'Priya Raman',
      phone: '07700 900103',
      dvlaLicenceExpiry: dateIn(600),
      // Lapsed badge: blocked regardless of the car.
      phvBadgeExpiry: dateIn(-19),
      phvIssuingAuthority: 'TfL',
      assignedVehicleId: vehicles[2]!.id,
    },
    {
      reference: 'DRV-0004',
      name: 'Sean Duffy',
      phone: '07700 900104',
      // No licence date recorded — must not read as compliant.
      dvlaLicenceExpiry: null,
      phvBadgeExpiry: dateIn(120),
      phvIssuingAuthority: 'Elmbridge',
      assignedVehicleId: vehicles[3]!.id,
    },
    {
      reference: 'DRV-0005',
      name: 'Grace Adeyemi',
      phone: '07700 900105',
      dvlaLicenceExpiry: dateIn(365),
      phvBadgeExpiry: dateIn(25),
      phvIssuingAuthority: 'TfL',
      assignedVehicleId: vehicles[4]!.id,
    },
  ];

  for (const driver of drivers) {
    await prisma.driver.create({ data: driver });
  }

  const clients = [
    {
      name: 'Mr Yinka Balogun',
      normalisedName: 'yinka balogun',
      contactPhone: '07700 900201',
      defaultAccountId: accounts[2]!.id,
    },
    {
      // Deliberately collides with the first on the normalised key, so the
      // duplicate warning has something to find on a fresh install.
      name: 'MR yinka balogun',
      normalisedName: 'yinka balogun',
      contactPhone: '07700 900202',
      defaultAccountId: null,
    },
    {
      name: 'Halloway Group',
      normalisedName: 'halloway group',
      contactEmail: 'travel@halloway.example',
      defaultAccountId: accounts[1]!.id,
      paymentTermsDays: 30,
    },
  ];

  for (const client of clients) {
    await prisma.client.create({ data: client });
  }

  console.log(
    `✓ Sample data: ${accounts.length} accounts, ${vehicles.length} vehicles, ${drivers.length} drivers, ${clients.length} clients`,
  );
  console.log('  Includes an expired badge, a lapsed insurance policy and two');
  console.log('  records with no expiry date — the states the indicators exist for.');
}
