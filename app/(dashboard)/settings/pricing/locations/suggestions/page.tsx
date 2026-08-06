import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { locationCandidates, MIN_USES } from '@/lib/location-mining';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Suggested locations' };

/**
 * Addresses worth saving, taken from the bookings already taken — spec 6.4.4.
 *
 * The spec asks for bulk-create from the migrated data's most frequent
 * pickup and dropoff strings. There is no migrated data — this install starts
 * empty by design — so it is the same idea against the business's own
 * bookings, which is where those strings actually come from.
 *
 * It proposes and never creates on its own. Free-typed addresses include
 * typos, half-addresses and one-offs alongside the real regulars, and a
 * screen that saved all of them would fill the autocomplete with exactly the
 * noise it exists to replace.
 */
export default async function LocationSuggestionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;

  const error = filterValue(query, 'locationError');
  const created = filterValue(query, 'created');
  const candidates = await locationCandidates(50);

  return (
    <>
      <PageHeader
        title="Suggested locations"
        description={`Addresses used on at least ${MIN_USES} bookings that are not saved yet.`}
        actions={
          <Button asChild variant="outline">
            <Link href="/settings/pricing/locations">
              <ArrowLeft aria-hidden />
              Saved locations
            </Link>
          </Button>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="location-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {created ? (
        <Alert className="mb-6" data-testid="suggestions-message">
          <AlertDescription>
            {created} location{created === '1' ? '' : 's'} saved. They are on the
            booking form now.
          </AlertDescription>
        </Alert>
      ) : null}

      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="suggestions-empty">
          Nothing to suggest. Either every frequently-used address is already
          saved, or there are not enough bookings yet to tell a regular
          destination from a one-off.
        </p>
      ) : (
        <form method="post" action="/api/pricing/locations/suggestions">
          <input type="hidden" name="intent" value="save" />

          <Table data-testid="suggestions-table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>Address</TableHead>
                <TableHead>Postcode</TableHead>
                <TableHead className="text-right tabular">Bookings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((candidate) => (
                <TableRow key={candidate.address} data-testid="suggestion-row">
                  <TableCell>
                    <input
                      type="checkbox"
                      name="address"
                      value={candidate.address}
                      className="size-4 rounded border-input"
                      aria-label={`Save ${candidate.address}`}
                    />
                  </TableCell>
                  <TableCell>{candidate.address}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {candidate.postcode ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {candidate.uses}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="mt-4 flex items-center gap-3">
            <Button type="submit">Save the ticked addresses</Button>
            <span className="text-xs text-muted-foreground">
              Each one keeps the bookings it already has, so it sorts where it
              belongs on the booking form straight away.
            </span>
          </div>
        </form>
      )}
    </>
  );
}
