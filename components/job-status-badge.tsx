import type { JobStatus } from '@prisma/client';
import { Badge } from '@/components/ui/badge';
import { STATUS_LABELS } from '@/lib/job-status';

/**
 * Status as a colour the dispatcher can scan a column of.
 *
 * `CANCELLED` and `NO_SHOW` are deliberately not both red: a cancellation is
 * routine, a no-show costs the operator a driver's morning and someone
 * usually needs to chase it.
 */
const VARIANT: Record<
  JobStatus,
  'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline'
> = {
  DRAFT: 'outline',
  PENDING: 'secondary',
  ASSIGNED: 'default',
  ACCEPTED: 'default',
  IN_PROGRESS: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'secondary',
  NO_SHOW: 'destructive',
};

export function JobStatusBadge({
  status,
  className,
  ...props
}: {
  status: JobStatus;
  className?: string;
} & React.ComponentProps<'span'>) {
  return (
    <Badge variant={VARIANT[status]} className={className} {...props}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
