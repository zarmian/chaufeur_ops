import { PageHeader } from '@/components/page-header';
import { loadJobFormOptions, loadOpenShifts } from '@/lib/job-form-data';
import { duplicateDefaults, getJob } from '@/lib/jobs';
import { filterFlag, filterValue, type SearchParams } from '@/lib/list-params';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { getPlacesConfig } from '@/lib/places/store';
import { peekNextJobReference } from '@/lib/references';
import { returnDefaults } from '@/lib/series';
import { createJobAction } from '../actions';
import { JobForm, type JobFormValues } from '../job-form';

export const metadata = { title: 'New job' };

/** Pounds for the form; the schema converts back to pence on save. */
const asPounds = (pence: number | null) =>
  pence === null ? '' : (pence / 100).toFixed(2);

export default async function NewJobPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('editJobs');
  const params = await searchParams;

  const [options, nextReference, openShifts, locale, places] = await Promise.all([
    loadJobFormOptions(),
    peekNextJobReference(),
    loadOpenShifts(),
    getLocaleConfig(),
    getPlacesConfig(),
  ]);

  // `?from=<id>` duplicates an existing job; `&return=true` swaps the
  // addresses for the journey back (spec 2.3.8–9).
  const sourceId = filterValue(params, 'from');
  const isReturn = filterFlag(params, 'return');
  const source = sourceId ? await getJob(sourceId) : null;

  let values: JobFormValues | undefined;
  if (source) {
    // Spec 6.3.1. A return gets the swap `duplicateDefaults` already knows
    // how to do, plus the one thing a duplicate does not need: a plausible
    // time. A suggestion, not a rule — the operator will change it, and what
    // matters is that the field is not empty.
    const defaults = isReturn
      ? returnDefaults(source, locale.timeZone)
      : duplicateDefaults(source, { swap: false });

    values = {
      ...defaults,
      customerHours: '',
      customerRate: '',
      minimumHours: '',
      customerDays: '',
      customerDayRate: '',
      minimumDays: '',
      driverDays: '',
      driverDayRate: '',
      shiftId: '',
      stops: [],
      // For a duplicate the date stays blank on purpose — see
      // `duplicateDefaults`. A return carries the suggested one.
      clientPrice: asPounds(defaults.clientPricePence),
      driverPrice: asPounds(defaults.driverPricePence),
      vatTreatment: '',
      // A flight number belongs to one specific arrival, never to its copy.
      flightNumber: '',
      internalNotes: '',
    };
  }

  const description = source
    ? isReturn
      ? `Return journey from ${source.reference}. The addresses are swapped and a time is suggested — check both, and the price.`
      : `Copied from ${source.reference}. The date is cleared; set it before saving.`
    : `Will be booked as ${nextReference}. Enter the price now — a job saved without one does not appear in any revenue report.`;

  return (
    <>
      <PageHeader
        title={isReturn ? 'Return journey' : source ? 'Duplicate job' : 'New job'}
        description={description}
      />
      <JobForm
        action={createJobAction}
        submitLabel="Book job"
        cancelHref={source ? `/jobs/${source.id}` : '/jobs'}
        values={values}
        clients={options.clients}
        accounts={options.accounts}
        drivers={options.drivers}
        vehicles={options.vehicles}
        locations={options.locations}
        openShifts={openShifts}
        allowRepeat={!isReturn}
        returnOfJobId={isReturn && source ? source.id : undefined}
        currency={locale.currency}
        locale={locale.locale}
        addressSuggestions={places.provider === 'google' && places.keySet}
      />
    </>
  );
}
