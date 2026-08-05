import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { WindowPicker } from '@/components/vehicle-profit';
import { fleetProfit } from '@/lib/fleet';
import { filterValue, type SearchParams } from '@/lib/list-params';
import { formatGBP, sumPence } from '@/lib/money';
import { pageRequireCapability } from '@/lib/page-guards';
import { cn } from '@/lib/utils';
import { OWNERSHIP_LABELS } from '@/lib/vehicle-costs';
import { parsePnlWindow, windowToInputs } from '@/lib/vehicle-pnl';

export const metadata = { title: 'Fleet profit' };

/**
 * Every car, worst first.
 *
 * The question this page exists to answer is "which car is not paying for
 * itself", and the answer is useless if you have to open 195 records to find
 * it. Idle cars sort last: a string of zeroes at the top would bury the one
 * actually losing money.
 */
export default async function FleetPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await pageRequireCapability('viewReports');
  const query = await searchParams;

  const window = parsePnlWindow(
    filterValue(query, 'from'),
    filterValue(query, 'to'),
  );
  const inputs = windowToInputs(window);

  const rows = await fleetProfit(window);

  const companyCars = rows.filter((row) => row.pnl.costsCounted);
  const totals = {
    revenue: sumPence(...rows.map((row) => row.pnl.revenuePence)),
    profit: sumPence(...rows.map((row) => row.pnl.profitPence)),
    // Only company cars carry running costs, so a total that mixed the two
    // would read as though the whole fleet cost that to run.
    running: sumPence(
      ...companyCars.map(
        (row) => row.pnl.runningCostPence + row.pnl.standingCostPence,
      ),
    ),
    losing: rows.filter((row) => !row.pnl.idle && row.pnl.profitPence < 0).length,
  };

  return (
    <>
      <PageHeader
        title="Fleet profit"
        description="What each car made over the window, after what it cost to run and who drove it. Worst first."
      />

      <WindowPicker action="/fleet" from={inputs.from} to={inputs.to} />

      {rows.length === 0 ? (
        <EmptyState
          title="No vehicles on the fleet"
          description="Add the cars first, then their costs. Retired vehicles are left out."
        />
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Revenue" value={formatGBP(totals.revenue)} />
            <Tile
              label="Running costs"
              value={formatGBP(totals.running)}
              hint={`${companyCars.length} company car${companyCars.length === 1 ? '' : 's'}`}
            />
            <Tile
              label="Profit"
              value={formatGBP(totals.profit)}
              tone={totals.profit < 0 ? 'destructive' : undefined}
            />
            <Tile
              label="Losing money"
              value={String(totals.losing)}
              tone={totals.losing > 0 ? 'destructive' : undefined}
              hint="Cars whose costs beat what they earned"
            />
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vehicle</TableHead>
                <TableHead>Held as</TableHead>
                <TableHead className="text-right">Jobs</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Driver pay</TableHead>
                <TableHead className="text-right">Running costs</TableHead>
                <TableHead className="text-right">Profit</TableHead>
                <TableHead className="text-right">Margin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ vehicle, pnl, jobCount }) => (
                <TableRow key={vehicle.id}>
                  <TableCell>
                    <Link
                      href={`/vehicles/${vehicle.id}?from=${inputs.from}&to=${inputs.to}#profit`}
                      className="font-medium tabular hover:underline"
                    >
                      {vehicle.registration}
                    </Link>
                    <span className="ml-2 text-muted-foreground">
                      {vehicle.make} {vehicle.model}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {OWNERSHIP_LABELS[vehicle.ownership]}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {pnl.idle ? '—' : jobCount}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {pnl.idle ? '—' : formatGBP(pnl.revenuePence)}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {pnl.idle ? '—' : formatGBP(pnl.driverPayPence)}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {/* Never a zero on a driver's own car: zero would claim we
                        checked and it cost nothing. It is simply not ours. */}
                    {pnl.costsCounted
                      ? formatGBP(pnl.runningCostPence + pnl.standingCostPence)
                      : '—'}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular font-medium',
                      !pnl.idle && pnl.profitPence < 0 ? 'text-destructive' : '',
                    )}
                  >
                    {pnl.idle ? (
                      <Badge variant="secondary">No activity</Badge>
                    ) : (
                      formatGBP(pnl.profitPence)
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular text-muted-foreground">
                    {pnl.marginPct === null ? '—' : `${pnl.marginPct}%`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <p className="mt-4 text-sm text-muted-foreground">
            A driver&rsquo;s own car shows the margin the company keeps, not a
            profit after running it — those costs are its owner&rsquo;s.
          </p>
        </>
      )}
    </>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'destructive';
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p
          className={cn(
            'mt-1 text-2xl font-semibold tabular',
            tone === 'destructive' ? 'text-destructive' : '',
          )}
        >
          {value}
        </p>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
