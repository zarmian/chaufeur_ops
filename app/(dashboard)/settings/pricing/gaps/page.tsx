import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/dates';
import { JOB_TYPES } from '@/lib/enum-options';
import { pageRequireCapability } from '@/lib/page-guards';
import { unmatchedPickups } from '@/lib/pricing/rate-card';

export const metadata = { title: 'Unpriced pickups' };

/**
 * Pickup text nothing matched — spec 4.1.7.
 *
 * This list *is* the specification for improving the matcher. Without it the
 * only signal that pricing has stopped working is an operator who has quietly
 * gone back to typing every fare by hand, and by then nobody remembers which
 * addresses were the problem.
 *
 * Each row is dismissed once the matcher has been taught about it, rather
 * than ageing out on its own: a list that empties itself is one nobody has to
 * act on.
 */
export default async function PricingGapsPage() {
  await pageRequireCapability('manageSettings');

  const rows = await unmatchedPickups(200);

  return (
    <>
      <PageHeader
        title="Unpriced pickups"
        description="Addresses the zone matcher could not place. Add a postcode prefix to a zone, or save the address as a location with its zone set."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/settings/pricing/zones">Zones</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/settings/pricing">
                <ArrowLeft aria-hidden />
                Pricing
              </Link>
            </Button>
          </div>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing outstanding"
          description="Every pickup the rate card was asked about matched a zone. New ones appear here the moment they do not."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pickup</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.pickupText}>
                <TableCell className="font-medium">{row.pickupText}</TableCell>
                <TableCell className="text-muted-foreground">
                  {row.dropoffText ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {JOB_TYPES.find((type) => type.value === row.jobType)?.label ??
                    row.jobType}
                </TableCell>
                <TableCell className="tabular text-muted-foreground">
                  {row.lastSeenAt ? formatDateTime(new Date(row.lastSeenAt)) : '—'}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button asChild variant="ghost" size="sm">
                      <Link
                        href={`/settings/pricing/locations?q=${encodeURIComponent(row.pickupText)}`}
                      >
                        Save as location
                      </Link>
                    </Button>
                    <form method="post" action="/api/pricing/gaps">
                      <input
                        type="hidden"
                        name="pickupText"
                        value={row.pickupText}
                      />
                      <Button type="submit" variant="ghost" size="sm">
                        Dismiss
                      </Button>
                    </form>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
