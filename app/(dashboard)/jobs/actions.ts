'use server';

import type { JobStatus } from '@prisma/client';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { financeSchema, toFinanceData } from '@/lib/job-finance';
import { jobPriceSchema } from '@/lib/job-price-schema';
import { createJob, jobSchema, transitionJob, updateJob } from '@/lib/jobs';
import { withAudit } from '@/lib/audit';
import { actingUser } from '@/lib/request-context';

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

export async function createJobAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  let id: string;
  try {
    const { audit } = await actingUser('editJobs');
    ({ id } = await createJob(jobSchema.parse(readJobForm(formData)), audit));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return toFormState(error);
  }
  revalidatePath('/jobs');
  redirect(`/jobs/${id}`);
}

export async function updateJobAction(
  jobId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const { audit } = await actingUser('editJobs');
    await updateJob(jobId, jobSchema.parse(readJobForm(formData)), audit);
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
    const data = toFinanceData(financeSchema.parse(readFinanceForm(formData)));

    await withAudit(
      'JobFinance',
      'update',
      async (tx) => {
        const before = await tx.jobFinance.findUnique({ where: { jobId } });
        const after = await tx.jobFinance.upsert({
          where: { jobId },
          update: data,
          create: { ...data, jobId },
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
    const failures: string[] = [];
    let moved = 0;

    for (const id of ids) {
      const result = await transitionJob(id, next, audit);
      if (result.ok) moved += 1;
      else failures.push(`${result.reference ?? id}: ${result.message}`);
    }

    revalidatePath('/jobs');

    if (failures.length > 0) {
      return {
        error: `${moved} job${moved === 1 ? '' : 's'} updated. ${
          failures.length
        } refused — ${failures.join(' | ')}`,
      };
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
