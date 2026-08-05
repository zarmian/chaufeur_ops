import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ENTITY_DEFS, isImportEntity } from '@/lib/import-schema';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { ImportPanel } from '../import-panel';

export const metadata = { title: 'Import' };

export default async function ImportEntityPage({
  params,
  searchParams,
}: {
  params: Promise<{ entity: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageSettings');

  const { entity } = await params;
  if (!isImportEntity(entity)) notFound();

  const query = await searchParams;
  const def = ENTITY_DEFS[entity];

  const fileName = filterValue(query, 'file');
  const summary = fileName
    ? {
        created: Number(filterValue(query, 'created') ?? 0),
        updated: Number(filterValue(query, 'updated') ?? 0),
        skipped: Number(filterValue(query, 'skipped') ?? 0),
        errorCount: Number(filterValue(query, 'problems') ?? 0),
        fileName,
      }
    : null;

  return (
    <>
      <PageHeader
        title={`Import ${def.label.toLowerCase()}`}
        description={`Matched on ${def.naturalKey}. Rows with problems are skipped and listed; the rest import.`}
        actions={
          <Button asChild variant="outline">
            <Link href="/settings/import">
              <ArrowLeft aria-hidden />
              All imports
            </Link>
          </Button>
        }
      />

      <ImportPanel
        entity={entity}
        error={filterValue(query, 'importError')}
        summary={summary}
      />
    </>
  );
}
