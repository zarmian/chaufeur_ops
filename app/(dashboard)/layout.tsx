import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { UserMenu } from '@/components/layout/user-menu';
import { signOutAction } from '@/app/(auth)/actions';
import { setThemePreference } from '@/app/theme-actions';
import { parseThemePreference, THEME_COOKIE } from '@/lib/theme-preference';
import { can, getCurrentUser } from '@/lib/authz';
import { BrandMark } from '@/components/brand-mark';
import { getBranding } from '@/lib/branding-store';
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

  // A temporary password is one somebody else has read. Until it is replaced,
  // the only page this install will render is the one that replaces it —
  // enforced here rather than in middleware, because middleware runs on the
  // edge and cannot see the flag without reaching Postgres.
  if (user.mustChangePassword) {
    const path = (await headers()).get('x-pathname') ?? '';
    if (!path.startsWith('/change-password')) redirect('/change-password');
  }

  const [branding, cookieStore] = await Promise.all([getBranding(), cookies()]);
  const themePreference = parseThemePreference(
    cookieStore.get(THEME_COOKIE)?.value,
  );

  const sections = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(user, item.capability)),
  })).filter((section) => section.items.length > 0);

  return (
    <AppShell
      sections={sections}
      brand={<BrandMark branding={branding} />}
      header={
        <div className="ml-auto flex items-center gap-2">
          <UserMenu
            name={user.name}
            email={user.email}
            role={user.role}
            themePreference={themePreference}
            setThemeAction={setThemePreference}
            signOutAction={signOutAction}
          />
        </div>
      }
    >
      {children}
    </AppShell>
  );
}
