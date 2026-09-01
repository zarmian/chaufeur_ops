import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { rawPrismaClient } from '../raw-prisma';
import { saveFlightConfig } from './store';
import { trackFlights } from './track';
import type { FlightProvider, FlightReport, FlightState } from './types';

/**
 * The tracker against real rows, with the provider stubbed.
 *
 * The stub is where the honesty lives: everything in `track.ts` except one
 * HTTP call can be proven against a real database, and is. What no test here
 * can prove is whether AeroDataBox's payload really looks the way
 * `aerodatabox.ts` believes — that needs a key and one live call, and this
 * install has neither.
 *
 * So these cover the parts that would go wrong quietly: that one flight is
 * asked about once however many cars are meeting it, that a provider outage
 * leaves the last known answer standing rather than pretending the flight is
 * on time, and above all that a booking is not rewritten unless an install
 * has asked for that.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? rawPrismaClient(process.env.TEST_DATABASE_URL)
  : null;

const stamp = String(Date.now()).slice(-7);

/** Well clear of now, so nothing here depends on when the suite runs. */
const SCHEDULED_ARRIVAL = new Date(Date.now() + 20 * 3_600_000);
const PICKUP = new Date(SCHEDULED_ARRIVAL.getTime() + 40 * 60_000);

function report(over: Partial<FlightReport> = {}): FlightReport {
  return {
    flightNumber: 'BA117',
    state: 'ACTIVE' as FlightState,
    scheduledArrival: SCHEDULED_ARRIVAL,
    estimatedArrival: null,
    actualArrival: null,
    origin: 'JFK',
    destination: 'LHR',
    terminal: '5',
    ...over,
  };
}

/** A provider that answers from memory and counts how often it was asked. */
function stubProvider(answers: FlightReport | null) {
  const asked: string[] = [];
  const lookup = vi.fn(async (_config, flightNumber: string) => {
    asked.push(flightNumber);
    return { ok: true as const, value: answers };
  }) as unknown as FlightProvider['lookup'];
  return { provider: { name: 'aerodatabox' as const, lookup }, asked, lookup };
}

