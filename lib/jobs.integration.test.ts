import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countUnpricedCompleted,
  createJob,
  findDriverConflicts,
  jobSchema,
  listJobs,
  transitionJob,
} from './jobs';

/**
 * The job lifecycle against a real database.
 *
 * The pure rules are covered in `job-status.test.ts`. What can only be proven
 * here is that they are actually *wired up*: that the status column and the
 * event row are written in one transaction, that a guard reads committed
 * state rather than what the caller passed, and that the unpriced filter
 * matches the same jobs the predicate does.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const audit = { userId: null, ip: null };

const listParams = {
  page: 1,
  pageSize: 50,
  skip: 0,
  take: 50,
  q: null,
  sort: null,
  dir: 'asc' as const,
};

const noFilters = {
  status: null,
  jobType: null,
  driverId: null,
  clientId: null,
  accountId: null,
  vehicleId: null,
  from: null,
  to: null,
  unpricedOnly: false,
};

/** Far enough out that compliance dates in the fixtures stay valid. */
function futureDate(daysAhead: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

function jobInput(overrides: Record<string, unknown> = {}) {
  return jobSchema.parse({
    jobType: 'TRANSFER',
    scheduledDate: futureDate(7),
    scheduledTime: '14:30',
    pickupText: 'The Dorchester',
    dropoffText: 'Heathrow T5',
    ...overrides,
  });
}

describe.skipIf(!DATABASE_AVAILABLE)('job lifecycle', () => {
  const jobIds: string[] = [];
  const invoiceIds: string[] = [];
  let driverId = '';
  let vehicleId = '';
  let expiredDriverId = '';

  beforeAll(async () => {
    if (!raw) return;
    await raw.$connect();

    const stamp = Date.now();
    const far = new Date();
    far.setFullYear(far.getFullYear() + 2);

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `JT${String(stamp).slice(-5)}`,
        normalisedRegistration: `JT${String(stamp).slice(-5)}`,
        make: 'Mercedes-Benz',
        model: 'E-Class',
        vehicleClass: 'EXECUTIVE',
        seats: 4,
        status: 'ACTIVE',
        motExpiry: far,
        insuranceExpiry: far,
        phvLicenceExpiry: far,
      },
    });
    vehicleId = vehicle.id;

    const driver = await raw.driver.create({
      data: {
        reference: `DRV-J${String(stamp).slice(-5)}`,
        name: 'Compliant Driver',
        phone: '07700900311',
        dvlaLicenceExpiry: far,
        phvBadgeExpiry: far,
        assignedVehicleId: vehicle.id,
      },
    });
    driverId = driver.id;

    const lapsed = new Date();
    lapsed.setDate(lapsed.getDate() - 10);
    const expired = await raw.driver.create({
      data: {
        reference: `DRV-X${String(stamp).slice(-5)}`,
        name: 'Lapsed Badge Driver',
        phone: '07700900312',
        dvlaLicenceExpiry: far,
        phvBadgeExpiry: lapsed,
        assignedVehicleId: vehicle.id,
      },
    });
    expiredDriverId = expired.id;
  });

  afterAll(async () => {
    if (!raw) return;
    // Lines before invoices, invoices before jobs — the foreign keys point
    // the other way, and a cleanup in the wrong order fails and leaves the
    // fixtures behind for the next run to trip over.
    if (invoiceIds.length > 0) {
      await raw.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    }
    if (jobIds.length > 0) {
      await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    }
    await raw.driver.deleteMany({
      where: { id: { in: [driverId, expiredDriverId].filter(Boolean) } },
    });
    if (vehicleId) await raw.vehicle.deleteMany({ where: { id: vehicleId } });
    await raw.$disconnect();
  });

  async function makeJob(overrides: Record<string, unknown> = {}) {
    const created = await createJob(jobInput(overrides), audit);
    jobIds.push(created.id);
    return created;
  }

  /** A job taken all the way to `COMPLETED` through the real transitions. */
  async function makeCompletedJob() {
    const created = await makeJob({ driverId, vehicleId, clientPricePence: '125.50' });
    await transitionJob(created.id, 'ASSIGNED', audit);
    await transitionJob(created.id, 'IN_PROGRESS', audit);
    expect((await transitionJob(created.id, 'COMPLETED', audit)).ok).toBe(true);
    return created;
  }

  /** Put a job on an invoice in the given status. */
  async function invoiceJob(jobId: string, status: 'DRAFT' | 'SENT' | 'PART_PAID') {
    const today = new Date();
    const invoice = await raw!.invoice.create({
      data: {
        number: `INV-T${Date.now()}-${invoiceIds.length}`,
        issueDate: today,
        dueDate: today,
        netPence: 12550,
        vatPence: 2510,
        grossPence: 15060,
        paidPence: status === 'PART_PAID' ? 5000 : 0,
        status,
        lines: {
          create: { jobId, description: 'Transfer', amountPence: 12550 },
        },
      },
    });
    invoiceIds.push(invoice.id);
    return invoice;
  }

  it('allocates a reference and writes a CREATED event atomically', async () => {
    const created = await makeJob();
    expect(created.reference).toMatch(/^[A-Z]+-\d{6,}$/);

    const events = await raw!.jobEvent.findMany({ where: { jobId: created.id } });
    expect(events.map((e) => e.type)).toContain('CREATED');
  });

  it('records a PRICE_SET event when the booking carried a price', async () => {
    // "Who set this price, and when" is what the legacy system could not say.
    const created = await makeJob({ clientPricePence: '125.50' });
    const events = await raw!.jobEvent.findMany({ where: { jobId: created.id } });
    expect(events.map((e) => e.type)).toContain('PRICE_SET');
  });

  it('writes no PRICE_SET event for an unpriced booking', async () => {
    const created = await makeJob();
    const events = await raw!.jobEvent.findMany({ where: { jobId: created.id } });
    expect(events.map((e) => e.type)).not.toContain('PRICE_SET');
  });

  it('stores the London wall time as the right UTC instant', async () => {
    const created = await makeJob({ scheduledDate: '2026-08-04', scheduledTime: '14:30' });
    const row = await raw!.job.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.scheduledAt.toISOString()).toBe('2026-08-04T13:30:00.000Z');
  });

  it('refuses to complete an unpriced job', async () => {
    const created = await makeJob({ driverId, vehicleId });
    expect((await transitionJob(created.id, 'ASSIGNED', audit)).ok).toBe(true);
    expect((await transitionJob(created.id, 'IN_PROGRESS', audit)).ok).toBe(true);

    const result = await transitionJob(created.id, 'COMPLETED', audit);
    expect(result).toMatchObject({ ok: false, code: 'PRICE_REQUIRED' });

    // And the status must not have moved.
    const row = await raw!.job.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('IN_PROGRESS');
  });

  it('completes an unpriced job once a reason is supplied with the click', async () => {
    const created = await makeJob({ driverId, vehicleId });
    await transitionJob(created.id, 'ASSIGNED', audit);
    await transitionJob(created.id, 'IN_PROGRESS', audit);

    const result = await transitionJob(created.id, 'COMPLETED', audit, {
      zeroValueReason: 'Goodwill',
    });
    expect(result.ok).toBe(true);

    const row = await raw!.job.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('COMPLETED');
    expect(row.zeroValueReason).toBe('Goodwill');
  });

  it('completes a priced job without a reason', async () => {
    const created = await makeJob({ driverId, vehicleId, clientPricePence: '125.50' });
    await transitionJob(created.id, 'ASSIGNED', audit);
    await transitionJob(created.id, 'IN_PROGRESS', audit);
    expect((await transitionJob(created.id, 'COMPLETED', audit)).ok).toBe(true);
  });

  it('blocks assignment of a driver whose badge has lapsed, and says why', async () => {
    const created = await makeJob({ driverId: expiredDriverId, vehicleId });
    const result = await transitionJob(created.id, 'ASSIGNED', audit);

    expect(result).toMatchObject({ ok: false, code: 'DOCUMENT_EXPIRED' });
    if (!result.ok) {
      expect(result.reasons?.join(' ')).toMatch(/PHV badge/i);
    }

    const row = await raw!.job.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('PENDING');
  });

  it('refuses assignment without a driver', async () => {
    const created = await makeJob();
    expect(await transitionJob(created.id, 'ASSIGNED', audit)).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSITION',
    });
  });

  it('writes the status and its event in one transaction', async () => {
    const created = await makeJob({ driverId, vehicleId });
    await transitionJob(created.id, 'ASSIGNED', audit);

    const [row, events] = await Promise.all([
      raw!.job.findUniqueOrThrow({ where: { id: created.id } }),
      raw!.jobEvent.findMany({ where: { jobId: created.id, type: 'ASSIGNED' } }),
    ]);
    expect(row.status).toBe('ASSIGNED');
    expect(events).toHaveLength(1);
  });

  it('refuses an illegal jump and leaves the job untouched', async () => {
    const created = await makeJob({ driverId, vehicleId });
    const result = await transitionJob(created.id, 'COMPLETED', audit);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });

    const events = await raw!.jobEvent.findMany({
      where: { jobId: created.id, type: 'COMPLETED' },
    });
    expect(events).toHaveLength(0);
  });

  it('cancels a completed job that has not been invoiced', async () => {
    // The wrong job gets marked off the board, or the client stands one down
    // after the driver has been sent. Without this the only options were to
    // leave work on the books that never happened, or to edit the row by hand.
    const created = await makeCompletedJob();

    const result = await transitionJob(created.id, 'CANCELLED', audit);
    expect(result.ok).toBe(true);

    const row = await raw!.job.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('CANCELLED');

    const events = await raw!.jobEvent.findMany({
      where: { jobId: created.id, type: 'CANCELLED' },
    });
    expect(events).toHaveLength(1);
  });

  it('refuses to cancel a completed job that has been invoiced', async () => {
    const created = await makeCompletedJob();
    const invoice = await invoiceJob(created.id, 'SENT');

    const result = await transitionJob(created.id, 'CANCELLED', audit);
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_LOCKED' });
    if (!result.ok) {
      expect(result.message).toContain(invoice.number);
      expect(result.message).toContain('credit note');
    }

    const row = await raw!.job.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('COMPLETED');
  });

  it('holds the lock for a part-paid invoice too', async () => {
    // The list of locking statuses used to be spelled out by hand as
    // SENT and PAID, so a job on an invoice the client had part-paid could
    // be cancelled while the invoice went on asking for the money.
    const created = await makeCompletedJob();
    await invoiceJob(created.id, 'PART_PAID');

    expect(await transitionJob(created.id, 'CANCELLED', audit)).toMatchObject({
      ok: false,
      code: 'INVOICE_LOCKED',
    });
  });

  it('sends a draft invoice back to the invoice rather than to a credit note', async () => {
    const created = await makeCompletedJob();
    const invoice = await invoiceJob(created.id, 'DRAFT');

    const result = await transitionJob(created.id, 'CANCELLED', audit);
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_LOCKED' });
    if (!result.ok) {
      expect(result.message).toContain(invoice.number);
      expect(result.message).toContain('Remove it from that invoice');
    }
  });

  it('reports a missing job rather than throwing', async () => {
    expect(await transitionJob('does_not_exist', 'ASSIGNED', audit)).toMatchObject({
      ok: false,
    });
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('the unpriced filter', () => {
  const jobIds: string[] = [];

  afterAll(async () => {
    if (!raw) return;
    if (jobIds.length > 0) {
      await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    }
    await raw.$disconnect();
  });

  it('keeps cancelled jobs out of the list until they are asked for', async () => {
    // A cancelled booking is not work. Left in the list it pads every page,
    // skews the counts and buries the jobs that do need attention.
    const marker = `Cancelled Fixture ${Date.now()}`;
    const live = await createJob(jobInput({ pickupText: marker }), audit);
    const dropped = await createJob(jobInput({ pickupText: marker }), audit);
    jobIds.push(live.id, dropped.id);
    await raw!.job.update({
      where: { id: dropped.id },
      data: { status: 'CANCELLED' },
    });

    const listed = await listJobs({ ...listParams, q: marker }, noFilters);
    expect(listed.total).toBe(1);
    expect(listed.rows.map((row) => row.id)).toEqual([live.id]);

    // …and the unpriced tally follows the same view, so a cancelled job with
    // no price is not something the dashboard chases.
    expect(listed.unpriced).toBe(1);

    // Asking for them specifically brings them back.
    const asked = await listJobs(
      { ...listParams, q: marker },
      { ...noFilters, status: 'CANCELLED' },
    );
    expect(asked.rows.map((row) => row.id)).toEqual([dropped.id]);
  });

  it('counts unpriced within the current filter, not across the database', async () => {
    // The spread that used to build this count replaced the filter's own AND
    // clause, so the tally ignored the search and described the whole table.
    const marker = `Unpriced Scope Fixture ${Date.now()}`;
    const unpricedJob = await createJob(jobInput({ pickupText: marker }), audit);
    const priced = await createJob(
      jobInput({ pickupText: marker, clientPricePence: '125.50' }),
      audit,
    );
    jobIds.push(unpricedJob.id, priced.id);

    // No unpriced filter — just a search. The count must describe the search.
    const { total, unpriced } = await listJobs(
      { ...listParams, q: marker },
      noFilters,
    );
    expect(total).toBe(2);
    expect(unpriced).toBe(1);
  });

  it('matches exactly the jobs the predicate calls unpriced', async () => {
    // A unique pickup so the assertion sees only these three rows. Without it
    // the query returns page one of every unpriced job in the database, and
    // against a seeded volume the fixtures are simply not on it.
    const marker = `Unpriced Filter Fixture ${Date.now()}`;

    const unpricedJob = await createJob(jobInput({ pickupText: marker }), audit);
    const zeroWithReason = await createJob(
      jobInput({
        pickupText: marker,
        clientPricePence: '0',
        zeroValueReason: 'Goodwill',
      }),
      audit,
    );
    const priced = await createJob(
      jobInput({ pickupText: marker, clientPricePence: '125.50' }),
      audit,
    );
    jobIds.push(unpricedJob.id, zeroWithReason.id, priced.id);

    const { rows } = await listJobs(
      { ...listParams, q: marker },
      { ...noFilters, unpricedOnly: true },
    );
    const ids = rows.map((row) => row.id);

    expect(ids).toContain(unpricedJob.id);
    // A zero with a written reason is a decision, not a gap.
    expect(ids).not.toContain(zeroWithReason.id);
    expect(ids).not.toContain(priced.id);
  });

  it('counts unpriced jobs across the whole filter, not just the page', async () => {
    // Creates its own, so the assertion holds on an empty database as well as
    // a seeded one.
    const marker = `Unpriced Count Fixture ${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      const created = await createJob(jobInput({ pickupText: marker }), audit);
      jobIds.push(created.id);
    }

    const { rows, total, unpriced } = await listJobs(
      { ...listParams, pageSize: 1, take: 1, q: marker },
      { ...noFilters, unpricedOnly: true },
    );

    // One row comes back, but the counts describe the whole filter — "12
    // unpriced" has to mean twelve in this view, not twelve on this screen.
    // The invariant is that relationship, not an exact tally: the suite runs
    // in parallel against a shared database.
    expect(rows).toHaveLength(1);
    expect(unpriced).toBe(3);
    expect(total).toBe(unpriced);
  });

  it('counts only completed jobs for the dashboard tile', async () => {
    // The tile is about work that was delivered and never billed. A pending
    // job with no price yet is normal, not a defect.
    const before = await countUnpricedCompleted();
    const pending = await createJob(jobInput(), audit);
    jobIds.push(pending.id);
    expect(await countUnpricedCompleted()).toBe(before);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('driver conflict detection', () => {
  const jobIds: string[] = [];
  let driverId = '';

  beforeAll(async () => {
    if (!raw) return;
    await raw.$connect();
    const driver = await raw.driver.create({
      data: {
        reference: `DRV-C${String(Date.now()).slice(-5)}`,
        name: 'Busy Driver',
        phone: '07700900313',
      },
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    if (!raw) return;
    if (jobIds.length > 0) {
      await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    }
    if (driverId) await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.$disconnect();
  });

  it('finds another job inside the buffer', async () => {
    const day = futureDate(21);
    const first = await createJob(
      jobInput({ driverId, scheduledDate: day, scheduledTime: '14:00' }),
      audit,
    );
    jobIds.push(first.id);

    const at = new Date(`${day}T14:30:00Z`);
    const conflicts = await findDriverConflicts(driverId, at, 90);
    expect(conflicts.map((c) => c.id)).toContain(first.id);
  });

  it('ignores a job comfortably outside the buffer', async () => {
    const day = futureDate(22);
    const first = await createJob(
      jobInput({ driverId, scheduledDate: day, scheduledTime: '06:00' }),
      audit,
    );
    jobIds.push(first.id);

    const at = new Date(`${day}T20:00:00Z`);
    expect(await findDriverConflicts(driverId, at, 90)).toEqual([]);
  });

  it('excludes the job being edited, so it does not clash with itself', async () => {
    const day = futureDate(23);
    const job = await createJob(
      jobInput({ driverId, scheduledDate: day, scheduledTime: '09:00' }),
      audit,
    );
    jobIds.push(job.id);

    const at = new Date(`${day}T08:00:00Z`);
    const conflicts = await findDriverConflicts(driverId, at, 90, job.id);
    expect(conflicts.map((c) => c.id)).not.toContain(job.id);
  });

  it('ignores cancelled and completed jobs', async () => {
    const day = futureDate(24);
    const job = await createJob(
      jobInput({ driverId, scheduledDate: day, scheduledTime: '10:00' }),
      audit,
    );
    jobIds.push(job.id);
    await raw!.job.update({ where: { id: job.id }, data: { status: 'CANCELLED' } });

    const at = new Date(`${day}T09:30:00Z`);
    expect(await findDriverConflicts(driverId, at, 90)).toEqual([]);
  });
});
