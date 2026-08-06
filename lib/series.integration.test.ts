import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toLondon } from './dates';
import { jobSchema, type JobInput } from './jobs';
import {
  applySeriesEdit,
  createSeries,
  endSeries,
  getSeries,
  jobsInScope,
  linkedLegs,
  linkReturn,
  listSeries,
  recurrenceSchema,
  returnDefaults,
} from './series';

/**
 * Recurring and linked jobs against a real database — spec 6.3.
 *
 * The arithmetic is covered exhaustively in `recurrence.test.ts`. What needs
 * a database is the part the pure tests cannot reach: that generation
 * produces genuinely independent jobs, that "this and future" reaches the
 * right ones, and that a return links both ways.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const LONDON = 'Europe/London';
const stamp = String(Date.now()).slice(-7);

/** A year ahead, so nothing here collides with the perf seed's spread. */
const YEAR = new Date().getUTCFullYear() + 2;

function input(over: Partial<JobInput> = {}): JobInput {
  return jobSchema.parse({
    clientId: '',
    accountId: '',
    jobType: 'TRANSFER',
    scheduledDate: `${YEAR}-09-01`,
    scheduledTime: '09:00',
    pickupText: `Series Pickup ${stamp}`,
    dropoffText: 'Heathrow Terminal 5',
    clientPricePence: '125.50',
    driverPricePence: '80.00',
    customerHours: null,
    customerRatePence: '',
    minimumHours: null,
    stops: [],
    ...over,
  });
}

const recurrence = (over: Record<string, unknown> = {}) =>
  recurrenceSchema.parse({ frequency: 'DAILY', interval: 1, occurrences: 3, ...over });

