import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { can } from '@/lib/authz';
import { getClient } from '@/lib/clients';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { updateClientAction } from '../../actions';
import { ClientForm } from '../../client-form';

export const metadata = { title: 'Edit client' };

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // ACCOUNTS may edit billing fields, so the gate is the billing capability
  // and the form disables the operational fields they may not touch.
  const user = await pageRequireCapability('editClientBilling');
  const { id } = await params;

  const [client, accounts] = await Promise.all([
    getClient(id),
    prisma.account.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  if (!client) notFound();

  return (
    <>
      <PageHeader
        title={`Edit ${client.name}`}
        description={
          can(user, 'editClients')
            ? undefined
            : 'Your role may edit billing details only. The other fields are read-only.'
        }
      />
      <ClientForm
        action={updateClientAction.bind(null, client.id)}
        accounts={accounts}
        submitLabel="Save changes"
        cancelHref={`/clients/${client.id}`}
        canEditAllFields={can(user, 'editClients')}
        values={{
          name: client.name,
          contactPhone: client.contactPhone ?? '',
          contactChannel: client.contactChannel,
          contactEmail: client.contactEmail ?? '',
          billingEmail: client.billingEmail ?? '',
          billingAddress: client.billingAddress ?? '',
          vatNumber: client.vatNumber ?? '',
          paymentTermsDays: client.paymentTermsDays,
          defaultAccountId: client.defaultAccountId ?? '',
          notes: client.notes ?? '',
        }}
      />
    </>
  );
}
