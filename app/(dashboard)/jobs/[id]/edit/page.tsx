import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { getPartsInZone } from '@/lib/dates';
import { loadJobFormOptions, loadOpenShifts } from '@/lib/job-form-data';
import { getJob } from '@/lib/jobs';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { updateJobAction } from '../../actions';
import { JobForm } from '../../job-form';

export const metadata = { title: 'Edit job' };

/** Pounds for the form; the schema converts back to pence on save. */
const asPounds = (pence: number | null) =>
  pence === null ? '' : (pence / 100).toFixed(2);

export default async function EditJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await pageRequireCapability('editJobs');
  const { id } = await params;

  const [job, options, openShifts, locale] = await Promise.all([
    getJob(id),
    loadJobFormOptions(),
    loadOpenShifts(),
    getLocaleConfig(),
  ]);
  if (!job) notFound();

  // The instant is stored in UTC; the form edits it in the operator's zone,
  // so a summer pickup does not shift by an hour every time it is saved.
  const local = getPartsInZone(job.scheduledAt);
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    <>
      <PageHeader title={`Edit ${job.reference}`} />
      <JobForm
        action={updateJobAction.bind(null, job.id)}
        submitLabel="Save changes"
        cancelHref={`/jobs/${job.id}`}
        clients={options.clients}
        accounts={options.accounts}
        drivers={options.drivers}
        vehicles={options.vehicles}
        locations={options.locations}
        openShifts={openShifts}
        jobId={job.id}
        inSeries={Boolean(job.seriesId)}
        currency={locale.currency}
        locale={locale.locale}
        values={{
          clientId: job.clientId ?? '',
          accountId: job.accountId ?? '',
          jobType: job.jobType,
          scheduledDate: `${local.year}-${pad(local.month)}-${pad(local.day)}`,
          scheduledTime: `${pad(local.hour)}:${pad(local.minute)}`,
          pickupText: job.pickupText,
          pickupPostcode: job.pickupPostcode ?? '',
          pickupLat: job.pickupLat === null ? '' : String(job.pickupLat),
          pickupLng: job.pickupLng === null ? '' : String(job.pickupLng),
          dropoffText: job.dropoffText,
          dropoffPostcode: job.dropoffPostcode ?? '',
          dropoffLat: job.dropoffLat === null ? '' : String(job.dropoffLat),
          dropoffLng: job.dropoffLng === null ? '' : String(job.dropoffLng),
          viaText: job.viaText ?? '',
          driverId: job.driverId ?? '',
          vehicleId: job.vehicleId ?? '',
          passengerName: job.passengerName ?? '',
          passengerPhone: job.passengerPhone ?? '',
          passengerCount: job.passengerCount ?? '',
          luggageCount: job.luggageCount ?? '',
          flightNumber: job.flightNumber ?? '',
          clientPrice: asPounds(job.clientPricePence),
          driverPrice: asPounds(job.driverPricePence),
          vatTreatment: job.vatTreatment ?? '',
          customerHours: job.finance?.customerHours?.toString() ?? '',
          customerRate: asPounds(job.finance?.customerRatePence ?? null),
          minimumHours: '',
          shiftId: job.shiftId ?? '',
          stops: job.stops
            .slice()
            .sort((a, b) => a.sequence - b.sequence)
            .map((stop) => ({
              address: stop.address,
              waitMinutes: stop.waitMinutes?.toString() ?? '',
              charge: asPounds(stop.chargePence),
              note: stop.note ?? '',
            })),
          notes: job.notes ?? '',
          internalNotes: job.internalNotes ?? '',
        }}
      />
    </>
  );
}
