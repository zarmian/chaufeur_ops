import { Badge } from '@/components/ui/badge';

/**
 * The red "No price" marker that stands in for an amount.
 *
 * It occupies the price column rather than sitting beside it, so an unpriced
 * job cannot be skimmed past as though it were cheap. In the legacy system
 * the same job rendered as a blank cell, and 140 of 141 jobs were blank —
 * which is exactly how nobody noticed.
 */
export function UnpricedBadge({ className }: { className?: string }) {
  return (
    <Badge variant="destructive" className={className} data-testid="unpriced-badge">
      No price
    </Badge>
  );
}
