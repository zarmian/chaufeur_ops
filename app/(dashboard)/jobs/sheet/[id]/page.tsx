import { AlertTriangle, ArrowRight, FileText } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { loadJobFormOptions } from '@/lib/job-form-data';
import { REFUSAL_TEXT, type LocatedAddress } from '@/lib/job-sheets/locate';
import { guessSenderName } from '@/lib/job-sheets/read';
import { getSheet } from '@/lib/job-sheets/store';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { assignSenderAction, createSenderAction, discardSheetAction } from '../actions';
import { DiscardButton } from './discard-button';
import { SenderForm } from '../sender-form';

export const metadata = { title: 'Job sheet' };

/**
 * What a sheet said, before it becomes a job.
 *
 * Reached for the two cases the operator has to decide rather than confirm: a
 * sheet this install has seen the bytes of before, and a sheet from an agency
 * nobody has set up. Both stop short of the booking form on purpose.
 *
 * The duplicate is the more expensive of the two. Agencies resend sheets — an
 * amended pickup, a chased confirmation, a copy forwarded by somebody else —
 * and booking the same journey twice sends two cars to the same address at the
 * same time, which costs a driver's day and the client's confidence. No amount
 * of accurate reading afterwards undoes it.
 */
export default async function JobSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('editJobs');

  const { id } = await params;
  const sheet = await getSheet(id);
  if (!sheet) notFound();

  const seenId = filterValue(await searchParams, 'seen');

  const [options, senders, earlier] = await Promise.all([
    loadJobFormOptions(),
    prisma.sheetSender.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    seenId
      ? prisma.jobSheet.findUnique({
          where: { id: seenId },
          select: {
            uploadedAt: true,
            job: { select: { id: true, reference: true } },
          },
        })
      : null,
  ]);

  const createForThisSheet = createSenderAction.bind(null, sheet.id);
  const assignForThisSheet = assignSenderAction.bind(null, sheet.id);
  const discardThisSheet = discardSheetAction.bind(null, sheet.id);

  return (
    <>
      <PageHeader
        title="Job sheet"
        description={sheet.fileName}
      />

      {earlier ? (
        <Card className="mb-6 border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-destructive" aria-hidden />
              This sheet has been read before
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              The same file was uploaded on{' '}
              {earlier.uploadedAt.toISOString().slice(0, 10)}.{' '}
              {earlier.job ? (
                <>
                  It was booked as{' '}
                  <Link href={`/jobs/${earlier.job.id}`} className="underline">
                    {earlier.job.reference}
                  </Link>
                  . Booking it again would send two cars.
                </>
              ) : (
                'It was read but never booked.'
              )}
            </p>
            <DiscardButton action={discardThisSheet} />
          </CardContent>
        </Card>
      ) : null}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4" aria-hidden />
            What the sheet says
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SheetReadback sheet={sheet} />
        </CardContent>
      </Card>

      {sheet.sender ? (
        <div className="flex items-center gap-3">
          <Button asChild>
            <Link href={`/jobs/new?sheet=${sheet.id}`}>
              Continue to the booking form
              <ArrowRight className="ml-2 size-4" aria-hidden />
            </Link>
          </Button>
          <span className="text-sm text-muted-foreground">
            Sent by {sheet.sender.name}.
          </span>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Whose sheet is this?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Asked once per agency. The reader can tell what the sheet says, but
              not which account gets the invoice — and a job booked without one
              can never be billed.
            </p>
            <SenderForm
              createAction={createForThisSheet}
              assignAction={assignForThisSheet}
              senders={senders.map((sender) => ({
                id: sender.id,
                label: sender.name,
              }))}
              accounts={options.accounts}
              clients={options.clients}
              suggestedName={guessSenderName(await sheetText(sheet.id))}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

/** The page as the reader saw it, for the name guess. */
async function sheetText(id: string): Promise<string> {
  const row = await prisma.jobSheet.findUnique({
    where: { id },
    select: { text: true },
  });

  return row?.text ?? '';
}

const FIELD_LABELS: Array<[string, string]> = [
  ['scheduledDate', 'Date'],
  ['scheduledTime', 'Time'],
  ['pickupText', 'Pick up'],
  ['dropoffText', 'Drop off'],
  ['passengerName', 'Passenger'],
  ['passengerPhone', 'Passenger phone'],
  ['passengerCount', 'Passengers'],
  ['luggageCount', 'Luggage'],
  ['flightNumber', 'Flight'],
  ['customerReference', 'Their reference'],
  ['vehicleRequested', 'Vehicle asked for'],
  ['clientPrice', 'Price'],
  ['notes', 'Notes'],
];

/**
 * Every field, including the ones that came back empty.
 *
 * Shown with the label each value was read from. An operator checking a
 * pre-filled form has no way to tell a value the sheet stated from one that
 * came out of the wrong box, and this is the only place that difference is
 * visible before a car is committed.
 */
function SheetReadback({
  sheet,
}: {
  sheet: NonNullable<Awaited<ReturnType<typeof getSheet>>>;
}) {
  const draft = sheet.draft as unknown as Record<string, string | null>;

  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {FIELD_LABELS.map(([key, label]) => {
        const value = draft[key];
        const source = (
          sheet.sources as unknown as Record<string, { label: string } | undefined>
        )[key];

        const placed =
          key === 'pickupText'
            ? sheet.located.pickup
            : key === 'dropoffText'
              ? sheet.located.dropoff
              : null;

        return (
          <div key={key} className="min-w-0">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              {label}
            </dt>
            <dd className="mt-0.5 break-words text-sm">
              {value ? (
                <>
                  {placed?.text ?? value}
                  {source ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      from &ldquo;{source.label}&rdquo;
                    </span>
                  ) : null}
                  {placed ? <Pinned located={placed} /> : null}
                </>
              ) : (
                <span className="text-muted-foreground">
                  {key === 'clientPrice'
                    ? 'none on the sheet — the job will be unpriced'
                    : 'not on the sheet'}
                </span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * What the address lookup made of this address.
 *
 * Said rather than left to be inferred from a map pin that is or is not there.
 * A job with no coordinates prices off its postcode alone and carries nothing
 * for a driver's navigation to open, and the operator is the only person who
 * can do anything about it — but only if they are told, and told which of the
 * three reasons it is.
 */
function Pinned({ located }: { located: LocatedAddress }) {
  if (located.refused) {
    return (
      <span className="mt-0.5 block text-xs text-muted-foreground">
        No map location — {REFUSAL_TEXT[located.refused]}.
      </span>
    );
  }

  return (
    <span className="mt-0.5 block text-xs text-muted-foreground">
      Found on the map
      {located.postcode ? ` — ${located.postcode}` : ''}
      {located.text !== located.sheetText
        ? `. The sheet wrote it as “${located.sheetText}”.`
        : '.'}
    </span>
  );
}
