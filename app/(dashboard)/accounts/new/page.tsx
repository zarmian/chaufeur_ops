import { PageHeader } from '@/components/page-header';
import { pageRequireCapability } from '@/lib/page-guards';
import { createAccountAction } from '../actions';
import { AccountForm } from '../account-form';

export const metadata = { title: 'New account' };

export default async function NewAccountPage() {
  await pageRequireCapability('editClients');

  return (
    <>
      <PageHeader
        title="New account"
        description="Accounts are the natural unit for consolidated invoicing and account-level margin."
      />
      <AccountForm
        action={createAccountAction}
        submitLabel="Create account"
        cancelHref="/accounts"
      />
    </>
  );
}
