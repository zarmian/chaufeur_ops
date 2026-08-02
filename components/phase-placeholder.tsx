import { Construction } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

/**
 * A route that exists so navigation works, with the feature itself scheduled
 * for a later phase. Every one of these names the phase that fills it in, so
 * an empty screen is never mistaken for a broken one.
 */
export function PhasePlaceholder({
  phase,
  summary,
}: {
  phase: string;
  summary: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-4 p-6">
        <Construction
          className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="space-y-1">
          <p className="text-sm font-medium">Arrives in {phase}</p>
          <p className="text-sm text-muted-foreground">{summary}</p>
        </div>
      </CardContent>
    </Card>
  );
}
