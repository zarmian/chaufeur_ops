import { Plus } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { listUsers, ROLE_DESCRIPTIONS } from '@/lib/users';
import { resetPasswordAction, setUserActiveAction } from './actions';
import { ActiveToggle, ResetPasswordButton } from './user-actions';

export const metadata = { title: 'Users' };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const me = await pageRequireCapability('manageUsers');
  const [users, query] = await Promise.all([listUsers(), searchParams]);

  return (
    <>
      <PageHeader
        title="Users"
        description="Who can sign in, and what they may do. Drivers are not users — they have no dashboard login and reach the system through the Telegram bot."
        actions={
          <Button asChild>
            <Link href="/settings/users/new">
              <Plus className="mr-1 size-4" />
              Add user
            </Link>
          </Button>
        }
      />

      {filterValue(query, 'updated') ? (
        <Alert className="mb-4">
          <AlertDescription>That user has been updated.</AlertDescription>
        </Alert>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Last signed in</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id} className={user.active ? undefined : 'opacity-60'}>
              <TableCell>
                <Link href={`/settings/users/${user.id}`} className="font-medium hover:underline">
                  {user.name}
                </Link>
                {user.id === me.id ? (
                  <span className="ml-2 text-sm text-muted-foreground">(you)</span>
                ) : null}
                <p className="text-sm text-muted-foreground">{user.email}</p>
              </TableCell>

              <TableCell>
                <Badge variant={user.role === 'ADMIN' ? 'default' : 'secondary'}>
                  {user.role.charAt(0) + user.role.slice(1).toLowerCase()}
                </Badge>
                {!user.active ? (
                  <Badge variant="destructive" className="ml-2">
                    Deactivated
                  </Badge>
                ) : null}
                {user.mustChangePassword ? (
                  <Badge variant="warning" className="ml-2">
                    Password not set
                  </Badge>
                ) : null}
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {ROLE_DESCRIPTIONS[user.role]}
                </p>
              </TableCell>

              <TableCell className="text-muted-foreground">
                {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}
              </TableCell>

              <TableCell>
                <div className="flex flex-col items-end gap-2">
                  <ResetPasswordButton
                    name={user.name}
                    action={resetPasswordAction.bind(null, user.id)}
                  />
                  <ActiveToggle
                    name={user.name}
                    active={user.active}
                    action={setUserActiveAction.bind(null, user.id, !user.active)}
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
