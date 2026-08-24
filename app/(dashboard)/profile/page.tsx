import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { StaffTelegramCard } from '@/components/staff-telegram-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { ROLE_DESCRIPTIONS } from '@/lib/users';
import { getUser } from '@/lib/users';
import { getTelegramConfig } from '@/lib/telegram/config';

export const metadata = { title: 'Your profile' };

/**
 * The screen a staff member manages their own access from.
 *
 * Guarded by `viewJobs` — the weakest capability every role holds — because
 * this is the only route to the staff Telegram link, and the admin bot serves
 * OPS and ACCOUNTS as much as it serves administrators. Behind `manageUsers`
 * it would be an administrator-only feature by accident: everyone else would
 * be told by the bot to link their account and have nowhere to do it.
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await pageRequireCapability('viewJobs');
  const [user, telegram, query] = await Promise.all([
    getUser(session.id),
    getTelegramConfig(),
    searchParams,
  ]);

  // The session resolved a moment ago, so this is all but unreachable — but
  // `getUser` can return null for an account deleted mid-request, and a
  // non-null assertion here would crash the page rather than sign them out.
  if (!user) {
    return (
      <PageHeader
        title="Your profile"
        description="This account no longer exists. Sign out and back in."
      />
    );
  }

  return (
    <>
      <PageHeader
        title={user.name}
        description={user.email}
        actions={
          <Button asChild variant="outline">
            <Link href="/change-password">
              <KeyRound aria-hidden />
              Change password
            </Link>
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Access</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant={user.role === 'ADMIN' ? 'default' : 'secondary'}>
                {user.role.charAt(0) + user.role.slice(1).toLowerCase()}
              </Badge>
              {!user.active ? <Badge variant="destructive">Deactivated</Badge> : null}
            </div>
            <p className="text-muted-foreground">{ROLE_DESCRIPTIONS[user.role]}</p>
            <p className="text-muted-foreground">
              Last signed in{' '}
              {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'never'}.
            </p>
            <p className="text-xs text-muted-foreground">
              Only an administrator can change your role. Ask one if this is wrong.
            </p>
          </CardContent>
        </Card>

        <StaffTelegramCard
          linkedAt={user.telegramLinkedAt}
          url={filterValue(query, 'telegramUrl')}
          token={filterValue(query, 'telegramToken')}
          expiresAt={filterValue(query, 'telegramExpires')}
          error={filterValue(query, 'telegramError')}
          botConfigured={Boolean(telegram.adminBotUsername)}
          action="/api/profile/telegram"
        />
      </div>
    </>
  );
}
