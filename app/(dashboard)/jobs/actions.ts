'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isRedirectError, toFormState, type FormState } from '@/lib/form-state';
import { financeSchema, toFinanceData } from '@/lib/job-finance';
import { createJob, jobSchema, updateJob } from '@/lib/jobs';
import { withAudit } from '@/lib/audit';
import { getLocaleConfig } from '@/lib/locale-store';
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
    // Empty means "follow the booker", which is the usual answer.
    vatTreatment: formData.get('vatTreatment') ?? '',
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