describe.skipIf(!DATABASE_AVAILABLE)(
  'tracking the flights that are coming up',
  () => {
    const jobIds: string[] = [];
    let made = 0;

    beforeAll(async () => {
      if (!raw) return;
      // Lazily read by `secret-store`, so setting it here is enough. CI does
      // not configure one, and without it the config could not hold a key.
      process.env.SETTINGS_ENCRYPTION_KEY ||= `test-key-${stamp}`;
    });

    afterEach(async () => {
      if (!raw) return;
      await raw.auditLog.deleteMany({ where: { entityId: { in: jobIds } } });
      await raw.job.deleteMany({ where: { id: { in: jobIds } } });
      await raw.flightStatus.deleteMany({
        where: { flightNumber: { in: ['BA117', 'BA118'] } },
      });
      jobIds.length = 0;
    });

    afterAll(async () => {
      if (!raw) return;
      await raw.setting.deleteMany({ where: { key: 'flights' } });
      await raw.$disconnect();
    });

    async function configure(over: Record<string, unknown> = {}) {
      const result = await saveFlightConfig(
        {
          enabled: true,
          autoAdjust: false,
          lookAheadHours: 36,
          refreshMinutes: 20,
          minShiftMinutes: 15,
          minNoticeMinutes: 90,
          apiKey: 'test-key',
          ...over,
        } as Parameters<typeof saveFlightConfig>[0],
        { userId: null, ip: null },
      );
      if (!result.ok) throw new Error(result.message);
    }

    async function makeJob(
      over: Record<string, unknown> = {},
    ): Promise<string> {
      made += 1;
      const job = await raw!.job.create({
        data: {
          reference: `FL-${stamp}-${made}`,
          jobType: 'AIRPORT_TRANSFER',
          status: 'ASSIGNED',
          scheduledAt: PICKUP,
          pickupText: 'Heathrow Terminal 5',
          dropoffText: 'The Dorchester',
          clientPricePence: 14_500,
          driverPricePence: 9_000,
          flightNumber: 'BA 117',
          ...over,
        },
      });
      jobIds.push(job.id);
      return job.id;
    }

    it('does nothing at all when no provider is configured', async () => {
      // Tracking is optional throughout. An install with no key must behave
      // exactly as it did before any of this existed.
      await raw!.setting.deleteMany({ where: { key: 'flights' } });
      await makeJob();

      const stub = stubProvider(report());
      const summary = await trackFlights({ provider: stub.provider });

      expect(summary.checked).toBe(0);
      expect(stub.lookup).not.toHaveBeenCalled();
    });

    it('asks about one flight once, however many cars are meeting it', async () => {
      // A family in two cars, or two clients off the same New York service.
      // Three lookups would be billed three times for one answer.
      await configure();
      await makeJob();
      await makeJob({ scheduledAt: new Date(PICKUP.getTime() + 5 * 60_000) });
      await makeJob({ flightNumber: 'ba117' });

      const stub = stubProvider(report());
      const summary = await trackFlights({ provider: stub.provider });

      expect(summary.checked).toBe(3);
      expect(summary.lookups).toBe(1);
      // Normalised on the way out: `ba117` and `BA 117` are one aeroplane.
      expect(stub.asked).toEqual(['BA117']);
    });

    it('records the answer and links it to the job', async () => {
      await configure();
      const jobId = await makeJob();

      await trackFlights({ provider: stubProvider(report()).provider });

      const job = await raw!.job.findUniqueOrThrow({
        where: { id: jobId },
        select: { flightStatusId: true },
      });
      expect(job.flightStatusId).not.toBeNull();

      const status = await raw!.flightStatus.findFirstOrThrow({
        where: { flightNumber: 'BA117' },
      });
      expect(status.state).toBe('ACTIVE');
      expect(status.terminal).toBe('5');
    });

    it('flags a delay without touching the booking, by default', async () => {
      /*
       * The setting an install starts on. Everything happens — the flight is
       * checked, the delay is known, the office is told — and only the
       * rewriting of somebody's booking waits for a person.
       */
      await configure({ autoAdjust: false });
      const jobId = await makeJob();

      const summary = await trackFlights({
        provider: stubProvider(
          report({
            estimatedArrival: new Date(
              SCHEDULED_ARRIVAL.getTime() + 90 * 60_000,
            ),
          }),
        ).provider,
      });

      expect(summary.flagged).toBe(1);
      expect(summary.shifted).toBe(0);
      expect(summary.outcomes[0]?.explanation).toContain(
        '1 hour 30 minutes late',
      );

      const job = await raw!.job.findUniqueOrThrow({
        where: { id: jobId },
        select: { scheduledAt: true, flightAdjustedAt: true },
      });
      expect(job.scheduledAt.getTime()).toBe(PICKUP.getTime());
      expect(job.flightAdjustedAt).toBeNull();
    });

    it('moves the pickup once an install has asked it to', async () => {
      await configure({ autoAdjust: true });
      const jobId = await makeJob();

      const summary = await trackFlights({
        provider: stubProvider(
          report({
            estimatedArrival: new Date(
              SCHEDULED_ARRIVAL.getTime() + 90 * 60_000,
            ),
          }),
        ).provider,
      });

      expect(summary.shifted).toBe(1);

      const job = await raw!.job.findUniqueOrThrow({
        where: { id: jobId },
        select: {
          scheduledAt: true,
          flightPickupBaseAt: true,
          flightAdjustedAt: true,
        },
      });

      // The 40-minute buffer somebody typed, preserved against the new arrival.
      expect(job.scheduledAt.getTime()).toBe(PICKUP.getTime() + 90 * 60_000);
      expect(job.flightPickupBaseAt?.getTime()).toBe(PICKUP.getTime());
      expect(job.flightAdjustedAt).not.toBeNull();
    });

    it('records the move as made by nobody', async () => {
      /*
       * A null user in the audit log, deliberately. Attributing it to whichever
       * account happened to be handy is how an operator gets asked why they
       * changed a booking they never touched.
       */
      await configure({ autoAdjust: true });
      const jobId = await makeJob();

      await trackFlights({
        provider: stubProvider(
          report({
            estimatedArrival: new Date(
              SCHEDULED_ARRIVAL.getTime() + 90 * 60_000,
            ),
          }),
        ).provider,
      });

      const entry = await raw!.auditLog.findFirstOrThrow({
        where: { entity: 'Job', entityId: jobId },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry.userId).toBeNull();
      expect(entry.action).toBe('update');
    });

    it('does not compound its own adjustments', async () => {
      /*
       * The second delay is measured from where a *person* put the pickup, not
       * from where the first adjustment left it. Measuring from its own last
       * move would walk the car steadily away from the aeroplane.
       */
      await configure({ autoAdjust: true });
      const jobId = await makeJob();

      await trackFlights({
        provider: stubProvider(
          report({
            estimatedArrival: new Date(
              SCHEDULED_ARRIVAL.getTime() + 60 * 60_000,
            ),
          }),
        ).provider,
      });
      // A fresh look, because the first answer is now cached.
      await raw!.flightStatus.deleteMany({ where: { flightNumber: 'BA117' } });
      await trackFlights({
        provider: stubProvider(
          report({
            estimatedArrival: new Date(
              SCHEDULED_ARRIVAL.getTime() + 120 * 60_000,
            ),
          }),
        ).provider,
      });

      const job = await raw!.job.findUniqueOrThrow({
        where: { id: jobId },
        select: { scheduledAt: true },
      });

      // Two hours after the original pickup, not three.
      expect(job.scheduledAt.getTime()).toBe(PICKUP.getTime() + 120 * 60_000);
    });

    it('never moves a pickup for a cancelled flight, even set to adjust', async () => {
      // A cancellation is not a delay, and rewriting the booking would hide it.
      await configure({ autoAdjust: true });
      const jobId = await makeJob();

      const summary = await trackFlights({
        provider: stubProvider(report({ state: 'CANCELLED' })).provider,
      });

      expect(summary.shifted).toBe(0);
      expect(summary.flagged).toBe(1);
      expect(summary.outcomes[0]?.flag).toBe('CANCELLED');

      const job = await raw!.job.findUniqueOrThrow({
        where: { id: jobId },
        select: { scheduledAt: true },
      });
      expect(job.scheduledAt.getTime()).toBe(PICKUP.getTime());
    });

    it('leaves a completed job alone', async () => {
      // Its driver has already been and gone. Moving the pickup time would be
      // rewriting history, and it feeds the wait-time calculation.
      await configure({ autoAdjust: true });
      const jobId = await makeJob({ status: 'COMPLETED' });

      const summary = await trackFlights({
        provider: stubProvider(
          report({
            estimatedArrival: new Date(
              SCHEDULED_ARRIVAL.getTime() + 90 * 60_000,
            ),
          }),
        ).provider,
      });

      expect(summary.checked).toBe(0);

      const job = await raw!.job.findUniqueOrThrow({
        where: { id: jobId },
        select: { scheduledAt: true },
      });
      expect(job.scheduledAt.getTime()).toBe(PICKUP.getTime());
    });

    it('keeps the last known answer when the provider is unreachable', async () => {
      /*
       * A delay found an hour ago is still truer than pretending the flight is
       * on time. Losing it on an outage would move a pickup back to where it
       * was, and tell the driver so.
       */
      await configure();
      await makeJob();

      await trackFlights({
        provider: stubProvider(
          report({
            estimatedArrival: new Date(
              SCHEDULED_ARRIVAL.getTime() + 90 * 60_000,
            ),
          }),
        ).provider,
      });

      const dead: FlightProvider = {
        name: 'aerodatabox',
        lookup: async () => ({
          ok: false,
          code: 'UNREACHABLE',
          message: 'gone',
        }),
      };
      // Old enough that a refresh is due, so the failing call really happens.
      await raw!.flightStatus.updateMany({
        where: { flightNumber: 'BA117' },
        data: { checkedAt: new Date(Date.now() - 3 * 3_600_000) },
      });

      const summary = await trackFlights({ provider: dead });

      expect(summary.errors).toHaveLength(1);
      expect(summary.outcomes[0]?.explanation).toContain('late');

      const status = await raw!.flightStatus.findFirstOrThrow({
        where: { flightNumber: 'BA117' },
      });
      expect(status.estimatedArrival?.getTime()).toBe(
        SCHEDULED_ARRIVAL.getTime() + 90 * 60_000,
      );
    });

    it('does not ask again about a flight it checked a moment ago', async () => {
      await configure();
      await makeJob();

      await trackFlights({ provider: stubProvider(report()).provider });
      const second = stubProvider(report());
      const summary = await trackFlights({ provider: second.provider });

      expect(summary.lookups).toBe(0);
      expect(second.lookup).not.toHaveBeenCalled();
    });

    it('remembers that a flight number found nothing', async () => {
      // Otherwise a mistyped number is asked about, and billed for, on every
      // run for as long as the job exists.
      await configure();
      await makeJob();

      const stub = stubProvider(null);
      await trackFlights({ provider: stub.provider });

      const status = await raw!.flightStatus.findFirstOrThrow({
        where: { flightNumber: 'BA117' },
      });
      expect(status.state).toBe('UNKNOWN');

      const second = stubProvider(null);
      await trackFlights({ provider: second.provider });
      expect(second.lookup).not.toHaveBeenCalled();
    });
  },
);
