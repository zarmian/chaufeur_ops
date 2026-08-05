import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { listZones } from '@/lib/pricing/config';

export const metadata = { title: 'Zones' };

/**
 * Zone CRUD — spec 4.1.1.
 *
 * A zone is a name and a list of postcode prefixes. The matcher takes the
 * longest matching prefix, so `SW1A` beats `SW`, which is why the prefixes
 * are shown rather than hidden behind an edit button: which zone a postcode
 * lands in is the thing that decides a price.
 */
export default async function ZonesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');
  const query = await searchParams;
  const error = filterValue(query, 'zoneError');
  const editing = filterValue(query, 'edit');

  const zones = await listZones();
  const current = zones.find((zone) => zone.id === editing) ?? null;

  return (
    <>
      <PageHeader
        title="Zones"
        description="The areas the rate card prices between. A postcode falls in the zone whose prefix matches it most closely."
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
        <Alert variant="destructive" className="mb-6" data-testid="zone-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-3">
          {zones.map((zone) => {
            const uses =
              zone._count.rulesFromZone +
              zone._count.rulesToZone +
              zone._count.locations;
            return (
              <Card
                key={zone.id}
                className={zone.active ? '' : 'opacity-60'}
                data-testid="zone-card"
              >
                <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {zone.name}
                      {zone.active ? null : (
                        <Badge variant="secondary" className="ml-2">
                          Inactive
                        </Badge>
                      )}
                    </p>
                    <p className="mt-1 break-words text-xs tabular text-muted-foreground">
                      {zone.postcodes.length > 0
                        ? zone.postcodes.join(' · ')
                        : 'No postcode prefixes — matched by name and alias only'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {uses === 0
                        ? 'Not referenced yet'
                        : `${zone._count.rulesFromZone + zone._count.rulesToZone} rule${
                            zone._count.rulesFromZone + zone._count.rulesToZone === 1
                              ? ''
                              : 's'
                          }, ${zone._count.locations} location${zone._count.locations === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/settings/pricing/zones?edit=${zone.id}`}>
                        Edit
                      </Link>
                    </Button>
                    {zone.active ? (
                      <form method="post" action="/api/pricing/zones">
                        <input type="hidden" name="intent" value="deactivate" />
                        <input type="hidden" name="id" value={zone.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          Deactivate
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">
              {current ? `Edit ${current.name}` : 'Add a zone'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              method="post"
              action="/api/pricing/zones"
              className="space-y-4"
              data-testid="zone-form"
              key={current?.id ?? 'new'}
            >
              <input type="hidden" name="intent" value="save" />
              {current ? (
                <input type="hidden" name="id" value={current.id} />
              ) : null}

              <div>
                <label htmlFor="name" className="mb-1 block text-sm font-medium">
                  Name
                </label>
                <Input
                  id="name"
                  name="name"
                  defaultValue={current?.name ?? ''}
                  placeholder="Heathrow"
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="postcodes"
                  className="mb-1 block text-sm font-medium"
                >
                  Postcode prefixes
                </label>
                <Textarea
                  id="postcodes"
                  name="postcodes"
                  rows={4}
                  defaultValue={current?.postcodes.join('\n') ?? ''}
                  placeholder={'TW6\nUB7\nTW14'}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  One per line or comma-separated. Uppercased and de-duplicated
                  on save — the longest matching prefix wins, so `SW1A` beats
                  `SW`.
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="active"
                  defaultChecked={current?.active ?? true}
                  className="size-4"
                />
                Active
              </label>

              <div className="flex items-center gap-2">
                <Button type="submit">{current ? 'Save zone' : 'Add zone'}</Button>
                {current ? (
                  <Button asChild variant="ghost">
                    <Link href="/settings/pricing/zones">Cancel</Link>
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
