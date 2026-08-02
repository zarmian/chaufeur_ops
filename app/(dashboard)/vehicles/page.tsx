import { PageHeader } from '@/components/page-header';
import { PhasePlaceholder } from '@/components/phase-placeholder';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Vehicles' };

export default async function VehiclesPage() {
  await pageRequireCapability('viewJobs');

  return (
    <>
      <PageHeader
        title="Vehicles"
        description="The fleet, and whether each car is legal to put on a job."
      />
      <PhasePlaceholder
        phase="Phase 1"
        summary="Vehicle records with MOT, insurance and PHV licence expiry, a four-state compliance indicator, and document upload."
      />
    </>
  );
}
