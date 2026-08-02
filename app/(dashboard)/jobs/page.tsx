import { PageHeader } from '@/components/page-header';
import { PhasePlaceholder } from '@/components/phase-placeholder';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Jobs' };

export default async function JobsPage() {
  await pageRequireCapability('viewJobs');

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Every booking, with the price captured at the point it was taken."
      />
      <PhasePlaceholder
        phase="Phase 2"
        summary="Job creation with client and driver price on the form, a server-paginated list with an unpriced filter, status transitions backed by an event log, and the finance panel."
      />
    </>
  );
}
