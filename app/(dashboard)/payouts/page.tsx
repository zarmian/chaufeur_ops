import { PageHeader } from '@/components/page-header';
import { PhasePlaceholder } from '@/components/phase-placeholder';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Payouts' };

export default async function PayoutsPage() {
  await pageRequireCapability('viewInvoices');

  return (
    <>
      <PageHeader
        title="Payouts"
        description="What is owed to drivers."
      />
      <PhasePlaceholder
        phase="Phase 4"
        summary="Payout drafts generated per period from job finance records, PDF statements per driver, and a single transaction that flips every included job to paid."
      />
    </>
  );
}
