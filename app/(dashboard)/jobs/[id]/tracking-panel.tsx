import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { CopyLink } from './copy-link';

/**
 * The passenger's tracking link, on the job it belongs to.
 *
 * The office needs to be able to hand this to whoever is actually travelling,
 * and that is rarely the same route twice — a booker forwards it, a PA pastes
 * it into a calendar entry, a driver's client asks for it at the kerb. So the
 * panel is a link to copy rather than a button that sends, and the address
 * bar is left to the person who knows where it should go.
 *
 * Shown for every job that can have one. What the page behind it reveals
 * changes with the job's state and is decided in `lib/tracking.ts` — the
 * office does not have to think about whether it is "too early" to send.
 */
export function TrackingPanel({ token }: { token: string }) {
  const path = `/track/${token}`;

  return (
    <div className="mt-6 border-t pt-4" data-testid="tracking-panel">
      <p className="text-sm font-medium">Passenger tracking</p>
      <p className="text-muted-foreground mt-1 text-sm">
        {/*
          Said plainly, because an operator about to send a link to a client
          should know what it does and does not carry. The list is short on
          purpose: no prices, no driver phone number, nothing about any other
          job.
        */}
        Shows the driver, the car and how far away they are once the driver sets
        off. Carries no prices and no phone numbers. Stops answering a few hours
        after the journey.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          {/* `noreferrer` so the token cannot travel in a referrer header if
              the page is opened from here and then linked onward. */}
          <Link href={path} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            Open it
          </Link>
        </Button>

        <CopyLink path={path} testId="copy-tracking-link" />
      </div>
    </div>
  );
}
