import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { getAccount } from '@/lib/accounts';
import { pageRequireCapability } from '@/lib/page-guards';
import { updateAccountAction } from '../../actions';
import { AccountForm } from '../../account-form';

export const metadata = { title: 'Edit account' };

export default async function EditAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await pageRequireCapability('editClients');
  const { id } = await params;

  const account = await getAccount(id);
  if (!account) notFound();

  return (
    <>
      <PageHeader title={`Edit ${account.name}`} />
      <AccountForm
        action={updateAccountAction.bind(null, account.id)}
        submitLabel="Save changes"
        cancelHref={`/accounts/${account.id}`}
        values={{
          name: account.name,
          kind: account.kind,
          contactName: account.contactName ?? '',
          contactPhone: account.contactPhone ?? '',
          contactEmail: account.contactEmail ?? '',
          billingEmail: account.billingEmail ?? '',
          billingAddress: account.billingAddress ?? '',
          vatNumber: account.vatNumber ?? '',
          paymentTermsDays: account.paymentTermsDays,
          vatTreatment: account.vatTreatment,
          commissionPct: account.commissionPct?.toString() ?? '',
          active: account.active,
        }}
      />
    </>
  );
}
