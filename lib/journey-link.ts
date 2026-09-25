import { absoluteUrl } from './app-url';
import { getBranding } from './branding-store';
import {
  getClientMessagingConfig,
  journeyLink,
  messageClient,
} from './client-messaging';
import { prisma } from './prisma';
import { DRIVER_SHOWN_HOURS } from './tracking';
import { issueTrackingToken } from './tracking-store';

/**
 * Sending the client their tracking link, two hours before the pickup.
 *
 * Two hours rather than at booking because that is when the page has something
 * to say. Before then it withholds the driver and the car on purpose — the
 * crew can still change — so a link tapped into "your driver will appear here
 * later" is a link nobody taps a second time, and the one moment it matters
 * most is the one they will have stopped checking.
 *
 * It is also when the message box opens, which is the other half of what the
 * link is for: from here until the journey ends the client can put a message
 * on their driver's phone without either of them learning the other's number.
 */

export interface JourneyLinkRun {
  /** Jobs whose link went out on this run. */
  sent: string[];
  /** Jobs that were due one and did not get it, and why. */
  skipped: Array<{ reference: string; reason: string }>;
}

/**
 * How far back the sweep looks.
 *
 * The cron runs every few minutes, so anything two hours out is picked up
 * almost immediately. The window behind that exists for the runs that do not
 * happen — a deploy, an outage, a schedule that slipped — and it is bounded
 * because a link sent eleven minutes before the car arrives is still worth
 * having and one sent as the passenger gets in is not.
 */
const LATE_BY_MINUTES = 90;

/**
 * Send the link for every job that is due one.
 *
 * Deliberately narrow about what "due" means. A job with no client has nobody
 * to send to; one with no driver would open a page that still says "your
 * driver will be confirmed", which is exactly the disappointment this timing
 * exists to avoid; and a cancelled or finished job has nothing to follow.
 *
 * Each send is recorded on the job before anything else can run, so a cron
 * that overlaps itself — or is retried after a timeout — cannot text the same
 * client twice. That is the failure worth designing against: a duplicate
 * message about a car is the kind of thing a client forwards to the office
 * with a question mark.
 */
export async function sendDueJourneyLinks(
  now: Date = new Date(),
): Promise<JourneyLinkRun> {
  const run: JourneyLinkRun = { sent: [], skipped: [] };

  const opensAt = new Date(
    now.getTime() + DRIVER_SHOWN_HOURS * 3_600_000,
  );
  const floor = new Date(opensAt.getTime() - LATE_BY_MINUTES * 60_000);

  const due = await prisma.job.findMany({
    where: {
      journeyLinkSentAt: null,
      scheduledAt: { lte: opensAt, gte: floor },
      status: { notIn: ['DRAFT', 'CANCELLED', 'COMPLETED', 'NO_SHOW'] },
      clientId: { not: null },
      driverId: { not: null },
    },
    select: {
      id: true,
      reference: true,
      clientId: true,
      scheduledAt: true,
      pickupText: true,
      dropoffText: true,
    },
    orderBy: { scheduledAt: 'asc' },
    take: 200,
  });

  if (due.length === 0) return run;

  /*
   * The template's own switch, checked once before anything is claimed.
   *
   * `messageClient` would refuse each of these individually anyway, but by
   * then the job is marked as sent — so an install with the template off
   * would burn through every job's one chance and send nothing. Bailing here
   * leaves them all untouched for whenever it is switched on.
   */
  const config = await getClientMessagingConfig();
  if (!config.enabled.journey_link) return run;

  const branding = await getBranding();

  for (const job of due) {
    /*
     * Claimed before it is sent.
     *
     * `updateMany` with the null still in the filter, so two workers racing
     * this row have one of them come back having updated nothing — which is
     * how this stays a single message rather than a lock.
     */
    const claimed = await prisma.job.updateMany({
      where: { id: job.id, journeyLinkSentAt: null },
      data: { journeyLinkSentAt: now },
    });
    if (claimed.count === 0) continue;

    const token = await issueTrackingToken(job.id);
    const url = token ? absoluteUrl(`/track/${token}`) : null;

    if (!url) {
      /*
       * No APP_URL, or a job that cannot have a link.
       *
       * The claim is released so a later run can try again once the variable
       * is set — leaving it claimed would mean a misconfiguration silently
       * costing every client their link until somebody noticed.
       */
      await prisma.job.updateMany({
        where: { id: job.id },
        data: { journeyLinkSentAt: null },
      });
      run.skipped.push({
        reference: job.reference,
        reason: token ? 'APP_URL is not set, so there is no link to send' : 'no link',
      });
      continue;
    }

    const content = await journeyLink(
      {
        reference: job.reference,
        scheduledAt: job.scheduledAt,
        pickupText: job.pickupText,
        dropoffText: job.dropoffText,
        // Withheld on purpose, exactly as the page withholds them until this
        // moment: the message is the invitation, and the crew is on the page.
        driverName: null,
        driverPhone: null,
        vehicle: null,
      },
      branding.tradingName,
      url,
    );

    const outcome = await messageClient(job.clientId!, 'journey_link', content);

    if (outcome.sent > 0) {
      run.sent.push(job.reference);
    } else {
      run.skipped.push({
        reference: job.reference,
        reason: outcome.reason ?? 'nothing was sent',
      });
    }
  }

  return run;
}
