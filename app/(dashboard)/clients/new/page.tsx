import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { pageRequireCapability } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { createClientAction } from '../actions';
import { ClientForm } from '../client-form';

export const metadata = { title: 'New client' };

export default async function NewClientPage() {
  await pageRequireCapability('editClients');

  const accounts = await prisma.account.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  return (
    <>
      <PageHeader
        title="New client"
        description={
          <>
            Already have them? Check{' '}
            <Link href="/clients" className="underline">
              the client list
            </Link>{' '}
            first — duplicates are flagged on save, but not blocked.
          </>
        }
      />
      <ClientForm
        action={createClientAction}
        accounts={accounts}
        submitLabel="Create client"
        cancelHref="/clients"
        canEditAllFields
      />
    </>
  );
}
