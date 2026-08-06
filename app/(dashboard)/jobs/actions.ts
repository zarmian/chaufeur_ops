'use server';

import type { JobStatus } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { financeSchema, toFinanceData } from '@/lib/job-finance';
import { jobPriceSchema } from '@/lib/job-price-schema';
import { createJob, jobSchema, transitionJob, updateJob } from '@/lib/jobs';
import { withAudit } from '@/lib/audit';
import { describeOutcome, runBulk } from '@/lib/bulk';
import { checkAssignmentCompliance } from '@/lib/jobs';
import { addJobLine } from '@/lib/invoice-store';
import { getLocaleConfig } from '@/lib/locale-store';
import { prisma } from '@/lib/prisma';
import { actingUser } from '@/lib/request-context';
import {
  applySeriesEdit,
  createSeries,
  linkReturn,
  recurrenceSchema,
  type SeriesScope,
} from '@/lib/series';

/**
 * Zip the parallel stop arrays back into records.
 *
 * A repeating fieldset posts `stopAddress` three times rather than
 * `stops[0].address`, so the columns come back separately and are recombined
 * by position here. Rows with no address are dropped: an empty row is a stop
 * someone started adding and thought better of.
 */
function readStops(formData: FormData) {
  const addresses = formData.getAll('stopAddress').map(String);
  const waits = formData.getAll('stopWait').map(String);
  const charges = formData.getAll('stopCharge').map(String);
  const notes = formData.getAll('stopNote').map(String);

  return addresses
    .map((address, index) => ({
      address,
      waitMinutes: waits[index] ?? '',
      chargePence: charges[index] ?? '',
      note: notes[index] ?? '',
    }))
    .filter((stop) => stop.address.trim() !== '');
}

function readJobForm(formData: FormData) {
  return {
    clientId: formData.get('clientId') ?? '',
    accountId: formData.get('accountId') ?? '',
    jobType: formData.get('jobType') ?? 'TRANSFER',
    scheduledDate: formData.get('scheduledDate') ?? '',
    scheduledTime: formData.get('scheduledTime') ?? '',
    pickupText: formData.get('pickupText') ?? '',
    dropoffText: formData.get('dropoffText') ?? '',
    viaText: formData.get('viaText') ?? '',

    // What the address field resolved, if a suggestion was chosen. Named
    // after the text field they belong to, so the two travel together.
    pickupPostcode: formData.get('pickupTextPostcode') ?? '',
    pickupLat: formData.get('pickupTextLat') ?? '',
    pickupLng: formData.get('pickupTextLng') ?? '',
    pickupLocationId: formData.get('pickupTextLocationId') ?? '',
    dropoffPostcode: formData.get('dropoffTextPostcode') ?? '',
    dropoffLat: formData.get('dropoffTextLat') ?? '',
    dropoffLng: formData.get('dropoffTextLng') ?? '',
    dropoffLocationId: formData.get('dropoffTextLocationId') ?? '',
    driverId: formData.get('driverId') ?? '',
    vehicleId: formData.get('vehicleId') ?? '',
    passengerName: formData.get('passengerName') ?? '',
    passengerPhone: formData.get('passengerPhone') ?? '',
    passengerCount: formData.get('passengerCount') ?? '',
    luggageCount: formData.get('luggageCount') ?? '',
    flightNumber: formData.get('flightNumber') ?? '',
    // The form asks for pounds; the schema converts to pence.
    clientPricePence: formData.get('clientPrice') ?? '',
    driverPricePence: formData.get('driverPrice') ?? '',
    // What the rate card offered, for the audit entry. Never the saved price.
    rateCardRuleId: formData.get('rateCardRuleId') ?? '',
    suggestedClientPricePence: formData.get('suggestedClientPrice') ?? '',
    suggestedDriverPricePence: formData.get('suggestedDriverPrice') ?? '',
    customerHours: formData.get('customerHours') ?? '',
    customerRatePence: formData.get('customerRate') ?? '',
    minimumHours: formData.get('minimumHours') ?? '',
    shiftId: formData.get('shiftId') ?? '',
    stops: readStops(formData),
    notes: formData.get('notes') ?? '',
    internalNotes: formData.get('internalNotes') ?? '',
  };
}

