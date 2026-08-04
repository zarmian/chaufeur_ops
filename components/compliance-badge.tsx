import { Badge } from '@/components/ui/badge';
import {
  LEVEL_BADGE,
  type ComplianceItem,
  type ComplianceLevel,
} from '@/lib/compliance';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/utils';

/**
 * The four-state indicator, plus the fifth state that matters most.
 *
 * Green, amber, red, black is what the spec asks for. "No expiry recorded"
 * gets its own treatment rather than being folded into one of those, because
 * an unrecorded date is a different problem from a lapsed one — it means
 * nobody knows, and it is the exact state the legacy system left every
 * document in.
 */
export function ComplianceBadge({
  level,
  className,
}: {
  level: ComplianceLevel;
  className?: string;
}) {
  const { label, variant } = LEVEL_BADGE[level];
  return (
    <Badge
      variant={variant}
      className={cn(
        // Expired is the most serious state and must not look like merely
        // "expiring", so it is filled rather than outlined.
        level === 'expired' && 'font-semibold',
        className,
      )}
    >
      {label}
    </Badge>
  );
}

/** The requirement-by-requirement breakdown, for a detail page. */
export function ComplianceItems({ items }: { items: ComplianceItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No compliance requirements recorded.
      </p>
    );
  }

  return (
    <ul className="divide-y">
      {items.map((item) => (
        <li
          key={item.label}
          className="flex items-center justify-between gap-4 py-2.5"
        >
          <div>
            <p className="text-sm font-medium">{item.label}</p>
            <p className="text-xs text-muted-foreground tabular">
              {item.expiresOn
                ? `Expires ${formatDate(item.expiresOn)}${
                    item.daysRemaining !== null
                      ? ` · ${describeDays(item.daysRemaining)}`
                      : ''
                  }`
                : 'No expiry date recorded'}
            </p>
          </div>
          <ComplianceBadge level={item.level} />
        </li>
      ))}
    </ul>
  );
}

function describeDays(days: number): string {
  if (days < 0) {
    const ago = Math.abs(days);
    return `${ago} day${ago === 1 ? '' : 's'} ago`;
  }
  if (days === 0) return 'today';
  return `in ${days} day${days === 1 ? '' : 's'}`;
}
