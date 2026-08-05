'use client';

import type { JobStatus } from '@prisma/client';
import { AlertCircle } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { STATUS_LABELS, ZERO_VALUE_REASONS } from '@/lib/job-status';

/**
 * The status control offers only the legal next steps (spec 2.3.2).
 *
 * Rendering every status and rejecting most of them teaches people that the
 * buttons lie. The server still re-checks — this list is convenience, not
 * security — but the two agree, so a refusal here is always about the *data*
 * (no price, lapsed badge) rather than about the shape of the workflow.
 *
 * This posts to a route handler rather than calling a Server Action — see the
 * note in `app/api/jobs/[id]/status/route.ts` for why. The outcome comes back
 * in the query string, so the badge, the timeline and the next legal steps are
 * always the ones that exist now, and a refusal can be linked to.
 *
 * It stays a Client Component only for the zero-value prompt, which needs to
 * react to the selected status. The form itself works without JavaScript.
 */
export function StatusControl({
  jobId,
  allowed,
  needsZeroValueReason,
  error,
}: {
  jobId: string;
  allowed: JobStatus[];
  /** True when completing would currently be refused for want of a price. */
  needsZeroValueReason: boolean;
  /** A refusal from the previous attempt, read from the query string. */
  error?: string | null;
}) {
  const [next, setNext] = useState<string>(allowed[0] ?? '');
  const [reason, setReason] = useState('');

  if (allowed.length === 0) {
    return (
      <>
        {error ? <StatusError message={error} /> : null}
        <p className="text-sm text-muted-foreground">
          This job has reached a final status and cannot be changed.
        </p>
      </>
    );
  }

  // Only asked for when it is actually the blocker, so a priced job never
  // sees a zero-value prompt.
  const askForReason = next === 'COMPLETED' && needsZeroValueReason;

  return (
    <form
      method="post"
      action={`/api/jobs/${jobId}/status`}
      className="space-y-3"
    >
      {error ? <StatusError message={error} /> : null}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-44">
          <label htmlFor="status" className="mb-1.5 block text-sm font-medium">
            Move to
          </label>
          <Select
            id="status"
            name="status"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          >
            {allowed.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit">Update status</Button>
      </div>

      {askForReason ? (
        <div
          className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3"
          data-testid="zero-value-prompt"
        >
          <p className="text-sm font-medium">
            This job has no price. Record why before completing it.
          </p>
          <div className="flex flex-wrap gap-2">
            {ZERO_VALUE_REASONS.map((preset) => (
              <Button
                key={preset}
                type="button"
                size="sm"
                variant={reason === preset ? 'default' : 'outline'}
                onClick={() => setReason(preset)}
              >
                {preset}
              </Button>
            ))}
          </div>
          <Input
            name="zeroValueReason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Or type a reason"
            aria-label="Zero value reason"
            required
          />
        </div>
      ) : null}
    </form>
  );
}

function StatusError({ message }: { message: string }) {
  return (
    <Alert variant="destructive" data-testid="status-error">
      <AlertCircle aria-hidden />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