/**
 * The recurrence fields, or null when the operator did not tick "repeats".
 *
 * The end is a radio between a count and a date rather than two optional
 * boxes, because a form that lets somebody fill in both has to decide which
 * one wins — and whichever it picks, half the operators will be surprised.
 */
function readRecurrence(formData: FormData) {
  if (formData.get('repeats') !== 'on') return null;

  const endsWith = String(formData.get('repeatEndsWith') ?? 'count');
  return recurrenceSchema.parse({
    frequency: formData.get('repeatFrequency') ?? 'WEEKLY',
    interval: formData.get('repeatInterval') ?? 1,
    weekdays: formData.getAll('repeatWeekday').map(String),
    occurrences: endsWith === 'count' ? (formData.get('repeatCount') ?? 1) : null,
    endsOn: endsWith === 'date' ? (formData.get('repeatEndsOn') ?? null) : null,
  });
}

export async function createJobAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let destination: string;
  try {
    const { audit } = await actingUser('editJobs');
    const input = jobSchema.parse(readJobForm(formData));
    const { timeZone } = await getLocaleConfig();
    const recurrence = readRecurrence(formData);

    if (recurrence) {
      // Spec 6.3.3. The whole series is booked here rather than one job now
      // and the rest later, so an operator never leaves the form believing
      // they booked twelve airport runs when they booked one.
      const series = await createSeries(input, recurrence, audit, timeZone);
      destination = `/jobs/series/${series.seriesId}`;
    } else {
      const { id } = await createJob(input, audit, timeZone);

      // Spec 6.3.2. After the booking, and never allowed to fail it — a job
      // that exists without its link is a display problem, a link that took
      // the booking down with it is a lost fare.
      const outbound = String(formData.get('returnOfJobId') ?? '').trim();
      if (outbound) {
        try {
          await linkReturn(outbound, id, audit);
        } catch (linkError) {
          console.error('Could not link the return journey', linkError);
        }
      }

      destination = `/jobs/${id}`;
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/jobs');
  redirect(destination);
}

export async function updateJobAction(
  jobId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editJobs');
    const input = jobSchema.parse(readJobForm(formData));
    const { timeZone } = await getLocaleConfig();

    // Spec 6.3.5. Absent on a job with no series, and 'this' by default —
    // an edit reaching further than the operator meant is the failure worth
    // designing against, not one that reaches less far.
    const scope = String(formData.get('seriesScope') ?? 'this') as SeriesScope;

    if (scope === 'this') {
      await updateJob(jobId, input, audit, timeZone);
    } else {
      const result = await applySeriesEdit(jobId, input, scope, audit, timeZone);
      if (result.refused.length > 0) {
        // Named, not counted. "Three could not be changed" tells the operator
        // there is a problem without telling them where.
        return {
          error: `Changed ${result.changed.length}. Not changed: ${result.refused
            .map((row) => `${row.reference} (${row.reason})`)
            .join('; ')}`,
        };
      }
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/jobs');
  revalidatePath(`/jobs/${jobId}`);
  redirect(`/jobs/${jobId}`);
}

function readFinanceForm(formData: FormData) {
  const number = (name: string) => formData.get(name) ?? 0;
  return {
    baseFarePence: number('baseFarePence'),
    waitTimePence: number('waitTimePence'),
    waitMinutesBilled: number('waitMinutesBilled'),
    waitOverrideReason: formData.get('waitOverrideReason') ?? '',
    extraChargesPence: number('extraChargesPence'),
    extraChargesNotes: formData.get('extraChargesNotes') ?? '',
    customerHours: formData.get('customerHours') ?? '',
    customerRatePence: number('customerRatePence'),
    driverPaymentPence: number('driverPaymentPence'),
    fuelCostPence: number('fuelCostPence'),
    otherExpensesPence: number('otherExpensesPence'),
    expenseNotes: formData.get('expenseNotes') ?? '',
    driverHours: formData.get('driverHours') ?? '',
    driverRatePence: number('driverRatePence'),
    driverPayStatus: formData.get('driverPayStatus') ?? 'UNPAID',
    driverPayMethod: formData.get('driverPayMethod') ?? '',
    driverPaidAt: formData.get('driverPaidAt') ?? '',
    paymentNotes: formData.get('paymentNotes') ?? '',
  };
}

/**
 * Save the finance panel.
 *
 * The totals in the submitted form are ignored entirely — `toFinanceData`
 * recomputes them. The client's arithmetic is a preview, never the record.
 */
export async function saveFinanceAction(
  jobId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editJobFinances');
    const parsed = financeSchema.parse(readFinanceForm(formData));
    const data = toFinanceData(parsed);

    // A reason means somebody is deliberately replacing what the driver's
    // taps produced. Stamped here so the automatic calculation stops writing
    // over it — spec 5.5.4.
    const reason = (parsed.waitOverrideReason ?? '').trim();
    const override = reason
      ? {
          waitOverrideReason: reason,
          waitOverriddenById: audit.userId,
          waitOverriddenAt: new Date(),
        }
      : {};

    await withAudit(
      'JobFinance',
      'update',
      async (tx) => {
        const before = await tx.jobFinance.findUnique({ where: { jobId } });
        const after = await tx.jobFinance.upsert({
          where: { jobId },
          update: { ...data, ...override },
          create: { ...data, ...override, jobId },
        });
        return {
          entityId: after.id,
          before: before ?? undefined,
          after,
          result: null,
        };
      },
      audit,
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }

  revalidatePath('/jobs');
  revalidatePath(`/jobs/${jobId}`);
  redirect(`/jobs/${jobId}`);
}

/**
 * Set client and driver price on many jobs at once (spec 2.6.5).
 *
 * Exists for backfilling imported data, where hundreds of jobs arrive with no
 * price and fixing them one at a time is not realistic.
 */
export async function bulkPriceAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editJobFinances');
    const ids = formData.getAll('jobIds').map(String).filter(Boolean);
    if (ids.length === 0) return { error: 'Select at least one job first' };

    const parsed = jobPriceSchema.parse({
      clientPrice: formData.get('clientPrice') ?? '',
      driverPrice: formData.get('driverPrice') ?? '',
    });

    if (parsed.clientPrice === null && parsed.driverPrice === null) {
      return { error: 'Enter a client price, a driver price, or both' };
    }

    for (const id of ids) {
      await withAudit(
        'Job',
        'update',
        async (tx) => {
          const before = await tx.job.findUniqueOrThrow({ where: { id } });
          const after = await tx.job.update({
            where: { id },
            data: {
              ...(parsed.clientPrice !== null
                ? { clientPricePence: parsed.clientPrice }
                : {}),
              ...(parsed.driverPrice !== null
                ? { driverPricePence: parsed.driverPrice }
                : {}),
            },
          });
          await tx.jobEvent.create({
            data: {
              jobId: id,
              type: 'PRICE_SET',
              actorType: 'USER',
              actorId: audit.userId ?? null,
              metadata: { bulk: true, toPence: after.clientPricePence },
            },
          });
          return { entityId: id, before, after, result: null };
        },
        audit,
      );
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }

  revalidatePath('/jobs');
  return { error: null };
}

/**
 * Apply one status change to many jobs, reporting per job (spec 2.4.8).
 *
 * Each job is validated on its own and a failure does not stop the rest — a
 * batch where one job lacks a price should still move the other nine.
 */
export async function bulkTransitionAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editJobs');
    const ids = formData.getAll('jobIds').map(String).filter(Boolean);
    if (ids.length === 0) return { error: 'Select at least one job first' };

    const next = String(formData.get('status') ?? '') as JobStatus;

    const outcome = await runBulk(
      'status',
      ids,
      async (id) => {
        const result = await transitionJob(id, next, audit);
        return result.ok ? null : `${result.reference ?? id}: ${result.message}`;
      },
      audit,
    );

    revalidatePath('/jobs');
    if (outcome.operationId || outcome.failures.length > 0) {
      return { error: describeOutcome(outcome) };
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }

  return { error: null };
}

