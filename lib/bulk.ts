import { after } from 'next/server';
import type { AuditContext } from './audit';
import { prisma } from './prisma';

/**
 * Running one action over many jobs — spec 6.5.3, 6.5.4 and 6.5.5.
 *
 * Three rules, and they are the whole module.
 *
 * **One job at a time, through the ordinary path.** Never an `updateMany`. A
 * bulk status change has to validate each job on its own — one job missing a
 * price must not stop the other nine moving — and each has to leave its own
 * audit entry (6.5.5). A single audit row saying "400 jobs changed" answers
 * none of the questions anybody asks afterwards.
 *
 * **A failure does not stop the batch.** It is recorded by reference and the
 * run continues, because the operator selected all of them deliberately and
 * nine successes plus a named failure is more useful than a rollback.
 *
 * **Past a threshold it runs behind the response** (6.5.4). Applying a change
 * to four hundred jobs takes longer than a serverless request is allowed to
 * live, and being cut off half way through leaves somebody with no idea which
 * half. `after()` runs the work once the response has been sent; progress
 * lands in `BulkOperation` and the client polls it.
 */

/** Above this, the work moves behind the response — spec 6.5.4. */
export const BACKGROUND_THRESHOLD = 50;

export interface BulkOutcome {
  /** Set when the batch ran behind the response and is still going. */
  operationId?: string;
  succeeded: number;
  failed: number;
  /** One line per refusal, by job reference. */
  failures: string[];
}

/**
 * What to do to one job.
 *
 * Returns a reason to record a refusal, or null on success. Throwing is
 * treated as a refusal too — a worker that throws should not take the rest of
 * the batch down.
 */
export type BulkWorker = (jobId: string) => Promise<string | null>;

export async function runBulk(
  kind: string,
  ids: string[],
  worker: BulkWorker,
  context: AuditContext,
): Promise<BulkOutcome> {
  if (ids.length <= BACKGROUND_THRESHOLD) {
    return applyAll(ids, worker);
  }

  const operation = await prisma.bulkOperation.create({
    data: {
      kind,
      total: ids.length,
      createdById: context.userId ?? null,
    },
  });

  // After the response, not during it. The operator gets an immediate answer
  // with something to watch rather than a request that may be killed.
  after(async () => {
    try {
      const outcome = await applyAll(ids, worker, operation.id);
      await prisma.bulkOperation.update({
        where: { id: operation.id },
        data: {
          status: 'DONE',
          succeeded: outcome.succeeded,
          failed: outcome.failed,
          failures: outcome.failures,
          finishedAt: new Date(),
        },
      });
    } catch (error) {
      // Only reached if something outside the per-job try/catch fails — a
      // lost connection, say. Recorded rather than swallowed, so the screen
      // stops saying "running" forever.
      await prisma.bulkOperation.update({
        where: { id: operation.id },
        data: {
          status: 'FAILED',
          failures: [error instanceof Error ? error.message : 'Unknown failure'],
          finishedAt: new Date(),
        },
      });
    }
  });

  return { operationId: operation.id, succeeded: 0, failed: 0, failures: [] };
}

/** How often progress is written back while a background batch runs. */
const PROGRESS_EVERY = 10;

async function applyAll(
  ids: string[],
  worker: BulkWorker,
  operationId?: string,
): Promise<BulkOutcome> {
  const failures: string[] = [];
  let succeeded = 0;

  for (const [index, id] of ids.entries()) {
    try {
      const refusal = await worker(id);
      if (refusal === null) succeeded += 1;
      else failures.push(refusal);
    } catch (error) {
      failures.push(
        `${id}: ${error instanceof Error ? error.message : 'Could not be changed'}`,
      );
    }

    // Every tenth rather than every job. The progress bar does not need to be
    // exact, and a write per job would double the cost of the batch.
    if (operationId && (index + 1) % PROGRESS_EVERY === 0) {
      await prisma.bulkOperation.update({
        where: { id: operationId },
        data: { succeeded, failed: failures.length, failures },
      });
    }
  }

  return { succeeded, failed: failures.length, failures };
}

export async function getBulkOperation(id: string) {
  return prisma.bulkOperation.findUnique({ where: { id } });
}

/**
 * A sentence somebody can act on.
 *
 * Failures are named, never counted. "Twelve refused" tells an operator there
 * is a problem without telling them where it is, which is the same as not
 * telling them.
 */
export function describeOutcome(outcome: BulkOutcome, noun = 'job'): string {
  if (outcome.operationId) {
    return `Working through them in the background — this page will keep you posted.`;
  }

  const done = `${outcome.succeeded} ${noun}${outcome.succeeded === 1 ? '' : 's'} updated`;
  if (outcome.failures.length === 0) return `${done}.`;

  return `${done}. ${outcome.failures.length} refused — ${outcome.failures.join(' | ')}`;
}
