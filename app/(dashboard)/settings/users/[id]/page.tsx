import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { StaffTelegramAdminCard } from '@/components/staff-telegram-card';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { getUser } from '@/lib/users';
import { updateUserAction } from '../actions';
import { UserForm } from '../user-form';

export const metadata = { title: 'Edit user' };

export default async function EditUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('manageUsers');
  const [{ id }, query] = await Promise.all([params, searchParams]);
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

      {/* Revoke only — see the note in the route handler. A link is minted by
          its own user, on their own profile, and never travels. */}
      <div className="mt-6 max-w-xl">
        <StaffTelegramAdminCard
          name={user.name}
          linkedAt={user.telegramLinkedAt}
          error={filterValue(query, 'telegramError')}
          action={`/api/settings/users/${id}/telegram`}
        />
      </div>
    </>
  );
}
