import { Download } from 'lucide-react';
import Link from 'next/link';
import { ComplianceBadge } from '@/components/compliance-badge';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  buildComplianceReport,
  type ExpiringRow,
} from '@/lib/compliance-report';
import { formatDate } from '@/lib/dates';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { pageRequireCapability } from '@/lib/page-guards';
import { getComplianceThresholds } from '@/lib/settings';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Compliance' };

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('viewJobs');
  const params = await searchParams;

  const thresholds = await getComplianceThresholds();
  const report = await buildComplianceReport(thresholds);

  const only = filterValue(params, 'level');
  const kind = filterValue(params, 'kind');

  const dated = [...report.expired, ...report.critical, ...report.warning];
  const visible = (only === 'unknown' ? report.unknownExpiry : dated)
    .filter((row) => (only && only !== 'unknown' ? row.level === only : true))
    .filter((row) => (kind ? row.kind === kind : true));

  const tiles = [
    {
      key: 'expired',
      label: 'Expired',
      count: report.counts.expired,
      tone: 'destructive' as const,
      hint: 'Cannot be assigned',
    },
    {
      key: 'critical',
      label: `Within ${thresholds.criticalDays} days`,
      count: report.counts.critical,
      tone: 'destructive' as const,
      hint: 'Chase now',
    },
    {
      key: 'warning',
      label: `Within ${thresholds.warningDays} days`,
      count: report.counts.warning,
      tone: 'warning' as const,
      hint: 'Plan the renewal',
    },
    {
      key: 'unknown',
      label: 'Expiry not recorded',
      count: report.counts.unknownExpiry,
      tone: 'muted' as const,
      hint: 'Counts as non-compliant',
    },
  ];

  return (
    <>
      <PageHeader
        title="Compliance"
        description="Every lapsing or undated requirement across drivers and vehicles. Retired vehicles and inactive drivers are left out."
        actions={
          <Button asChild variant="outline">
            <Link href="/api/compliance/export">
              <Download aria-hidden />
              Export
            </Link>
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Link
            key={tile.key}
            href={`/compliance?level=${tile.key}`}
            className="block rounded-lg border p-4 transition-colors hover:bg-accent"
          >
            <p className="text-sm text-muted-foreground">{tile.label}</p>
            <p
              className={cn(
                'mt-1 text-3xl font-semibold tabular',
                tile.count === 0
                  ? 'text-muted-foreground'
                  : tile.tone === 'destructive'
                    ? 'text-destructive'
                    : tile.tone === 'warning'
                      ? 'text-warning-foreground'
                      : '',
              )}
            >
              {tile.count}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{tile.hint}</p>
          </Link>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterLink href="/compliance" active={!only && !kind} label="Everything" />
        <FilterLink
          href="/compliance?level=expired"
          active={only === 'expired'}
          label="Expired"
        />
        <FilterLink
          href="/compliance?level=unknown"
          active={only === 'unknown'}
          label="No expiry recorded"
        />
        <FilterLink
          href="/compliance?kind=DRIVER"
          active={kind === 'DRIVER'}
          label="Drivers"
        />
        <FilterLink
          href="/compliance?kind=VEHICLE"
          active={kind === 'VEHICLE'}
          label="Vehicles"
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={
            report.counts.expired +
              report.counts.critical +
              report.counts.warning +
              report.counts.unknownExpiry ===
            0
              ? 'Everything is in date'
              : 'Nothing matches that filter'
          }
          description={
            only || kind
              ? 'Clear the filter to see the rest.'
              : 'Every driver and vehicle has current documents with recorded expiry dates.'
          }
          action={
            only || kind ? (
              <Button asChild variant="outline">
                <Link href="/compliance">Clear filter</Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Who</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Days</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <ReportRow key={`${row.id}-${row.documentType}`} row={row} />
              ))}
            </TableBody>
          </Table>

          {/* Kept visibly separate: unknown is a gap in the records, not a
              severity, and mixing the two hides how many are simply unknown. */}
          {!only && report.unknownExpiry.length > 0 ? (
            <Card className="mt-6">
              <CardContent className="p-4">
                <p className="text-sm font-medium">
                  {report.unknownExpiry.length} requirement
                  {report.unknownExpiry.length === 1 ? '' : 's'} with no expiry
                  date recorded
                </p>
                <p className="mb-3 text-sm text-muted-foreground">
                  These count as non-compliant. A document without a date cannot
                  be assumed valid.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Who</TableHead>
                      <TableHead>Document</TableHead>
                      <TableHead>State</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.unknownExpiry.map((row) => (
                      <TableRow key={`${row.id}-${row.documentType}`}>
                        <TableCell>
                          <Link href={row.href} className="font-medium hover:underline">
                            {row.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {row.documentLabel}
                        </TableCell>
                        <TableCell>
                          <ComplianceBadge level="unknown" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}

function ReportRow({ row }: { row: ExpiringRow }) {
  return (
    <TableRow>
      <TableCell>
        <Link href={row.href} className="font-medium hover:underline">
          {row.name}
        </Link>
        {row.reference ? (
          <span className="ml-2 tabular text-xs text-muted-foreground">
            {row.reference}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground">{row.documentLabel}</TableCell>
      <TableCell className="tabular">
        {row.expiresOn ? formatDate(row.expiresOn) : '—'}
      </TableCell>
      <TableCell
        className={cn(
          'text-right tabular',
          row.daysRemaining !== null && row.daysRemaining < 0
            ? 'font-semibold text-destructive'
            : 'text-muted-foreground',
        )}
      >
        {row.daysRemaining === null ? '—' : row.daysRemaining}
      </TableCell>
      <TableCell>
        <ComplianceBadge level={row.level} />
      </TableCell>
    </TableRow>
  );
}

function FilterLink({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Button asChild variant={active ? 'default' : 'outline'} size="sm">
      <Link href={href}>{label}</Link>
    </Button>
  );
}