describe.skipIf(!DATABASE_AVAILABLE)('job series', () => {
  const seriesIds: string[] = [];
  const jobIds: string[] = [];

  const track = <T extends { seriesId: string; jobIds: string[] }>(result: T): T => {
    seriesIds.push(result.seriesId);
    jobIds.push(...result.jobIds);
    return result;
  };

  afterAll(async () => {
    if (!raw) return;
    // Return links first: a job cannot be deleted while another points at it.
    await raw.job.updateMany({
      where: { id: { in: jobIds } },
      data: { returnOfJobId: null, seriesId: null },
    });
    await raw.jobFinance.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await raw.auditLog.deleteMany({ where: { entityId: { in: [...jobIds, ...seriesIds] } } });
    await raw.job.deleteMany({ where: { id: { in: jobIds } } });
    await raw.jobSeries.deleteMany({ where: { id: { in: seriesIds } } });
    await raw.$disconnect();
  });

  it('generates one job per occurrence, each with its own reference', async () => {
    // Spec 6.3.4. Independent jobs, not views onto a rule.
    const result = track(await createSeries(input(), recurrence(), {}, LONDON));

    expect(result.jobIds).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);

    const jobs = await raw!.job.findMany({
      where: { id: { in: result.jobIds } },
      orderBy: { scheduledAt: 'asc' },
    });

    expect(new Set(jobs.map((job) => job.reference)).size).toBe(3);
    expect(jobs.map((job) => toLondon(job.scheduledAt, LONDON))).toEqual([
      `${YEAR}-09-01T09:00`,
      `${YEAR}-09-02T09:00`,
      `${YEAR}-09-03T09:00`,
    ]);
    expect(jobs.map((job) => job.seriesIndex)).toEqual([1, 2, 3]);
  });

  it('gives every generated job a CREATED event and an audit entry', async () => {
    // Each one goes through the ordinary booking path, so nothing about a
    // series is exempt from the record a one-off booking leaves.
    const result = track(await createSeries(input(), recurrence({ occurrences: 2 }), {}, LONDON));

    for (const id of result.jobIds) {
      const events = await raw!.jobEvent.count({ where: { jobId: id, type: 'CREATED' } });
      const audits = await raw!.auditLog.count({ where: { entity: 'Job', entityId: id } });
      expect(events, `job ${id} has no CREATED event`).toBe(1);
      expect(audits, `job ${id} has no audit entry`).toBeGreaterThan(0);
    }
  });

  it('leaves its jobs standing when the series row is detached', async () => {
    // A job generated from a series is a real booking. Losing the rule must
    // not lose the work.
    const result = track(await createSeries(input(), recurrence({ occurrences: 2 }), {}, LONDON));

    await raw!.job.updateMany({
      where: { id: { in: result.jobIds } },
      data: { seriesId: null },
    });

    const survivors = await raw!.job.count({ where: { id: { in: result.jobIds } } });
    expect(survivors).toBe(2);

    // Put them back so the scope tests below still have a series.
    await raw!.job.updateMany({
      where: { id: { in: result.jobIds } },
      data: { seriesId: result.seriesId },
    });
  });

  it('holds the local time across a clock change', async () => {
    // The reason the whole module works in wall-clock terms. Clocks go
    // forward on the last Sunday of March; a series generated by adding
    // elapsed time would slip to 10:00.
    const result = track(
      await createSeries(
        input({ scheduledDate: `${YEAR}-03-27`, scheduledTime: '07:30' }),
        recurrence({ occurrences: 6 }),
        {},
        LONDON,
      ),
    );

    const jobs = await raw!.job.findMany({
      where: { id: { in: result.jobIds } },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    });

    for (const job of jobs) {
      expect(toLondon(job.scheduledAt, LONDON).endsWith('T07:30')).toBe(true);
    }
  });

  describe('scope', () => {
    let seriesId = '';
    let ids: string[] = [];

    beforeAll(async () => {
      if (!raw) return;
      const result = track(
        await createSeries(input(), recurrence({ occurrences: 5 }), {}, LONDON),
      );
      seriesId = result.seriesId;
      ids = result.jobIds;
    });

    it('“this job only” reaches exactly one', async () => {
      const scoped = await jobsInScope(seriesId, ids[2]!, 'this');
      expect(scoped.map((job) => job.id)).toEqual([ids[2]]);
    });

    it('“this and future” reaches this one and the later ones', async () => {
      // Spec 6.3.5. Not the earlier ones — a change made on the third
      // occurrence is not a change to the first two, which may already have
      // happened.
      const scoped = await jobsInScope(seriesId, ids[2]!, 'future');
      expect(scoped.map((job) => job.id)).toEqual([ids[2], ids[3], ids[4]]);
    });

    it('“all” reaches the whole series', async () => {
      const scoped = await jobsInScope(seriesId, ids[2]!, 'all');
      expect(scoped).toHaveLength(5);
    });

    it('leaves completed work out of a group change', async () => {
      // A COMPLETED job is history. "Cancel this and future" must not try to
      // rewrite it.
      await raw!.job.update({ where: { id: ids[3]! }, data: { status: 'COMPLETED' } });

      const scoped = await jobsInScope(seriesId, ids[2]!, 'future');
      expect(scoped.map((job) => job.id)).toEqual([ids[2], ids[4]]);

      await raw!.job.update({ where: { id: ids[3]! }, data: { status: 'PENDING' } });
    });

    it('refuses an anchor from a different series', async () => {
      const other = track(
        await createSeries(input(), recurrence({ occurrences: 1 }), {}, LONDON),
      );
      expect(await jobsInScope(seriesId, other.jobIds[0]!, 'future')).toEqual([]);
    });
  });

  describe('editing', () => {
    it('“this job only” leaves the rest alone', async () => {
      // Spec 6.3.5, and the default. An edit reaching further than the
      // operator meant is the failure worth designing against.
      const result = track(
        await createSeries(input(), recurrence({ occurrences: 3 }), {}, LONDON),
      );

      await applySeriesEdit(
        result.jobIds[0]!,
        input({ dropoffText: 'Gatwick North' }),
        'this',
        {},
        LONDON,
      );

      const jobs = await raw!.job.findMany({
        where: { id: { in: result.jobIds } },
        orderBy: { scheduledAt: 'asc' },
        select: { dropoffText: true },
      });

      expect(jobs.map((job) => job.dropoffText)).toEqual([
        'Gatwick North',
        'Heathrow Terminal 5',
        'Heathrow Terminal 5',
      ]);
    });

    it('“this and future” changes this one and the later ones', async () => {
      const result = track(
        await createSeries(input(), recurrence({ occurrences: 3 }), {}, LONDON),
      );

      // The anchor's own date, so this test is about reach and not about a
      // job being moved — that case has its own test below.
      const outcome = await applySeriesEdit(
        result.jobIds[1]!,
        input({ dropoffText: 'Gatwick North', scheduledDate: `${YEAR}-09-02` }),
        'future',
        {},
        LONDON,
      );

      expect(outcome.refused).toHaveLength(0);
      expect(outcome.changed).toHaveLength(2);

      const jobs = await raw!.job.findMany({
        where: { id: { in: result.jobIds } },
        orderBy: { scheduledAt: 'asc' },
        select: { dropoffText: true },
      });

      expect(jobs.map((job) => job.dropoffText)).toEqual([
        'Heathrow Terminal 5',
        'Gatwick North',
        'Gatwick North',
      ]);
    });

    it('never copies the date across the series', async () => {
      // The one field each occurrence owns. Propagating it would collapse
      // the whole series onto a single day.
      const result = track(
        await createSeries(input(), recurrence({ occurrences: 3 }), {}, LONDON),
      );

      const before = await raw!.job.findMany({
        where: { id: { in: result.jobIds } },
        orderBy: { scheduledAt: 'asc' },
        select: { id: true, scheduledAt: true },
      });

      await applySeriesEdit(
        result.jobIds[0]!,
        input({ dropoffText: 'Gatwick North' }),
        'future',
        {},
        LONDON,
      );

      const after = await raw!.job.findMany({
        where: { id: { in: result.jobIds } },
        orderBy: { scheduledAt: 'asc' },
        select: { id: true, scheduledAt: true },
      });

      expect(after.map((job) => job.scheduledAt.toISOString())).toEqual(
        before.map((job) => job.scheduledAt.toISOString()),
      );
      expect(new Set(after.map((job) => job.scheduledAt.getTime())).size).toBe(3);
    });

    it('reaches the jobs after where the anchor was, not where it is moved to', async () => {
      // The ordering that matters. `jobsInScope` reads the anchor's date to
      // decide what "future" means, so resolving the scope after applying the
      // edit would let moving a job earlier silently widen the change to
      // occurrences nobody selected.
      const result = track(
        await createSeries(input(), recurrence({ occurrences: 3 }), {}, LONDON),
      );

      // Edit the third job and move it back to the first day.
      const outcome = await applySeriesEdit(
        result.jobIds[2]!,
        input({ dropoffText: 'Gatwick North', scheduledDate: `${YEAR}-09-01` }),
        'future',
        {},
        LONDON,
      );

      expect(outcome.changed).toEqual([result.jobIds[2]]);

      const first = await raw!.job.findUnique({
        where: { id: result.jobIds[0]! },
        select: { dropoffText: true },
      });
      expect(first!.dropoffText).toBe('Heathrow Terminal 5');
    });

    it('audits every job it changed, individually', async () => {
      const result = track(
        await createSeries(input(), recurrence({ occurrences: 2 }), {}, LONDON),
      );

      await applySeriesEdit(
        result.jobIds[0]!,
        input({ notes: 'Meet at the side entrance' }),
        'future',
        {},
        LONDON,
      );

      for (const id of result.jobIds) {
        const updates = await raw!.auditLog.count({
          where: { entity: 'Job', entityId: id, action: 'update' },
        });
        expect(updates, `job ${id} has no update audit entry`).toBeGreaterThan(0);
      }
    });
  });

  describe('the series view', () => {
    it('counts a series without a query per row', async () => {
      // Spec 6.3.7. The counts come from three grouped queries whatever the
      // number of series — the shape the job list was rebuilt to avoid.
      const result = track(
        await createSeries(input(), recurrence({ occurrences: 4 }), {}, LONDON),
      );

      const all = await listSeries({ includeFinished: true });
      const mine = all.find((row) => row.id === result.seriesId);

      expect(mine).toBeTruthy();
      expect(mine!.total).toBe(4);
      expect(mine!.upcoming).toBe(4);
      expect(mine!.cancelled).toBe(0);
      expect(mine!.label).toContain('Every day');
    });

    it('lists the jobs behind a series in order', async () => {
      const result = track(
        await createSeries(input(), recurrence({ occurrences: 3 }), {}, LONDON),
      );

      const series = await getSeries(result.seriesId);
      expect(series!.jobs).toHaveLength(3);
      expect(series!.jobs.map((job) => job.seriesIndex)).toEqual([1, 2, 3]);
    });

    it('ending a series does not cancel its bookings', async () => {
      // Spec 6.3.6. Tidying up a rule must not silently cancel jobs a client
      // is expecting; cancelling them is a separate, explicit act.
      const result = track(
        await createSeries(input(), recurrence({ occurrences: 2 }), {}, LONDON),
      );

      await endSeries(result.seriesId, {});

      const series = await getSeries(result.seriesId);
      expect(series!.cancelledAt).not.toBeNull();
      expect(
        series!.jobs.every((job) => job.status !== 'CANCELLED'),
        'ending a series cancelled its jobs',
      ).toBe(true);
    });
  });

  describe('return journeys', () => {
    it('swaps the route and suggests a later time', async () => {
      // Spec 6.3.1.
      const defaults = returnDefaults(
        {
          clientId: null,
          accountId: null,
          jobType: 'TRANSFER',
          pickupText: 'The Dorchester',
          pickupPostcode: 'W1K 1QA',
          pickupLat: null,
          pickupLng: null,
          dropoffText: 'Heathrow Terminal 5',
          dropoffPostcode: 'TW6 2GA',
          dropoffLat: null,
          dropoffLng: null,
          viaText: null,
          driverId: null,
          vehicleId: null,
          passengerName: null,
          passengerPhone: null,
          passengerCount: null,
          luggageCount: null,
          clientPricePence: 12550,
          driverPricePence: 8000,
          notes: null,
          scheduledAt: new Date(`${YEAR}-09-01T09:00:00.000Z`),
          estimatedMinutes: null,
        },
        LONDON,
      );

      expect(defaults.pickupText).toBe('Heathrow Terminal 5');
      expect(defaults.dropoffText).toBe('The Dorchester');
      expect(defaults.scheduledDate).toBe(`${YEAR}-09-01`);
      expect(defaults.scheduledTime).toBe('13:00'); // 10:00 BST + 3h
    });

    it('links both legs from one column', async () => {
      // Spec 6.3.2. Stored once so the two directions cannot disagree.
      const outbound = track(
        await createSeries(input(), recurrence({ occurrences: 1 }), {}, LONDON),
      );
      const back = track(
        await createSeries(
          input({ pickupText: 'Heathrow Terminal 5', dropoffText: `Series Pickup ${stamp}` }),
          recurrence({ occurrences: 1 }),
          {},
          LONDON,
        ),
      );

      await linkReturn(outbound.jobIds[0]!, back.jobIds[0]!, {});

      const fromOutbound = await linkedLegs(outbound.jobIds[0]!);
      expect(fromOutbound.returnLeg?.id).toBe(back.jobIds[0]);
      expect(fromOutbound.outbound).toBeNull();

      const fromReturn = await linkedLegs(back.jobIds[0]!);
      expect(fromReturn.outbound?.id).toBe(outbound.jobIds[0]);
      expect(fromReturn.returnLeg).toBeNull();
    });

    it('refuses a second return for the same outbound', async () => {
      const outbound = track(
        await createSeries(input(), recurrence({ occurrences: 1 }), {}, LONDON),
      );
      const first = track(
        await createSeries(input(), recurrence({ occurrences: 1 }), {}, LONDON),
      );
      const second = track(
        await createSeries(input(), recurrence({ occurrences: 1 }), {}, LONDON),
      );

      await linkReturn(outbound.jobIds[0]!, first.jobIds[0]!, {});

      await expect(
        linkReturn(outbound.jobIds[0]!, second.jobIds[0]!, {}),
      ).rejects.toThrow(/already has a return/i);
    });

    it('refuses to link a job to itself', async () => {
      const one = track(
        await createSeries(input(), recurrence({ occurrences: 1 }), {}, LONDON),
      );
      await expect(
        linkReturn(one.jobIds[0]!, one.jobIds[0]!, {}),
      ).rejects.toThrow(/its own return/i);
    });
  });

  describe('refusals', () => {
    it('refuses a recurrence with neither an end date nor a count', async () => {
      expect(() =>
        recurrenceSchema.parse({ frequency: 'DAILY', interval: 1 }),
      ).toThrow();
    });

    it('refuses a recurrence with both', async () => {
      expect(() =>
        recurrenceSchema.parse({
          frequency: 'DAILY',
          interval: 1,
          occurrences: 3,
          endsOn: `${YEAR}-09-30`,
        }),
      ).toThrow();
    });
  });
});
