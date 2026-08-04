import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ConfigurationError } from '@/components/configuration-error';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getBranding } from '@/lib/branding';
import { checkDatabase } from '@/lib/db-health';
import { isInstallComplete, MIN_PASSWORD_LENGTH } from '@/lib/install';
import { SetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up' };

// Never cached: whether this page exists changes the moment it is used.
export const dynamic = 'force-dynamic';

/**
 * One-time bootstrap for a fresh deployment.
 *
 * Vercel applies migrations during the build, so a new install has tables but
 * no users and therefore no way to sign in. This page creates that first
 * administrator, and disappears the moment one exists.
 */
export default async function SetupPage() {
  // The most likely reason someone reaches /setup on a broken deployment is
  // that the database is not wired up, so say that rather than crashing.
  const database = await checkDatabase();
  if (!database.ok) {
    return (
      <ConfigurationError summary={database.summary} remedy={database.remedy} />
    );
  }

  if (await isInstallComplete()) notFound();

  const branding = await getBranding();

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">{branding.tradingName}</CardTitle>
          <CardDescription>
            First run. Create the administrator account — this page stops
            working as soon as you do.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SetupForm minPasswordLength={MIN_PASSWORD_LENGTH} />
        </CardContent>
      </Card>
    </div>
  );
}
