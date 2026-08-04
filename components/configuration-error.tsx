import { AlertTriangle } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * What a misconfigured deployment shows instead of a blank crash.
 *
 * This is a white-label product installed repeatedly by people who did not
 * write it, so the first thing a broken install says matters. It names the
 * problem and the fix, and never the connection string.
 */
export function ConfigurationError({
  summary,
  remedy,
}: {
  summary: string;
  remedy: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-destructive"
              aria-hidden
            />
            <div>
              <CardTitle className="text-lg">Not configured yet</CardTitle>
              <CardDescription>{summary}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>{remedy}</p>
          <p className="text-muted-foreground">
            <code className="rounded bg-muted px-1 py-0.5">/api/health</code>{' '}
            reports the same check as JSON, and{' '}
            <code className="rounded bg-muted px-1 py-0.5">
              docs/deployment.md
            </code>{' '}
            lists the failure modes in full.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
