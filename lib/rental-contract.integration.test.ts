import { rawPrismaClient } from './raw-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rentalContractHtml } from './rental-contract-pdf';
import { createRental, rentalSchema } from './rental-store';

/**
 * A hire, from the form to the agreement.
 *
 * The unit tests cover the template with data handed to it. This covers the
 * half that cannot be faked: that a hire booked to a company or to somebody
 * with no record here survives the round trip through Postgres and comes out
 * of the contract naming the right party.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

/** Two days from now, so a fixture never collides with a real booking. */
const startAt = new Date(Date.now() + 48 * 3_600_000);
const endAt = new Date(Date.now() + 96 * 3_600_000);
const asLocal = (date: Date) => date.toISOString().slice(0, 16);

let vehicleId = '';
let driverId = '';
let accountId = '';
const created: string[] = [];

describe.skipIf(!DATABASE_AVAILABLE)('hire agreement', () => {
  beforeAll(async () => {
    if (!raw) return;
    const vehicle = await raw.vehicle.create({
      data: {
        registration: `LC${stamp}`,
        normalisedRegistration: `LC${stamp}`,
        make: 'Land Rover',
        model: 'Range Rover',
        variant: 'Autobiography',
        // The facts a contract has to state about the car.
        chassisNumber: `SAL${stamp}`,
        firstRegisteredOn: new Date('2026-07-08'),
        valuePence: 14_300_000,
        insurerName: 'Tradex',
        insurancePolicyNo: 'P-TFL00294855/05',
      },
    });
    vehicleId = vehicle.id;

    const driver = await raw.driver.create({
      data: {
        name: `Hire Driver ${stamp}`,
        phone: `07700 9${stamp}`,
        normalisedPhone: `77009${stamp}`,
        reference: `DRV-H${stamp}`,
      },
    });
    driverId = driver.id;

    const account = await raw.account.create({
      data: { name: `SUL Business Academy ${stamp}`, kind: 'CORPORATE' },
    });
    accountId = account.id;
  });

  afterAll(async () => {
    if (!raw) return;
    // Checklist items reference the rental, so they go first.
    const rentals = await raw.vehicleRental.findMany({
      where: { vehicleId },
      select: { id: true },
    });
    const rentalIds = rentals.map((rental) => rental.id);
    await raw.rentalChecklistItem.deleteMany({ where: { rentalId: { in: rentalIds } } });
    await raw.vehicleRental.deleteMany({ where: { vehicleId } });
    await raw.vehicle.deleteMany({ where: { id: vehicleId } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.account.deleteMany({ where: { name: { contains: stamp } } });
    await raw.$disconnect();
  });

  const book = (overrides: Record<string, unknown>) =>
    createRental(
      rentalSchema.parse({
        vehicleId,
        startAt: asLocal(startAt),
        endAt: asLocal(endAt),
        rateType: 'DAILY',
        ratePence: '180.00',
        depositPence: '1000.00',
        insuranceExcessPence: '2500.00',
        excessMileagePence: '1.50',
        mileageAllowancePerDay: '175',
        congestionChargePence: '15.00',
        minimumTermDays: '4',
        depositReturnDays: '10',
        ownerSignatory: 'Waleed Ahmed, Director',
        ...overrides,
      }),
      {},
    );

  it('books a car out to a company and names it on the contract', async () => {
    const result = await book({ renterType: 'ACCOUNT', accountId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.id);

    const html = await rentalContractHtml(result.id);
    expect(html).toContain(`SUL Business Academy ${stamp}`);
    // The terms the operator typed, not a default invented downstream.
    expect(html).toContain('£2,500.00');
    expect(html).toContain('175 miles');
    expect(html).toContain('Waleed Ahmed, Director');
    // …and the car, identified well enough to be enforceable.
    expect(html).toContain(`SAL${stamp}`);
    expect(html).toContain('£143,000.00');
    expect(html).toContain('Tradex');
  });

  it('books a car out to somebody with no record, and saves them', async () => {
    // Cancel the first so the vehicle is free for the same window.
    await raw!.vehicleRental.updateMany({
      where: { vehicleId },
      data: { status: 'CANCELLED' },
    });

    const result = await book({
      renterType: 'EXTERNAL',
      hirerName: `Mr James Campbell ${stamp}`,
      hirerAddress: 'Flat 7, Rowlock House, West Drayton, UB7 7FX',
      hirerPhone: '+44 7446 833511',
      hirerLicenceNumber: 'CAMPB902214JA9LJ',
      saveHirerAsAccount: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.id);

    const html = await rentalContractHtml(result.id);
    expect(html).toContain(`Mr James Campbell ${stamp}`);
    expect(html).toContain('CAMPB902214JA9LJ');
    expect(html).toContain('Rowlock House');

    // Asked for: a one-off hirer becomes an account, so the second hire picks
    // them from the list rather than retyping — and spelling it twice would
    // otherwise make two customers.
    const saved = await raw!.account.findFirst({
      where: { name: `Mr James Campbell ${stamp}` },
    });
    expect(saved).not.toBeNull();
    expect(saved?.kind).toBe('INDIVIDUAL');
    expect(saved?.billingAddress).toContain('Rowlock House');
  });

  it('refuses a hire that names nobody', async () => {
    // A hire agreement with no hirer is not a contract.
    expect(() =>
      rentalSchema.parse({
        vehicleId,
        renterType: 'EXTERNAL',
        startAt: asLocal(startAt),
        endAt: asLocal(endAt),
        rateType: 'DAILY',
        ratePence: '180.00',
        depositPence: '0',
      }),
    ).toThrow();
  });

  it('leaves a term nobody agreed as a line to write on', async () => {
    await raw!.vehicleRental.updateMany({
      where: { vehicleId },
      data: { status: 'CANCELLED' },
    });

    const result = await book({
      renterType: 'DRIVER',
      driverId,
      insuranceExcessPence: '',
      excessMileagePence: '',
      mileageAllowancePerDay: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const html = await rentalContractHtml(result.id);

    // The excess must never read "£0.00" — that states the hirer owes nothing
    // in the event of a claim. An advance payment of zero is different: none
    // was taken, and saying so is accurate.
    const at = (html ?? '').indexOf('excess fee of');
    const excessClause = (html ?? '').slice(at, at + 80);
    expect(excessClause).toContain('class="rule"');
    expect(excessClause).not.toContain('£0.00');

    // Same for the mileage allowance and the per-mile charge. Matched on the
    // cell that follows each label rather than the label's exact punctuation,
    // which is wording and free to change.
    for (const label of ['Daily mileage allowance', 'Excess mileage charge']) {
      const row = new RegExp(`${label}[^<]*</th><td>([^<]*<span class="rule")`);
      expect(html, `${label} should print a line to write on`).toMatch(row);
    }
  });
});
