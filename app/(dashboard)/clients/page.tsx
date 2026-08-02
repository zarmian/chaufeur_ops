import { PageHeader } from '@/components/page-header';
import { PhasePlaceholder } from '@/components/phase-placeholder';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Clients' };

export default async function ClientsPage() {
  await pageRequireCapability('viewJobs');

  return (
    <>
      <PageHeader
        title="Clients"
        description="The people who ride."
      />
      <PhasePlaceholder
        phase="Phase 1"
        summary="Client master records with contact and billing details, duplicate detection on a normalised name, and job history with lifetime revenue."
      />
    </>
  );
}
