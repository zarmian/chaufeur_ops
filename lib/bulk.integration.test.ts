import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Bulk operations — spec 6.5.3, 6.5.4 and 6.5.5.
 *
 * `after()` is a Next.js request-scoped API and there is no request here, so
 * it is stubbed. The stub keeps the promise rather than dropping it: `after`
 * deliberately returns before the work is done, which is the whole point of
 * it, and a test that read the progress row straight afterwards would be
 * racing the thing it is measuring. `settleAfter()` waits for the work the
 * way a second HTTP request would arrive after it.
 */
const deferred = vi.hoisted(() => ({ pending: [] as Array<Promise<unknown>> }));

vi.mock('next/server', () => ({
  after: (callback: () => void | Promise<void>) => {
    deferred.pending.push(Promise.resolve().then(callback));
  },
}));

async function settleAfter(): Promise<void> {
  await Promise.all(deferred.pending);
  deferred.pending.length = 0;
}

const { BACKGROUND_THRESHOLD, describeOutcome, getBulkOperation, runBulk } =
  await import('./bulk');

const DATABASE_AVAILABLE = Boolean(process.env.TEST_DATABASE_URL);

const raw = DATABASE_AVAILABLE
  ? new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    })
  : null;

const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => `job-${index}`);

describe.skipIf(!DATABASE_AVAILABLE)('runBulk', () => {
  const operationIds: string[] = [];

  afterAll(async () => {
    if (!raw) return;
    await raw.bulkOperation.deleteMany({ where: { id: { in: operationIds } } });
    await raw.$disconnect();
  });

  it('runs a small batch inline, with no operation row', async () => {
    // Below the threshold the operator gets the answer immediately, and
    // nothing is written to a table whose only purpose is progress.
    const seen: string[] = [];
    const outcome = await runBulk(
      'test',
      ids(5),
      async (id) => {
        seen.push(id);
        return null;
      },
      {},
    );

    expect(outcome.operationId).toBeUndefined();
    expect(outcome.succeeded).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it('keeps going after a refusal and names it', async () => {
    // Spec 6.5.3. The operator selected all of them deliberately; nine
    // successes plus a named failure beats a rollback.
    const outcome = await runBulk(
      'test',
      ids(4),
      async (id) => (id === 'job-1' ? `${id}: no price` : null),
      {},
    );

    expect(outcome.succeeded).toBe(3);
    expect(outcome.failed).toBe(1);
    expect(outcome.failures).toEqual(['job-1: no price']);
  });

  it('treats a thrown worker as one refusal, not a dead batch', async () => {
    const outcome = await runBulk(
      'test',
      ids(3),
      async (id) => {
        if (id === 'job-0') throw new Error('database said no');
        return null;
      },
      {},
    );

    expect(outcome.succeeded).toBe(2);
    expect(outcome.failures[0]).toContain('database said no');
  });

  it('moves a large batch behind the response and records it', async () => {
    // Spec 6.5.4. Applying a change to hundreds of jobs takes longer than a
    // serverless request is allowed to live.
    const count = BACKGROUND_THRESHOLD + 5;
    const outcome = await runBulk('test', ids(count), async () => null, {});

    expect(outcome.operationId).toBeTruthy();
    operationIds.push(outcome.operationId!);

    await settleAfter();
    const operation = await getBulkOperation(outcome.operationId!);
    expect(operation).toBeTruthy();
    expect(operation!.total).toBe(count);
    expect(operation!.status).toBe('DONE');
    expect(operation!.succeeded).toBe(count);
    expect(operation!.finishedAt).not.toBeNull();
  });

  it('records which jobs a background batch refused', async () => {
    const count = BACKGROUND_THRESHOLD + 3;
    const outcome = await runBulk(
      'test',
      ids(count),
      async (id) => (id === 'job-2' ? `${id}: already invoiced` : null),
      {},
    );

    operationIds.push(outcome.operationId!);

    await settleAfter();
    const operation = await getBulkOperation(outcome.operationId!);

    expect(operation!.failed).toBe(1);
    expect(operation!.failures).toEqual(['job-2: already invoiced']);
    expect(operation!.succeeded).toBe(count - 1);
  });

  it('does not run a batch inside a transaction that one failure could roll back', async () => {
    // Each job is its own unit. A refusal half way must leave the successes
    // before it committed — this is the behaviour the whole module exists
    // for, and an `updateMany` or a wrapping transaction would break it.
    let applied = 0;
    const outcome = await runBulk(
      'test',
      ids(6),
      async (id) => {
        if (id === 'job-3') throw new Error('stop');
        applied += 1;
        return null;
      },
      {},
    );

    expect(applied).toBe(5);
    expect(outcome.succeeded).toBe(5);
    await settleAfter();
  });
});

describe('describeOutcome', () => {
  it('says what happened, naming refusals', () => {
    expect(
      describeOutcome({ succeeded: 9, failed: 1, failures: ['WLX-1: no price'] }),
    ).toBe('9 jobs updated. 1 refused — WLX-1: no price');
  });

  it('does not pluralise one', () => {
    expect(describeOutcome({ succeeded: 1, failed: 0, failures: [] })).toBe(
      '1 job updated.',
    );
  });

  it('says a background batch is still going rather than claiming zero', () => {
    // "0 jobs updated" on a batch that has only just started is worse than
    // no message: it reads as a failure.
    expect(
      describeOutcome({ operationId: 'op_1', succeeded: 0, failed: 0, failures: [] }),
    ).toMatch(/background/i);
  });
});
