import { PageHeader } from '@/components/page-header';
import { PhasePlaceholder } from '@/components/phase-placeholder';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Reports' };

export default async function ReportsPage() {
  await pageRequireCapability('viewReports');

  return (
    <>
      <PageHeader
        title="Reports"
        description="Revenue, cost and margin — with the unpriced count beside them."
      />
      <PhasePlaceholder
        phase="Phase 4"
        summary="Filtered summaries with breakdowns by job type, client, account, driver and vehicle, aggregated in SQL, exported to Excel and PDF."
      />
    </>
  );
}
