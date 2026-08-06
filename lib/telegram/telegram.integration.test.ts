import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyStep } from './driver-steps';
import {
  createLinkToken,
  driverForChat,
  redeemLinkToken,
  unlinkChat,
  unlinkDriver,
} from './linking';

/**
 * The driver lifecycle against a real database — spec 5's definition of done.
 *
 * What only this can prove is the two places the arithmetic meets the
 * database and could disagree with itself:
 *
 *   - a tap arriving twice, which Telegram guarantees will happen, must not
 *     move the wait clock — the gap between `ARRIVED` and `POB` is money;
 *   - a `COMPLETED` tap on an unpriced job must record the event and *not*
 *     complete the job, because the driver did finish and the money guard
 *     still has to hold.
 *
 * Nothing here talks to Telegram. The transport is injectable and tested
 * separately; this is about what ends up in Postgres.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const stamp = String(Date.now()).slice(-7);
/** Well outside anything a real chat id would be. */
const CHAT_ID = BigInt(`99${stamp}`);

describe.skipIf(!DATABASE_AVAILABLE)('telegram', () => {
  let driverId = '';
  let vehicleId = '';
  const jobIds: string[] = [];

  async function cleanup() {
    if (!raw) return;
    if (jobIds.length > 0) {
      await raw.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.jobFinance.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.driverPosition.deleteMany({ where: { jobId: { in: jobIds } } });
      await raw.job.deleteMany({ where: { id: { in: jobIds } } });
      jobIds.length = 0;
    }
  }

  /** A priced, assigned job two hours from now. */
  async function assignedJob(
    overrides: { clientPricePence?: number | null; rateCardRuleId?: string | null } = {},
  ): Promise<string> {
    if (!raw) throw new Error('no database');

    const job = await raw.job.create({
      data: {
        reference: `TGJ-${stamp}-${jobIds.length}`,
        jobType: 'AIRPORT_TRANSFER',
        status: 'ASSIGNED',
        scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        pickupText: 'The Dorchester',
        dropoffText: 'Heathrow Terminal 5',
        driverId,
        vehicleId,
        clientPricePence:
          overrides.clientPricePence === undefined ? 12_550 : overrides.clientPricePence,
        rateCardRuleId: overrides.rateCardRuleId ?? null,
      },
    });

    await raw.jobEvent.create({
      data: { jobId: job.id, type: 'ASSIGNED', actorType: 'USER' },
    });

    jobIds.push(job.id);
    return job.id;
  }

  beforeAll(async () => {
    if (!raw) return;

    const vehicle = await raw.vehicle.create({
      data: {
        registration: `TG${stamp.slice(-5)}`,
        normalisedRegistration: `TG${stamp.slice(-5)}`,
        make: 'Mercedes-Benz',
        model: 'E-Class',
        vehicleClass: 'EXECUTIVE',
        ownership: 'OWNED',
      },
    });
    vehicleId = vehicle.id;

    const driver = await raw.driver.create({
      data: {
        reference: `TG${stamp}`,
        name: `Telegram Driver ${stamp}`,
        phone: `+4477${stamp}11`,
        status: 'ACTIVE',
        assignedVehicleId: vehicleId,
      },
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    if (!raw) return;
    await cleanup();
    await raw.linkToken.deleteMany({ where: { driverId } });
    await raw.telegramUpdate.deleteMany({ where: { chatId: CHAT_ID } });
    await raw.driverPosition.deleteMany({ where: { driverId } });
    await raw.driver.deleteMany({ where: { id: driverId } });
    await raw.vehicle.deleteMany({ where: { id: vehicleId } });
    await raw.$disconnect();
  });

  describe('linking', () => {
    it('binds a chat to a driver through a one-time link', async () => {
      const issued = await createLinkToken(driverId);
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;

      const outcome = await redeemLinkToken(issued.token, CHAT_ID);
      expect(outcome.ok).toBe(true);
      expect(outcome.driverId).toBe(driverId);

      const found = await driverForChat(CHAT_ID);
      expect(found?.id).toBe(driverId);
    });

    it('refuses the same link twice', async () => {
      // A forwarded link binding a second phone would send one driver's jobs
      // and pay to the other.
      const issued = await createLinkToken(driverId);
      expect(issued.ok).toBe(false);
      if (issued.ok) return;
      expect(issued.code).toBe('ALREADY_LINKED');
    });

    it('refuses a chat already bound to somebody else', async () => {
      if (!raw) return;
      const other = await raw.driver.create({
        data: {
          reference: `TGO${stamp}`,
          name: `Other Driver ${stamp}`,
          phone: `+4477${stamp}22`,
          status: 'ACTIVE',
        },
      });

      const issued = await createLinkToken(other.id);
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;

      const outcome = await redeemLinkToken(issued.token, CHAT_ID);
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain('already linked to another driver');

      // And the token is still unspent, so a correct attempt still works.
      const token = await raw.linkToken.findUniqueOrThrow({
        where: { token: issued.token },
      });
      expect(token.usedAt).toBeNull();

      await raw.linkToken.deleteMany({ where: { driverId: other.id } });
      await raw.driver.delete({ where: { id: other.id } });
    });

    it('refuses an expired link and says what to do', async () => {
      if (!raw) return;
      await unlinkDriver(driverId);

      const issued = await createLinkToken(driverId);
      if (!issued.ok) throw new Error(issued.message);

      await raw.linkToken.update({
        where: { token: issued.token },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const outcome = await redeemLinkToken(issued.token, CHAT_ID);
      expect(outcome.ok).toBe(false);
      // A complete instruction, not a diagnosis.
      expect(outcome.message).toContain('new one');
    });

    it('unlinks, and stops recognising the chat', async () => {
      const issued = await createLinkToken(driverId);
      if (!issued.ok) throw new Error(issued.message);
      await redeemLinkToken(issued.token, CHAT_ID);

      const outcome = await unlinkChat(CHAT_ID);
      expect(outcome.ok).toBe(true);
      expect(await driverForChat(CHAT_ID)).toBeNull();

      // Relinked for the tests that follow.
      const again = await createLinkToken(driverId);
      if (!again.ok) throw new Error(again.message);
      await redeemLinkToken(again.token, CHAT_ID);
    });
  });

  describe('status taps', () => {
    it('walks a job from on-my-way to completed', async () => {
      const jobId = await assignedJob();

      for (const step of ['ON_WAY', 'ARRIVED', 'POB', 'COMPLETED'] as const) {
        const outcome = await applyStep(jobId, step, driverId);
        expect(outcome.refused, `${step} was refused: ${outcome.message}`).toBe(false);
      }

      const job = await raw!.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe('COMPLETED');

      const events = await raw!.jobEvent.findMany({ where: { jobId } });
      const types = events.map((event) => event.type);
      for (const step of ['ON_WAY', 'ARRIVED', 'POB', 'COMPLETED']) {
        expect(types).toContain(step);
      }
    });

    it('refuses a skipped step and says which one is missing', async () => {
      const jobId = await assignedJob();
      await applyStep(jobId, 'ON_WAY', driverId);

      // Straight to POB, skipping Arrived — which is the tap that starts the
      // wait clock, so this is the skip that costs money.
      const outcome = await applyStep(jobId, 'POB', driverId);
      expect(outcome.refused).toBe(true);
      expect(outcome.message).toContain('Arrived');

      // And wrote nothing.
      expect(await raw!.jobEvent.count({ where: { jobId, type: 'POB' } })).toBe(0);
    });

    it('takes a repeated tap as a no-op, because Telegram redelivers', async () => {
      // The one that matters most: a second ARRIVED must not move the clock,
      // because the gap to POB is money.
      const jobId = await assignedJob();

      await applyStep(jobId, 'ON_WAY', driverId);
      const first = await applyStep(jobId, 'ARRIVED', driverId, {
        at: new Date(Date.now() - 60 * 60 * 1000),
      });
      expect(first.refused).toBe(false);

      const again = await applyStep(jobId, 'ARRIVED', driverId, { at: new Date() });
      expect(again.refused).toBe(false);
      expect(again.message).toContain('Already recorded');

      expect(await raw!.jobEvent.count({ where: { jobId, type: 'ARRIVED' } })).toBe(1);
    });

    it('refuses a tap from a driver the job no longer belongs to', async () => {
      const jobId = await assignedJob();
      await raw!.job.update({ where: { id: jobId }, data: { driverId: null } });

      const outcome = await applyStep(jobId, 'ON_WAY', driverId);
      expect(outcome.refused).toBe(true);
      expect(outcome.message).toContain('no longer yours');
    });
  });

  describe('wait time', () => {
    it('bills the minutes past the allowance when the passenger boards', async () => {
      if (!raw) return;

      // A rule of its own, so the figures do not depend on the seed.
      const card = await raw.rateCard.findFirstOrThrow({ where: { isDefault: true } });
      const rule = await raw.rateCardRule.create({
        data: {
          rateCardId: card.id,
          jobType: 'AIRPORT_TRANSFER',
          freeWaitMinutes: 45,
          waitPerMinutePence: 50,
        },
      });

      const jobId = await assignedJob({ rateCardRuleId: rule.id });

      await applyStep(jobId, 'ON_WAY', driverId);
      await applyStep(jobId, 'ARRIVED', driverId, {
        at: new Date(Date.now() - 70 * 60 * 1000),
      });
      const pob = await applyStep(jobId, 'POB', driverId, { at: new Date() });

      // 70 waited, 45 free, 25 billable at 50p.
      expect(pob.wait?.billableMinutes).toBe(25);
      expect(pob.wait?.pence).toBe(1250);
      // Spec 5.5.6 — the driver is told, so a wait they know was longer gets
      // queried the same day rather than never.
      expect(pob.message).toContain('70 min');

      const finance = await raw.jobFinance.findUniqueOrThrow({ where: { jobId } });
      expect(finance.waitTimePence).toBe(1250);
      expect(finance.waitMinutesBilled).toBe(25);
      expect(finance.waitAutoCalculatedAt).not.toBeNull();

      await raw.rateCardRule.delete({ where: { id: rule.id } });
    });

    it('leaves an accountant’s override alone', async () => {
      if (!raw) return;
      // Spec 5.5.4. Their reason for changing it beats the arithmetic.
      const jobId = await assignedJob();

      await raw.jobFinance.create({
        data: {
          jobId,
          waitTimePence: 9999,
          waitMinutesBilled: 99,
          waitOverriddenById: 'someone',
          waitOverriddenAt: new Date(),
          waitOverrideReason: 'Client disputed it',
        },
      });

      await applyStep(jobId, 'ON_WAY', driverId);
      await applyStep(jobId, 'ARRIVED', driverId, {
        at: new Date(Date.now() - 70 * 60 * 1000),
      });
      await applyStep(jobId, 'POB', driverId);

      const finance = await raw.jobFinance.findUniqueOrThrow({ where: { jobId } });
      expect(finance.waitTimePence).toBe(9999);
    });

    it('writes nothing when the driver never tapped Arrived', async () => {
      // A missing tap is an unknown wait, not a zero one — and a zero would
      // bill nothing for a two-hour wait with nobody the wiser.
      const jobId = await assignedJob();

      await applyStep(jobId, 'ON_WAY', driverId);
      // Straight to POB is refused, so the wait is simply never calculated.
      const outcome = await applyStep(jobId, 'POB', driverId);
      expect(outcome.refused).toBe(true);

      expect(await raw!.jobFinance.findUnique({ where: { jobId } })).toBeNull();
    });
  });

  describe('completing an unpriced job', () => {
    it('records the tap but refuses to complete, and tells ops', async () => {
      // The decision documented at the top of `driver-steps.ts`: the driver
      // did finish, and the money guard still holds. Neither rule bends.
      const jobId = await assignedJob({ clientPricePence: null });

      await applyStep(jobId, 'ON_WAY', driverId);
      await applyStep(jobId, 'ARRIVED', driverId);
      await applyStep(jobId, 'POB', driverId);
      const outcome = await applyStep(jobId, 'COMPLETED', driverId);

      // Not refused — the driver is not blocked from reporting reality.
      expect(outcome.refused).toBe(false);
      expect(outcome.message).toContain('office');
      expect(outcome.opsAlert).toBeTruthy();

      const job = await raw!.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe('IN_PROGRESS');

      // The event stands regardless.
      expect(
        await raw!.jobEvent.count({ where: { jobId, type: 'COMPLETED' } }),
      ).toBe(1);
    });
  });
});