/**
 * Put one driver on many jobs — spec 6.5.2.
 *
 * Compliance is checked per job and blocks that job alone. A lapsed PHV badge
 * is a licensing requirement, so a driver who cannot take Tuesday's airport
 * run cannot take it as part of a batch either — but the other nine jobs are
 * nothing to do with it and still get their driver.
 *
 * A clash only warns on the booking form (spec 6.2.3), and here it does not
 * even do that: an operator selecting forty jobs and assigning one driver has
 * made a decision about their day, and a warning nobody can act on in bulk is
 * a warning they learn to dismiss.
 */
export async function bulkAssignAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editJobs');
    const ids = formData.getAll('jobIds').map(String).filter(Boolean);
    if (ids.length === 0) return { error: 'Select at least one job first' };

    const driverId = String(formData.get('driverId') ?? '').trim();
    if (!driverId) return { error: 'Choose a driver' };

    const outcome = await runBulk(
      'assign',
      ids,
      async (id) => {
        const job = await prisma.job.findUnique({
          where: { id },
          select: {
            reference: true,
            status: true,
            vehicleId: true,
            scheduledAt: true,
          },
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
        // Null when there is no driver to check, which cannot happen here —
        // but the narrowing is worth having rather than asserting past.
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
                // Only promote a job that has not moved past PENDING. A job
                // already ACCEPTED that is being reassigned goes back to
                // ASSIGNED, because the new driver has not accepted anything.
                status: before.status === 'DRAFT' ? 'DRAFT' : 'ASSIGNED',
              },
            });
            await tx.jobEvent.create({
              data: {
                jobId: id,
                type: 'ASSIGNED',
                actorType: 'USER',
                actorId: audit.userId ?? null,
                metadata: { bulk: true, driverId },
              },
            });
            return { entityId: id, before, after, result: null };
          },
          audit,
        );

        return null;
      },
      audit,
    );

    revalidatePath('/jobs');
    revalidatePath('/dispatch');
    if (outcome.operationId || outcome.failures.length > 0) {
      return { error: describeOutcome(outcome) };
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }

  return { error: null };
}

