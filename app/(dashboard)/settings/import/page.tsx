import { Car, ClipboardList, Contact, Users } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { ENTITY_DEFS, IMPORT_ENTITIES } from '@/lib/import-schema';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Import' };

const ICONS = {
  drivers: Users,
  vehicles: Car,
  clients: Contact,
  jobs: ClipboardList,
} as const;

export default async function ImportIndexPage() {
  await pageRequireCapability('manageSettings');

  return (
    <>
      <PageHeader
        title="Import"
        description="Load an existing fleet from a spreadsheet rather than typing several hundred records by hand."
      />

      <div className="mb-6 rounded-lg border p-4 text-sm">
        <p className="font-medium">Load the vehicles first.</p>
        <p className="mt-1 text-muted-foreground">
          The driver file can name a car by registration, which links the two in
          one pass — but only for vehicles already on the fleet. Importing
          drivers first still works; their registrations are simply reported as
          unmatched, and re-running the same driver file afterwards picks them
          up.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {IMPORT_ENTITIES.map((entity) => {
          const def = ENTITY_DEFS[entity];
          const Icon = ICONS[entity];
          return (
            <Link key={entity} href={`/settings/import/${entity}`} className="block">
              <Card className="h-full transition-colors hover:bg-accent">
                <CardContent className="p-5">
                  <Icon
                    className="mb-3 size-5 text-muted-foreground"
                    aria-hidden
                  />
                  <p className="font-medium">{def.label}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {def.columns.length} columns, matched on {def.naturalKey}.
                  </p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </>
  );
}
