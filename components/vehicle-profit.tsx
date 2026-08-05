import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatGBP } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { VehiclePnl } from '@/lib/vehicle-pnl';

/**
 * A vehicle's profit, and the window it was measured over.
 *
 * Two different statements depending on who owns the car, and the layout says
 * which one you are reading rather than leaving it to be inferred from a row
 * of zeroes. A company car nets its running costs; a driver-owned car has
 * none to net, and shows the margin between what the client paid and what the
 * driver was paid.
 */

export function ProfitFigures({
  pnl,
  jobCount,
  rentalCount,
}: {
  pnl: VehiclePnl;
  jobCount: number;
  rentalCount: number;
}) {
  if (pnl.idle) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="pnl-idle">
        Nothing happened on this vehicle in this window — no jobs, no rentals
        and no costs. That is not the same as breaking even.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="pnl-figures">
      <dl className="space-y-1.5 text-sm">
        <Line
          label={`Job revenue${jobCount ? ` · ${jobCount} job${jobCount === 1 ? '' : 's'}` : ''}`}
          pence={pnl.jobRevenuePence}
        />
        {/* Its own line always. A car earning well from hire and badly from
            jobs is a different decision from one earning evenly. */}
        <Line
          label={`Rental revenue${rentalCount ? ` · ${rentalCount} hire${rentalCount === 1 ? '' : 's'}` : ''}`}
          pence={pnl.rentalRevenuePence}
        />
        <Line label="Revenue" pence={pnl.revenuePence} strong />

        <Line label="Driver pay" pence={-pnl.driverPayPence} />
        <Line label="Expenses we bore" pence={-pnl.companyExpensePence} />
        {pnl.costsCounted ? (
          <>
            <Line label="Running costs" pence={-pnl.runningCostPence} />
            <Line
              label="Standing costs, accrued"
              pence={-pnl.standingCostPence}
              testId="pnl-standing"
            />
          </>
        ) : null}

        <div className="flex items-baseline justify-between border-t pt-2">
          <dt className="font-medium">
            {pnl.costsCounted ? 'Profit' : 'Margin to us'}
          </dt>
          <dd
            className={cn(
              'tabular font-semibold',
              pnl.profitPence < 0 ? 'text-destructive' : '',
            )}
          >
            <span data-testid="pnl-profit">{formatGBP(pnl.profitPence)}</span>
            {pnl.marginPct !== null ? (
              <span className="ml-2 font-normal text-muted-foreground">
                {pnl.marginPct}%
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      {!pnl.costsCounted ? (
        <p className="text-xs text-muted-foreground" data-testid="pnl-no-costs">
          This car belongs to its driver, so no running costs are counted
          against it. What is shown is what the company keeps.
        </p>
      ) : null}
    </div>
  );
}

function Line({
  label,
  pence,
  strong,
  testId,
}: {
  label: string;
  pence: number;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cn('text-muted-foreground', strong ? 'font-medium text-foreground' : '')}>
        {label}
      </dt>
      <dd className={cn('tabular', strong ? 'font-medium' : '')} data-testid={testId}>
        {formatGBP(pence)}
      </dd>
    </div>
  );
}

/**
 * The date window, as a plain GET form.
 *
 * A GET rather than a post so the window lives in the URL — a period worth
 * looking at is usually worth sending to somebody else.
 */
export function WindowPicker({
  action,
  from,
  to,
  presets = true,
}: {
  action: string;
  from: string;
  to: string;
  presets?: boolean;
}) {
  const today = new Date();
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const monthsAgo = (months: number) => {
    const date = new Date(today);
    date.setMonth(date.getMonth() - months);
    return iso(date);
  };

  return (
    <div className="mb-6 flex flex-wrap items-end gap-3">
      <form
        method="get"
        action={action}
        className="flex flex-wrap items-end gap-2"
        data-testid="window-picker"
      >
        <div>
          <label htmlFor="from" className="mb-1 block text-xs text-muted-foreground">
            From
          </label>
          <Input id="from" name="from" type="date" defaultValue={from} />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs text-muted-foreground">
            To
          </label>
          <Input id="to" name="to" type="date" defaultValue={to} />
        </div>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      {presets ? (
        <div className="flex flex-wrap gap-2">
          <Preset href={`${action}?from=${monthsAgo(1)}&to=${iso(today)}`} label="Last month" />
          <Preset href={`${action}?from=${monthsAgo(3)}&to=${iso(today)}`} label="Last quarter" />
          <Preset href={action} label="Last 12 months" />
        </div>
      ) : null}
    </div>
  );
}

function Preset({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link href={href}>{label}</Link>
    </Button>
  );
}

/** The service position, shown next to compliance but never blocking. */
export function ServiceBadge({
  due,
  daysRemaining,
  milesRemaining,
}: {
  due: boolean;
  daysRemaining: number | null;
  milesRemaining: number | null;
}) {
  if (due) return <Badge variant="warning">Service due</Badge>;
  const parts: string[] = [];
  if (daysRemaining !== null) parts.push(`${daysRemaining} days`);
  if (milesRemaining !== null) parts.push(`${milesRemaining.toLocaleString()} miles`);
  if (parts.length === 0) return null;
  return (
    <span className="text-xs text-muted-foreground">
      Service in {parts.join(' or ')}
    </span>
  );
}
