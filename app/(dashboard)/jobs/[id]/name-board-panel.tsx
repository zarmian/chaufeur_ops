import { ExternalLink, Printer } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { nameBoardPath } from '@/lib/name-board';
import { CopyLink } from './copy-link';

/**
 * The meet-and-greet board, on the job it belongs to.
 *
 * Three ways out, because three different people need it. The driver taps the
 * link from their Telegram job card and holds the phone up. The office prints
 * the sheet when a driver's battery is the thing they do not want to depend
 * on. And the link can be copied for the times a driver is reached some other
 * way — a stand-in covering at short notice who is not the one the job was
 * sent to.
 */
export function NameBoardPanel({
  token,
  jobId,
  passengerName,
}: {
  token: string;
  jobId: string;
  passengerName: string;
}) {
  const path = nameBoardPath(token);

  return (
    <div className="mt-6 border-t pt-4" data-testid="name-board-panel">
      <p className="text-sm font-medium">Name board</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {/* The name, quoted, because this is the last chance to notice a typo
            before it is held up in an arrivals hall. */}
        Shows <span className="font-medium text-foreground">{passengerName}</span>{' '}
        and nothing else. The driver gets this link with the job.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          {/* A new tab, and `noreferrer` so the board carries nothing of the
              dashboard with it if the link is passed on from there. */}
          <Link href={path} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            Open the board
          </Link>
        </Button>

        <Button asChild variant="outline" size="sm">
          <Link href={`/api/jobs/${jobId}/name-board`} target="_blank" rel="noreferrer">
            <Printer aria-hidden />
            Print it
          </Link>
        </Button>

        <CopyLink path={path} />
      </div>
    </div>
  );
}
