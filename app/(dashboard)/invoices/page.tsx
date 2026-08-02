import { PageHeader } from '@/components/page-header';
import { PhasePlaceholder } from '@/components/phase-placeholder';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Invoices' };

export default async function InvoicesPage() {
  await pageRequireCapability('viewInvoices');

  return (
    <>
      <PageHeader
        title="Invoices"
        description="What has been billed, and what is still outstanding."
      />
      <PhasePlaceholder
        phase="Phase 4"
        summary="Consolidated invoicing from selected jobs with VAT, a gapless numbering sequence, PDF rendering and delivery, and an aging ledger."
      />
    </>
  );
}
