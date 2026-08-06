import type { JobStatus } from '@prisma/client';
import type { AuditContext } from './audit';
import { withAudit } from './audit';
import { describeOutcome, runBulk, type BulkOutcome } from './bulk';
import { addJobLine } from './invoice-store';
import { jobPriceSchema } from './job-price-schema';
import { checkAssignmentCompliance, transitionJob } from './jobs';
import { prisma } from './prisma';

/**
 * The four bulk actions, as plain functions — spec 6.5.2.
 *
 * Extracted from the Server Actions they used to be because those did not
 * work. The action applied its changes and then called `revalidatePath` on
 * the page it was posted from; the router aborted the in-flight action
 * response to refetch, `useActionState` never received the new state, and the
 * button sat on "Working…" for ever. The jobs really were updated, so the
 * only symptom was a form that appeared to hang — which is the failure mode
 * that gets a control clicked a second time.
 *
 * It is the same problem documented at length in
 * `app/api/jobs/[id]/status/route.ts`, and it has the same answer: a plain
 * form post to a route handler that answers with a 303. The browser performs
 * that navigation itself, before or after hydration, and there is no
 * in-flight response for a revalidation to abort.
 */

export type BulkIntent = 'price' | 'status' | 'assign' | 'invoice';

export interface BulkRequest {
  intent: BulkIntent;
  jobIds: string[];
  /** Pounds, as typed. `price` only. */
  clientPrice?: string;
  driverPrice?: string;
  /** `status` only. */
  status?: string;
  /** `assign` only. */
  driverId?: string;
  /** `invoice` only. */
  invoiceId?: string;
}

export type BulkResult =
  | { ok: true; message: string; operationId?: string }
  | { ok: false; message: string };

export async function runBulkJobs(
  request: BulkRequest,
  context: AuditContext,
): Promise<BulkResult> {
  const ids = request.jobIds.filter(Boolean);
  if (ids.length === 0) return { ok: false, message: 'Select at least one job first' };

  const outcome = await dispatchIntent(request, ids, context);
  if ('refusal' in outcome) return { ok: false, message: outcome.refusal };

  return {
    ok: true,
    message: describeOutcome(outcome.result),
    ...(outcome.result.operationId ? { operationId: outcome.result.operationId } : {}),
  };
}

async function dispatchIntent(
  request: BulkRequest,
  ids: string[],
  context: AuditContext,
): Promise<{ result: BulkOutcome } | { refusal: string }> {
  if (request.intent === 'price') {
    const parsed = jobPriceSchema.parse({
      clientPrice: request.clientPrice ?? '',
      driverPrice: request.driverPrice ?? '',
    });
    if (parsed.clientPrice === null && parsed.driverPrice === null) {
      return { refusal: 'Enter a client price, a driver price, or both' };
    }
    return { result: await runBulk('price', ids, priceWorker(parsed, context), context) };
  }

  if (request.intent === 'status') {
    const next = String(request.status ?? '') as JobStatus;
    if (!next) return { refusal: 'Choose a status' };
    return {
      result: await runBulk(
        'status',
        ids,
        async (id) => {
          const outcome = await transitionJob(id, next, context);
          return outcome.ok ? null : `${outcome.reference ?? id}: ${outcome.message}`;
        },
        context,
      ),
    };
  }

  if (request.intent === 'assign') {
    const driverId = String(request.driverId ?? '').trim();
    if (!driverId) return { refusal: 'Choose a driver' };
    return { result: await runBulk('assign', ids, assignWorker(driverId, context), context) };
  }

  const invoiceId = String(request.invoiceId ?? '').trim();
  if (!invoiceId) return { refusal: 'Choose a draft invoice' };
  return {
    result: await runBulk(
      'invoice',
      ids,
      async (id) => {
        const outcome = await addJobLine(invoiceId, id, context);
        return outcome.ok ? null : outcome.message;
      },
      context,
    ),
  };
}

/**
 * Bulk pricing exists for backfilling imported data: a CSV import can land
 * hundreds of jobs whose price was never captured, and repricing them one at
 * a time is the reason they stay unpriced.
 */
function priceWorker(
  parsed: { clientPrice: number | null; driverPrice: number | null },
  context: AuditContext,
) {
  return async (id: string) => {
    await withAudit(
      'Job',
      'update',
      async (tx) => {
        const before = await tx.job.findUniqueOrThrow({ where: { id } });
        const after = await tx.job.update({
          where: { id },
          data: {
            ...(parsed.clientPrice !== null ? { clientPricePence: parsed.clientPrice } : {}),
            ...(parsed.driverPrice !== null ? { driverPricePence: parsed.driverPrice } : {}),
          },
        });
        await tx.jobEvent.create({
          data: {
            jobId: id,
            type: 'PRICE_SET',
            actorType: 'USER',
            actorId: context.userId ?? null,
            metadata: { bulk: true, toPence: after.clientPricePence },
          },
        });
        return { entityId: id, before, after, result: null };
      },
      context,
    );
    return null;
  };
}

/**
 * Compliance is checked per job and blocks that job alone — spec 6.5.2.
 *
 * A lapsed PHV badge is a licensing requirement, so a driver who cannot take
 * Tuesday's airport run cannot take it as part of a batch either. The other
 * nine jobs are nothing to do with it and still get their driver.
 *
 * A clash only warns on the booking form (spec 6.2.3), and here it does not
 * even do that: an operator assigning one driver to forty jobs has made a
 * decision about their day, and a warning nobody can act on in bulk is one
 * they learn to dismiss.
 */
function assignWorker(driverId: string, context: AuditContext) {
  return async (id: string) => {
    const job = await prisma.job.findUnique({
      where: { id },
      select: { reference: true, status: true, vehicleId: true, scheduledAt: true },
    });
    if (!job) return `${id}: no longer exists`;

    if (['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(job.status)) {
      return `${job.reference}: already ${job.status.toLowerCase()}`;
    }

    const compliance = await checkAssignmentCompliance(
      driverId,
      job.vehicleId,
      job.scheduledAt,
    );
    if (compliance && !compliance.compliant) {
      return `${job.reference}: ${compliance.reasons.join('; ')}`;
    }

    await withAudit(
      'Job',
      'update',
      async (tx) => {
        const before = await tx.job.findUniqueOrThrow({ where: { id } });
        const after = await tx.job.update({
          where: { id },
          data: {
            driverId,
            // A DRAFT stays a draft. Anything else becomes ASSIGNED, including
            // a job that had been ACCEPTED — the new driver has not accepted
            // anything.
            status: before.status === 'DRAFT' ? 'DRAFT' : 'ASSIGNED',
          },
        });
        await tx.jobEvent.create({
          data: {
            jobId: id,
            type: 'ASSIGNED',
            actorType: 'USER',
            actorId: context.userId ?? null,
            metadata: { bulk: true, driverId },
          },
        });
        return { entityId: id, before, after, result: null };
      },
      context,
    );

    return null;
  };
}
