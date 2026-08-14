import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { pageRequireCapability } from '@/lib/page-guards';
import { getUser } from '@/lib/users';
import { updateUserAction } from '../actions';
import { UserForm } from '../user-form';

export const metadata = { title: 'Edit user' };

export default async function EditUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await pageRequireCapability('manageUsers');
  const { id } = await params;
  const user = await getUser(id);
  if (!user) notFound();

  return (
    <>
      <PageHeader
        title={user.name}
        description={user.email}
      />
      <UserForm
        action={async (state, formData) => {
          'use server';
          return updateUserAction(id, state, formData);
        }}
        values={{ name: user.name, email: user.email, role: user.role }}
        submitLabel="Save changes"
      />
    </>
  );
}
