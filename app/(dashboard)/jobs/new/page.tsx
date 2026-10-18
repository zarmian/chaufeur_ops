import { PageHeader } from '@/components/page-header';
import { loadJobFormOptions, loadOpenShifts } from '@/lib/job-form-data';
import { duplicateDefaults, getJob } from '@/lib/jobs';
import { filterFlag, filterValue, type SearchParams } from '@/lib/list-params';
import { sheetFormValues } from '@/lib/job-sheets/form-values';
import { getSheet } from '@/lib/job-sheets/store';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { getPlacesConfig } from '@/lib/places/store';
import { peekNextJobReference } from '@/lib/references';
import { returnDefaults } from '@/lib/series';
import { createJobAction } from '../actions';
import { BLANK_JOB_VALUES, type JobFormValues } from '@/lib/job-form-values';
import { JobForm } from '../job-form';

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

  /*
   * `?sheet=<id>` arrives from an uploaded agency job sheet. The form is
   * filled in from what was read and the operator presses Book, so a sheet
   * creates a job through exactly the same path as one typed by hand — the
   * same validation, the same compliance checks, the same clash warnings.
   * There is no second way to create a job to keep in step with the first.
   */
  const sheetId = filterValue(params, 'sheet');
  const sheet = sheetId ? await getSheet(sheetId) : null;

  // `?from=<id>` duplicates an existing job; `&return=true` swaps the
  // addresses for the journey back (spec 2.3.8–9).
  const sourceId = filterValue(params, 'from');
  const isReturn = filterFlag(params, 'return');
  const source = sourceId ? await getJob(sourceId) : null;

  let values: JobFormValues | undefined;
  if (sheet) {
    values = {
      ...BLANK_JOB_VALUES,
      ...sheetFormValues(sheet.draft, sheet.sender, sheet.located),
    };
  } else if (source) {
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
      // And a booker's reference belongs to one booking. Copying it would put
      // two jobs on their invoice under the same reservation number.
      customerReference: '',
      internalNotes: '',
    };
  }

  /*
   * What the sheet could not tell us, said plainly above the form.
   *
   * A pre-filled form that silently lacks a time looks like a sheet that had
   * no time on it, and an operator fills in something plausible instead of
   * going to look at the page.
   */
  const sheetNote = sheet
    ? sheet.missing.length > 0
      ? `Read from ${sheet.fileName}. It does not give ${listOut(sheet.missing)} — check the page and fill them in.`
      : `Read from ${sheet.fileName}. Check it against the page, then book.`
    : null;

  const description = sheetNote
    ? sheetNote
    : source
    ? isReturn
      ? `Return journey from ${source.reference}. The addresses are swapped and a time is suggested — check both, and the price.`
      : `Copied from ${source.reference}. The date is cleared; set it before saving.`
    : `Will be booked as ${nextReference}. Enter the price now — a job saved without one does not appear in any revenue report.`;

  return (
    <>
      <PageHeader
        title={
          sheet
            ? 'Book from a job sheet'
            : isReturn
              ? 'Return journey'
              : source
                ? 'Duplicate job'
                : 'New job'
        }
        description={description}
      />
      <JobForm
        action={createJobAction}
        submitLabel="Book job"
        cancelHref={sheet ? '/jobs/sheet' : source ? `/jobs/${source.id}` : '/jobs'}
        values={values}
        clients={options.clients}
        accounts={options.accounts}
        drivers={options.drivers}
        vehicles={options.vehicles}
        locations={options.locations}
        openShifts={openShifts}
        sheetId={sheet?.id}
        allowRepeat={!isReturn}
        returnOfJobId={isReturn && source ? source.id : undefined}
        currency={locale.currency}
        locale={locale.locale}
        addressSuggestions={places.provider === 'google' && places.keySet}
      />
    </>
  );
}

/** "the pickup time and the destination" — a list somebody can read aloud. */
function listOut(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`;
}
