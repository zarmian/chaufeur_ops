import { ArrowLeft, Plane } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { listLocations, listZones } from '@/lib/pricing/config';

export const metadata = { title: 'Saved locations' };

/**
 * Location CRUD — spec 4.1.5 and 4.1.6.
 *
 * Ordered by `useCount` rather than alphabetically, because the point of a
 * saved location is to stop somebody typing "Heathrow Terminal 5" for the
 * four hundredth time — and the ones typed most are the ones worth putting
 * first.
 */
export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const search = filterValue(query, 'q');
  const error = filterValue(query, 'locationError');
  const editing = filterValue(query, 'edit');

  const [locations, zones] = await Promise.all([
    listLocations(search, 200),
    listZones(),
  ]);
  const current = locations.find((location) => location.id === editing) ?? null;
  const activeZones = zones.filter((zone) => zone.active);

  return (
    <>
      <PageHeader
        title="Saved locations"
        description="Addresses the booking form offers, ordered by how often they are actually chosen."
        actions={
          <Button asChild variant="outline">
            <Link href="/settings/pricing">
              <ArrowLeft aria-hidden />
              Pricing
            </Link>
          </Button>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-6" data-testid="location-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <form method="get" action="/settings/pricing/locations" className="flex gap-2">
            <Input
              name="q"
              defaultValue={search ?? ''}
              placeholder="Search name, address or postcode"
              aria-label="Search locations"
            />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>

          {locations.length === 0 ? (
            <EmptyState
              title={search ? 'Nothing matches that' : 'No saved locations yet'}
              description={
                search
                  ? 'Try part of the address or the postcode.'
                  : 'Add the places that come up most — airports, hotels, offices.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead className="text-right">Used</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locations.map((location) => (
                  <TableRow key={location.id}>
                    <TableCell className="font-medium">
                      {location.label}
                      {location.isAirport ? (
                        <Plane
                          className="ml-1 inline size-3.5 text-muted-foreground"
                          aria-label="Airport"
                        />
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {location.address}
                      {location.postcode ? (
                        <span className="ml-1 tabular">{location.postcode}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {location.zone?.name ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">
                      {location.useCount}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            href={`/settings/pricing/locations?edit=${location.id}${search ? `&q=${encodeURIComponent(search)}` : ''}`}
                          >
                            Edit
                          </Link>
                        </Button>
                        <form method="post" action="/api/pricing/locations">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="id" value={location.id} />
                          <Button type="submit" variant="ghost" size="sm">
                            Remove
                          </Button>
                        </form>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">
              {current ? `Edit ${current.label}` : 'Add a location'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              method="post"
              action="/api/pricing/locations"
              className="space-y-4"
              data-testid="location-form"
              key={current?.id ?? 'new'}
            >
              <input type="hidden" name="intent" value="save" />
              {current ? (
                <input type="hidden" name="id" value={current.id} />
              ) : null}

              <div>
                <label htmlFor="label" className="mb-1 block text-sm font-medium">
                  Name
                </label>
                <Input
                  id="label"
                  name="label"
                  defaultValue={current?.label ?? ''}
                  placeholder="Heathrow T5"
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="address"
                  className="mb-1 block text-sm font-medium"
                >
                  Address
                </label>
                <Input
                  id="address"
                  name="address"
                  defaultValue={current?.address ?? ''}
                  placeholder="Terminal 5, Heathrow Airport, Longford"
                  required
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="postcode"
                    className="mb-1 block text-sm font-medium"
                  >
                    Postcode
                  </label>
                  <Input
                    id="postcode"
                    name="postcode"
                    defaultValue={current?.postcode ?? ''}
                    placeholder="TW6 2GA"
                  />
                </div>
                <div>
                  <label
                    htmlFor="zoneId"
                    className="mb-1 block text-sm font-medium"
                  >
                    Zone
                  </label>
                  <Select
                    id="zoneId"
                    name="zoneId"
                    defaultValue={current?.zoneId ?? ''}
                  >
                    <option value="">Work it out from the postcode</option>
                    {activeZones.map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="isAirport"
                  defaultChecked={current?.isAirport ?? false}
                  className="mt-0.5 size-4"
                />
                <span>
                  This is an airport
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Airport arrivals get the longer free waiting allowance,
                    because a delayed flight is not the driver&rsquo;s fault or
                    the client&rsquo;s.
                  </span>
                </span>
              </label>

              <div className="flex items-center gap-2">
                <Button type="submit">
                  {current ? 'Save location' : 'Add location'}
                </Button>
                {current ? (
                  <Button asChild variant="ghost">
                    <Link href="/settings/pricing/locations">Cancel</Link>
                  </Button>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