/**
 * Add many jobs to one draft invoice — spec 6.5.2.
 *
 * Each job goes on through `addJobLine`, which refuses one already billed and
 * one with no price. Both refusals matter more in bulk than singly: selecting
 * a month of work and invoicing it is exactly when an already-billed job
 * slips through unnoticed, and a job billed twice is money asked for twice.
 */
export async function bulkInvoiceAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editInvoices');
    const ids = formData.getAll('jobIds').map(String).filter(Boolean);
    if (ids.length === 0) return { error: 'Select at least one job first' };

    const invoiceId = String(formData.get('invoiceId') ?? '').trim();
    if (!invoiceId) return { error: 'Choose a draft invoice' };

    const outcome = await runBulk(
      'invoice',
      ids,
      async (id) => {
        const result = await addJobLine(invoiceId, id, audit);
        return result.ok ? null : result.message;
      },
      audit,
    );

    revalidatePath('/jobs');
    revalidatePath(`/invoices/${invoiceId}`);
    if (outcome.operationId || outcome.failures.length > 0) {
      return { error: describeOutcome(outcome) };
    }
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }

  return { error: null };
}


export async function deleteJobAction(
  jobId: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('deleteRecords');
    await withAudit(
      'Job',
      'delete',
      async (tx) => {
        const before = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
        await tx.job.update({
          where: { id: jobId },
          data: { deletedAt: new Date() },
        });
        return { entityId: jobId, before, result: null };
      },
      audit,
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/jobs');
  redirect('/jobs');
}
