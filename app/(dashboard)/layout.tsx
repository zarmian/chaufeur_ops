import { redirect } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { UserMenu } from '@/components/layout/user-menu';
import { signOutAction } from '@/app/(auth)/actions';
import { can, getCurrentUser } from '@/lib/authz';
import { getBranding } from '@/lib/branding';
import { NAVIGATION } from '@/lib/navigation';

/**
 * The authoritative auth check for every dashboard route.
 *
 * `middleware.ts` also redirects, but it only sees whether a session cookie
 * exists — it runs on the edge and cannot reach Postgres. This layout is
 * what actually resolves the session, so a forged or revoked cookie gets no
 * further than here.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const branding = await getBranding();

  const sections = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(user, item.capability)),
  })).filter((section) => section.items.length > 0);

  return (
    <AppShell
      sections={sections}
      brand={
        <span className="text-sm font-semibold tracking-tight">
          {branding.tradingName}
        </span>
      }
      header={
        <div className="ml-auto flex items-center gap-2">
          <UserMenu
            name={user.name}
            email={user.email}
            role={user.role}
            signOutAction={signOutAction}
          />
        </div>
      }
    >
      {children}
    </AppShell>
  );
}
