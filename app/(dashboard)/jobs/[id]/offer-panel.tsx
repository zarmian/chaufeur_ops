import { AlertCircle, Radio } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * Putting one job to several drivers at once.
 *
 * The counterpart to the assign picker, not a replacement for it. A named
 * driver on a repeat client's regular booking is still chosen by hand; this is
 * for the other case — a job that has to be covered soon, by somebody, and
 * ringing round twenty owner-drivers takes longer than the job is worth.
 *
 * Deliberately not offered on a job that already has a driver. An offer for
 * work somebody is already doing produces exactly one outcome, which is a
 * phone call to the office.
 *
 * Plain forms, no client state: two buttons that post and come back. See the
 * note in `app/api/jobs/[id]/status/route.ts` for why these are route handlers
 * rather than Server Actions.
 */
export function OfferPanel({
  jobId,
  live,
  message,
  error,
}: {
  jobId: string;
  /** How many drivers are still holding an Accept button. */
  live: number;
  message?: string | null;
  error?: string | null;
}) {
  return (
    <div className="space-y-3">
      {error ? (
        <Alert variant="destructive" data-testid="offer-error">
          <AlertCircle aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {message ? (
        <Alert data-testid="offer-message">
          <Radio aria-hidden />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

      {live > 0 ? (
        <>
          <p className="text-sm text-muted-foreground" data-testid="offer-live">
            Out with {live} driver{live === 1 ? '' : 's'}. The first to accept
            takes it.
          </p>
          <form method="post" action={`/api/jobs/${jobId}/offer`}>
            <input type="hidden" name="intent" value="withdraw" />
            <Button type="submit" variant="outline" size="sm">
              Withdraw the offer
            </Button>
          </form>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Send this job to every linked, compliant driver. The first to accept
            takes it, and the rest are told it has gone.
          </p>
          <form method="post" action={`/api/jobs/${jobId}/offer`}>
            <Button type="submit" size="sm" data-testid="offer-job">
              Offer to available drivers
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
