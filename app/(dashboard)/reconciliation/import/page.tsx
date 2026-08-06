import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { getLocaleConfig } from '@/lib/locale-store';
import { pageRequireCapability } from '@/lib/page-guards';
import { ImportPanel } from './import-panel';

export const metadata = { title: 'Import a statement' };

export default async function ImportStatementPage() {
  await pageRequireCapability('editInvoices');
  const locale = await getLocaleConfig();

  return (
    <>
      <PageHeader
        title="Import a statement"
        description="Read the CSV, see what it would do, then do it. Nothing is written until you say so."
        actions={
          <Button asChild variant="outline">
            <Link href="/reconciliation">Back</Link>
          </Button>
        }
      />

      <ImportPanel currency={locale.currency} locale={locale.locale} />
    </>
  );
}
