import { PageHeader } from '@/components/page-header';
import { PhasePlaceholder } from '@/components/phase-placeholder';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Drivers' };

export default async function DriversPage() {
  await pageRequireCapability('viewJobs');

  return (
    <>
      <PageHeader
        title="Drivers"
        description="The people, their documents and what they are owed."
      />
      <PhasePlaceholder
        phase="Phase 1"
        summary="Driver records with DVLA and PHV expiry dates, a compliance indicator spanning the driver and their assigned vehicle, and document upload."
      />
    </>
  );
}
