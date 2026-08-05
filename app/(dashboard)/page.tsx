import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { buildComplianceReport } from '@/lib/compliance-report';
import { countUnpricedCompleted } from '@/lib/jobs';
import { pageRequireUser } from '@/lib/page-guards';
import { prisma } from '@/lib/prisma';
import { getComplianceThresholds, getSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const user = await pageRequireUser();

  const [thresholds, settings] = await Promise.all([
    getComplianceThresholds(),
    getSettings(),
  ]);
  const [report, counts, unpricedCompleted] = await Promise.all([
    buildComplianceReport(thresholds),
    Promise.all([
      prisma.driver.count({ where: { status: 'ACTIVE' } }),
      prisma.vehicle.count({ where: { status: 'ACTIVE' } }),
      prisma.client.count(),
    ]),
    countUnpricedCompleted(),
  ]);

  const [activeDrivers, activeVehicles, clients] = counts;
  const blocking = report.counts.expired + report.counts.unknownExpiry;

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name.split(' ')[0]}`}
        description="Compliance first — it is the one thing that stops a job going out."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          href="/compliance?level=expired"
          label="Expired"
          value={report.counts.expired}
          hint="Cannot be assigned to a job"
          tone={report.counts.expired > 0 ? 'destructive' : 'ok'}
        />
        <Tile
          href="/compliance?level=unknown"
          label="No expiry recorded"
          value={report.counts.unknownExpiry}
          hint="Counts as non-compliant"
          tone={report.counts.unknownExpiry > 0 ? 'destructive' : 'ok'}
        />
        <Tile
          href="/compliance?level=critical"
          label={`Expiring within ${thresholds.criticalDays} days`}
          value={report.counts.critical}
          hint="Chase these now"
          tone={report.counts.critical > 0 ? 'warning' : 'ok'}
        />
        <Tile
          href="/compliance?level=warning"
          label={`Expiring within ${thresholds.warningDays} days`}
          value={report.counts.warning}
          hint="Plan the renewal"
          tone="muted"
        />
      </div>

      {unpricedCompleted > 0 ? (
        <Card
          className={cn(
            'mb-6',
            // Red once the backlog is big enough to be a reporting problem
            // rather than a couple of jobs someone is mid-way through.
            unpricedCompleted >= settings.unpricedAlertThreshold
              ? 'border-destructive/50 bg-destructive/5'
              : 'border-warning/50 bg-warning/5',
          )}
          data-testid="unpriced-tile"
        >
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <div>
              <p
                className={cn(
                  'text-sm font-medium',
                  unpricedCompleted >= settings.unpricedAlertThreshold &&
                    'text-destructive',
                )}
              >
                {unpricedCompleted} completed job
                {unpricedCompleted === 1 ? '' : 's'} without a price
              </p>
              <p className="text-sm text-muted-foreground">
                Work that was delivered and never billed. These are invisible to
                every revenue report until someone prices them.
              </p>
            </div>
            <Link
              href="/jobs?unpriced=true&all=true&status=COMPLETED"
              className="inline-flex shrink-0 items-center gap-1 text-sm font-medium hover:underline"
            >
              Price them
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </CardContent>
        </Card>
      ) : null}

      {blocking > 0 ? (
        <Card className="mb-6 border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="text-sm font-medium text-destructive">
                {blocking} requirement{blocking === 1 ? '' : 's'} would block an
                assignment today
              </p>
              <p className="text-sm text-muted-foreground">
                A lapsed badge or an undated licence stops the driver going out.
                This is the number that protects the operator licence.
              </p>
            </div>
            <Link
              href="/compliance"
              className="flex shrink-0 items-center gap-1 text-sm font-medium underline"
            >
              Review
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Tile href="/drivers" label="Active drivers" value={activeDrivers} tone="muted" />
        <Tile href="/vehicles" label="Active vehicles" value={activeVehicles} tone="muted" />
        <Tile href="/clients" label="Clients" value={clients} tone="muted" />
      </div>

      <Card className="mt-6 max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">What lands here next</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Phase 2</span> —
            completed jobs with no price, and today&rsquo;s job count.
          </p>
          <p>
            <span className="font-medium text-foreground">Phase 6</span> —
            unassigned work in the next 24 hours, overdue invoices, revenue and
            gross profit for the month.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

function Tile({
  href,
  label,
  value,
  hint,
  tone,
}: {
  href: string;
  label: string;
  value: number;
  hint?: string;
  tone: 'destructive' | 'warning' | 'muted' | 'ok';
}) {
  return (
    <Link
      href={href}
      className="block rounded-lg border p-4 transition-colors hover:bg-accent"
    >
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 text-3xl font-semibold tabular',
          value === 0
            ? 'text-muted-foreground'
            : tone === 'destructive'
              ? 'text-destructive'
              : tone === 'warning'
                ? 'text-warning-foreground'
                : '',
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </Link>
  );
}
