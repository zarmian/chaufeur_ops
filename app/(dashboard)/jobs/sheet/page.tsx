import { FileText } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Book from a job sheet' };

/**
 * Upload an agency's PDF instead of retyping it.
 *
 * A plain form posting to a route handler rather than a Server Action, because
 * the server has to read the bytes and a Server Action's body is capped well
 * below what the platform allows a function. The handler redirects straight to
 * the booking form with the fields already in it.
 *
 * Deliberately not a one-click booking. The sheet fills the form in and an
 * operator presses Book, so every job still goes through the same validation,
 * compliance checks, pricing and clash warnings as one typed by hand — and
 * anything the reader got wrong is in front of somebody before a car is
 * committed, not afterwards.
 */
export default async function JobSheetUploadPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('editJobs');
  const error = filterValue(await searchParams, 'error');

  return (
    <>
      <PageHeader
        title="Book from a job sheet"
        description="Upload the PDF an agency sent. The booking form opens with what it says already filled in."
      />

      {error ? (
        <Alert variant="destructive" className="mb-6">
          {error}
        </Alert>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          <form
            action="/api/job-sheets/upload"
            method="post"
            encType="multipart/form-data"
            className="space-y-5"
          >
            <div className="space-y-2">
              <label htmlFor="sheet" className="text-sm font-medium">
                Job sheet
              </label>
              <Input
                id="sheet"
                name="sheet"
                type="file"
                accept="application/pdf"
                required
                className="file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm"
              />
              <p className="text-sm text-muted-foreground">
                A PDF, as the agency sent it. One page of text — a scan or a
                photograph of a sheet has no text in it to read.
              </p>
            </div>

            <Button type="submit">
              <FileText className="mr-2 size-4" aria-hidden />
              Read the sheet
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="mt-6 rounded-lg border p-4 text-sm">
        <p className="font-medium">What it fills in, and what it leaves alone.</p>
        <p className="mt-1 text-muted-foreground">
          The date and time, both addresses, the passenger, the flight, and the
          agency&rsquo;s own reference — which is carried onto their invoice.
          Anything the sheet does not say is left empty rather than guessed at,
          and a sheet that names no price produces a job with no price, so it
          shows up as unpriced until somebody agrees one.
        </p>
        <p className="mt-3 text-muted-foreground">
          Nobody is assigned. The driver and the car are still chosen here,
          which is what runs the licence and MOT checks against the pickup date.
        </p>
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        Or{' '}
        <Link href="/jobs/new" className="underline">
          book a job by hand
        </Link>
        .
      </p>
    </>
  );
}
