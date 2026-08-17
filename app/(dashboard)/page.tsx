import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { TrendChart } from '@/components/trend-chart';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { can } from '@/lib/authz';
import { loadDashboard, type DashboardTile } from '@/lib/dashboard';
import { getLocaleConfig } from '@/lib/locale-store';
import { formatMoney } from '@/lib/money';
import { pageRequireUser } from '@/lib/page-guards';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Dashboard' };

/**
 * What somebody wants on opening the app — spec 6.6.
 *
 * Every tile links to the view that explains it. A number with nowhere to go
 * is a number people learn to ignore, and the whole point of the unpriced
 * tile is that somebody clicks it.
 *
 * Money is role-filtered in `loadDashboard` rather than here, so a second
 * caller cannot forget.
 */
export default async function DashboardPage() {
  const user = await pageRequireUser();
  const seesMoney = can(user, 'viewRevenue');

  const [dashboard, locale] = await Promise.all([
    loadDashboard({ seesMoney }),
    getLocaleConfig(),
  ]);

  const money = (pence: number) =>
    formatMoney(pence, { currency: locale.currency, locale: locale.locale });

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name.split(' ')[0]}`}
        description="Today, this week, and anything that needs somebody."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {dashboard.tiles.map((tile) => (
          <Tile key={tile.key} tile={tile} />
        ))}
      </div>

      {seesMoney ? (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Last twelve months</CardTitle>
            </CardHeader>
            <CardContent>
              {dashboard.trend.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing to chart yet.
                </p>
              ) : (
                <TrendChart points={dashboard.trend} />
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Leaderboard
              title={`Top clients — ${dashboard.monthLabel}`}
              href="/reports?dimension=client"
              rows={dashboard.topClients}
              money={money}
            />
            <Leaderboard
              title={`Top drivers — ${dashboard.monthLabel}`}
              href="/reports?dimension=driver"
              rows={dashboard.topDrivers}
              money={money}
            />
          </div>
        </>
      ) : null}
    </>
  );
}

function Tile({ tile }: { tile: DashboardTile }) {
  return (
    <Link
      href={tile.href}
      className="press-surface group block rounded-lg border bg-card p-4 shadow-chip hover:bg-accent hover:shadow-panel"
      data-testid={`tile-${tile.key}`}
    >
      <p className="flex items-center gap-1 text-sm text-muted-foreground">
        {tile.label}
        {/*
          A tile is a door, and the arrow leans towards it before you have
          committed. Intermediate motion that points at the outcome is what
          lets somebody predict where a click goes without reading the label
          twice — and every tile here goes somewhere, which is the whole
          reason the numbers are worth showing.
        */}
        <ChevronRight
          className="size-3.5 -translate-x-1 opacity-0 transition-[transform,opacity] duration-fast ease-out group-hover:translate-x-0 group-hover:opacity-100"
          aria-hidden
        />
      </p>
      <p
        className={cn(
          'mt-1 text-3xl font-semibold tabular',
          // Spec 6.6.3. Amber and red are configured thresholds, not
          // decoration — a tile that is always coloured says nothing.
          tile.tone === 'destructive'
            ? 'text-destructive'
            : tile.tone === 'warning'
              ? 'text-warning-foreground'
              : tile.tone === 'ok'
                ? 'text-muted-foreground'
                : '',
        )}
      >
        {tile.value}
      </p>
      {tile.hint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{tile.hint}</p>
      ) : null}
    </Link>
  );
}

/**
 * Top five by revenue — spec 6.6.5.
 *
 * Margin alongside revenue, because a client billing a lot at no margin is
 * the finding worth acting on and a revenue-only list puts them at the top
 * looking like success.
 */
function Leaderboard({
  title,
  href,
  rows,
  money,
}: {
  title: string;
  href: string;
  rows: Array<{
    id: string | null;
    label: string;
    jobs: number;
    revenuePence: number;
    marginPct: number | null;
  }>;
  money: (pence: number) => string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-baseline justify-between text-base">
          {title}
          <Link href={href} className="text-xs font-normal underline">
            All
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing billed this month yet.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {rows.map((row) => (
              <li
                key={row.id ?? row.label}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="shrink-0 tabular">
                  {money(row.revenuePence)}
                  {row.marginPct === null ? null : (
                    <span
                      className={cn(
                        'ml-2 text-xs',
                        row.marginPct < 0
                          ? 'text-destructive'
                          : 'text-muted-foreground',
                      )}
                    >
                      {row.marginPct.toFixed(0)}%
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
