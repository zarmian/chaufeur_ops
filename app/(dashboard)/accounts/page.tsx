import { PageHeader } from '@/components/page-header';
import { PhasePlaceholder } from '@/components/phase-placeholder';
import { pageRequireCapability } from '@/lib/page-guards';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage() {
  await pageRequireCapability('viewJobs');

  return (
    <>
      <PageHeader
        title="Accounts"
        description="The bookers who get invoiced. Not the same as the client."
      />
      <PhasePlaceholder
        phase="Phase 1"
        summary="Account records for internal, agency, corporate and individual bookers, each with payment terms, a rate card and account-level margin."
      />
    </>
  );
}
