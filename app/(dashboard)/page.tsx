import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { pageRequireUser } from '@/lib/page-guards';

export const metadata = { title: 'Dashboard' };

/**
 * Placeholder. The real tiles — unpriced jobs, expiring documents,
 * unassigned work, revenue — arrive with the data behind them in Phases 1,
 * 2 and 6. A tile showing zero because the feature does not exist yet is
 * worse than no tile.
 */
export default async function DashboardPage() {
  const user = await pageRequireUser();

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name.split(' ')[0]}`}
        description="Foundation is in place. Operational tiles arrive with the records they count."
      />

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">What lands here next</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Phase 1</span> —
            documents expiring, split into expired, critical and warning.
          </p>
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
