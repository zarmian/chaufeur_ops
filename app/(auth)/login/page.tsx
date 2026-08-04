import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ConfigurationError } from '@/components/configuration-error';
import { getCurrentUser } from '@/lib/authz';
import { getBranding } from '@/lib/branding';
import { checkDatabase } from '@/lib/db-health';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Never prerendered.
 *
 * The database check below returns early, before the page touches cookies or
 * `searchParams`. If the build machine cannot reach Postgres — a pooled
 * connection string that only resolves at runtime is enough — Next sees a
 * component with no dynamic dependency and freezes the "not configured yet"
 * screen into the build output. Every visitor then gets that page, from a
 * working install, until someone redeploys. Sign-in depends on live database
 * state by definition, so it is always rendered per request.
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Checked before touching the session, so a misconfigured install explains
  // itself instead of throwing an opaque error at the boundary.
  const database = await checkDatabase();
  if (!database.ok) {
    return (
      <ConfigurationError
        summary={database.summary}
        remedy={database.remedy}
      />
    );
  }

  const existing = await getCurrentUser();
  if (existing) redirect('/');

  const [branding, params] = await Promise.all([
    getBranding(),
    searchParams,
  ]);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{branding.tradingName}</CardTitle>
        <CardDescription>Sign in to continue</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm next={params.next} />
      </CardContent>
    </Card>
  );
}
