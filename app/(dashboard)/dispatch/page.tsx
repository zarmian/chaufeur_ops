import { PageHeader } from '@/components/page-header';
import { PhasePlaceholder } from '@/components/phase-placeholder';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Dispatch' };

export default async function DispatchPage() {
  await pageRequireCapability('dispatch');

  return (
    <>
      <PageHeader
        title="Dispatch"
        description="The day's work, by driver."
      />
      <PhasePlaceholder
        phase="Phase 6"
        summary="A horizontal timeline with drivers down the side and hours across the top, drag-to-assign with compliance and conflict checks, and live status from the driver bot."
      />
    </>
  );
}
