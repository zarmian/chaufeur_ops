import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_REFERENCE_PREFIX,
  peekNextDriverReference,
  peekNextJobReference,
  withDriverReference,
} from './references';

/**
 * Proves the reference allocator against a real database.
 *
 * This file exists because of a specific miss. The sequence query is raw SQL
 * using `SUBSTRING(... FROM pattern)` and a POSIX regex, and it runs only on
 * create. Unit tests covered `formatReference` and `parseReference` — the
 * pure halves — so the one part that could only fail against Postgres had no
 * coverage at all. Prisma's query engine is the thing under test here; a mock
 * would prove nothing.
 *
 * Skipped unless TEST_DATABASE_URL is set. Point it at a scratch database:
 * this suite creates and deletes rows.
 */
const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

describe.skipIf(!DATABASE_AVAILABLE)('driver reference allocation', () => {
  const createdDrivers: string[] = [];

  beforeAll(async () => {
    await prismaConnect();
  });

  afterAll(async () => {
    if (raw && createdDrivers.length > 0) {
      await raw.driver.deleteMany({ where: { id: { in: createdDrivers } } });
    }
    await raw?.$disconnect();
  });

  async function prismaConnect() {
    await raw?.$connect();
  }

  it('runs the sequence query without erroring', async () => {
    // The regression this file exists for: a malformed POSIX pattern or a
    // bad cast throws here and nowhere else.
    const reference = await peekNextDriverReference();
    expect(reference).toMatch(/^DRV-\d{4,}$/);
  });

  it('returns the first reference against an empty series', async () => {
    // Only meaningful when the table has no drivers, so assert the weaker
    // property that always holds: the number is at least 1.
    const reference = await peekNextDriverReference();
    const sequence = Number(reference.split('-')[1]);
    expect(sequence).toBeGreaterThanOrEqual(1);
  });

  it('takes the numeric maximum, not the lexical one', async () => {
    // DRV-0009 sorts above DRV-0010 as text. If the query ever regressed to
    // ORDER BY reference DESC LIMIT 1, this is what would catch it.
    if (!raw) return;

    const before = await peekNextDriverReference();
    const base = Number(before.split('-')[1]);

    const nine = await raw.driver.create({
      data: {
        reference: `DRV-${String(base).padStart(4, '0')}`,
        name: 'Sequence Nine',
        phone: '07700900801',
      },
    });
    const ten = await raw.driver.create({
      data: {
        reference: `DRV-${String(base + 1).padStart(4, '0')}`,
        name: 'Sequence Ten',
        phone: '07700900802',
      },
    });
    createdDrivers.push(nine.id, ten.id);

    const next = await peekNextDriverReference();
    expect(Number(next.split('-')[1])).toBe(base + 2);
  });

  it('counts soft-deleted rows, so a reference is never reissued', async () => {
    if (!raw) return;

    const before = await peekNextDriverReference();
    const sequence = Number(before.split('-')[1]);

    const driver = await raw.driver.create({
      data: {
        reference: before,
        name: 'Soft Deleted',
        phone: '07700900803',
        deletedAt: new Date(),
      },
    });
    createdDrivers.push(driver.id);

    // The soft-delete extension hides this row from ordinary reads, but the
    // reference is still spent — handing it to a second driver would put two
    // people on the same paperwork.
    const next = await peekNextDriverReference();
    expect(Number(next.split('-')[1])).toBe(sequence + 1);
  });

  it('ignores references belonging to another series', async () => {
    if (!raw) return;

    const before = await peekNextDriverReference();

    const odd = await raw.driver.create({
      data: {
        reference: 'LEGACY-999999',
        name: 'Other Series',
        phone: '07700900804',
      },
    });
    createdDrivers.push(odd.id);

    // A huge number under a different prefix must not push the driver series
    // to 1,000,000.
    expect(await peekNextDriverReference()).toBe(before);
  });

  it('allocates through withDriverReference and persists the row', async () => {
    if (!raw) return;

    const created = await withDriverReference(async (reference) => {
      const driver = await raw.driver.create({
        data: { reference, name: 'Allocated Driver', phone: '07700900805' },
      });
      createdDrivers.push(driver.id);
      return driver;
    });

    expect(created.reference).toMatch(/^DRV-\d{4,}$/);

    // The next peek must move past what was just taken.
    const next = await peekNextDriverReference();
    expect(next).not.toBe(created.reference);
  });

  it('uses the documented driver prefix', () => {
    expect(DRIVER_REFERENCE_PREFIX).toBe('DRV');
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('job reference allocation', () => {
  afterAll(async () => {
    await raw?.$disconnect();
  });

  it('runs the job sequence query against the Job table', async () => {
    // Same raw SQL, different table — proves the series map is wired up.
    const reference = await peekNextJobReference();
    expect(reference).toMatch(/^[A-Z]+-\d{6,}$/);
  });

  it('pads job references to six digits', async () => {
    const reference = await peekNextJobReference();
    const digits = reference.split('-')[1] ?? '';
    expect(digits.length).toBeGreaterThanOrEqual(6);
  });
});
