import { prisma } from './prisma';

/**
 * The option lists the booking form needs.
 *
 * Loaded once per render rather than per field so a form with five selects
 * makes five queries, not fifteen. Each list is capped: an operator scrolling
 * a thousand-entry select is a worse experience than typing a search, and
 * Phase 3's client search replaces these with a typeahead.
 */
export async function loadJobFormOptions() {
  const [clients, accounts, drivers, vehicles, locations] = await Promise.all([
    prisma.client.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.account.findMany({
      select: { id: true, name: true, kind: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.driver.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true, reference: true, assignedVehicleId: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.vehicle.findMany({
      where: { status: 'ACTIVE' },
      // The class comes along because the rate card matches on it: a rule
      // for executive cars cannot be applied to a booking whose vehicle the
      // form knows about but whose class it does not.
      select: {
        id: true,
        registration: true,
        make: true,
        model: true,
        vehicleClass: true,
      },
      orderBy: { registration: 'asc' },
      take: 500,
    }),
    prisma.location.findMany({
      select: { label: true, address: true },
      // Most-used first: the autocomplete should offer Heathrow T5 before a
      // hotel someone entered once.
      orderBy: [{ useCount: 'desc' }, { label: 'asc' }],
      take: 500,
    }),
  ]);

  return {
    clients: clients.map((c) => ({ id: c.id, label: c.name })),
    accounts: accounts.map((a) => ({ id: a.id, label: `${a.name} · ${a.kind}` })),
    drivers: drivers.map((d) => ({
      id: d.id,
      label: `${d.name} · ${d.reference}`,
      assignedVehicleId: d.assignedVehicleId,
    })),
    vehicles: vehicles.map((v) => ({
      id: v.id,
      label: `${v.registration} · ${v.make} ${v.model}`,
      vehicleClass: v.vehicleClass as string,
    })),
    locations: locations.map((l) => l.label || l.address),
  };
}

/**
 * Shifts currently open, for attributing a hired driver's job.
 *
 * Only open ones: attributing a job to a shift that has already been closed
 * and paid would change what someone was owed after the fact.
 */
export async function loadOpenShifts() {
  const shifts = await prisma.driverShift.findMany({
    where: { endedAt: null },
    select: {
      id: true,
      reference: true,
      startedAt: true,
      driver: { select: { name: true } },
    },
    orderBy: { startedAt: 'desc' },
    take: 100,
  });

  return shifts.map((shift) => ({
    id: shift.id,
    label: `${shift.reference} · ${shift.driver.name}`,
  }));
}
