import { notFound } from 'next/navigation';
import { BrandMark } from '@/components/brand-mark';
import { getBranding } from '@/lib/branding-store';
import { formatDateTime } from '@/lib/dates';
import { getLocaleConfig } from '@/lib/locale-store';
import { resolveTracking } from '@/lib/tracking-store';
import { AutoRefresh } from './auto-refresh';

/**
 * Where a passenger finds out whether their car is coming.
 *
 * The most common inbound call any chauffeur office takes is "where is my
 * car", and it is almost always asked by somebody who has no way of finding
 * out. This is that way.
 *
 * Outside `(dashboard)`, so it carries none of the application's chrome and
 * requires no session. The 24-byte token in the path is the whole credential.
 * What may appear here is decided in `lib/tracking.ts` and tested there — the
 * short version is: enough to stop somebody ringing, and nothing a forwarded
 * link should not carry.
 *
 * Branded, because a passenger who opens an unbranded page assumes they have
 * been phished. That is the one respect in which this page has to look like
 * the company rather than like a tool.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your journey',
  // A tracking link forwarded into a group chat should not be indexed, and a
  // referrer carrying the token should not follow the passenger off the page.
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
};

export default async function TrackingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [page, branding, locale] = await Promise.all([
    resolveTracking(token),
    getBranding(),
    getLocaleConfig(),
  ]);

  // One answer for a made-up token, a reissued one, and a link outside its
  // window. Telling them apart is what would let somebody with a guess find
  // out whether they guessed right.
  if (!page) notFound();

  const { view } = page;
  const when = formatDateTime(page.scheduledAt, {
    locale: locale.locale,
    timeZone: locale.timeZone,
  });

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 p-6">
      {view.live ? <AutoRefresh /> : null}

      <header className="flex items-center justify-between gap-4">
        <BrandMark branding={branding} imageClassName="h-8" />
        <span className="tabular text-muted-foreground text-xs">
          {page.reference}
        </span>
      </header>

      <section className="rounded-lg border p-5">
        <h1 className="text-2xl font-semibold tracking-tight">
          {view.headline}
        </h1>
        {view.detail ? (
          <p className="text-muted-foreground mt-2 text-sm">{view.detail}</p>
        ) : null}

        {view.showEta && page.eta ? (
          <p className="mt-4 text-lg font-medium" data-testid="tracking-eta">
            About {page.eta.phrase} away
          </p>
        ) : null}

        {/*
          Said out loud when there is no estimate but the page would otherwise
          look as though it were about to give one. Silence reads as a page
          that has failed; this reads as a page being straight.
        */}
        {view.showEta && !page.eta ? (
          <p className="text-muted-foreground mt-4 text-sm">
            We cannot see your driver’s position at the moment.
          </p>
        ) : null}
      </section>

      {view.driverName || view.vehicle ? (
        <section className="rounded-lg border p-5" data-testid="tracking-car">
          <h2 className="text-muted-foreground text-xs tracking-wide uppercase">
            Your car
          </h2>
          {view.driverName ? (
            <p className="mt-1 font-medium">{view.driverName}</p>
          ) : null}
          {view.vehicle ? (
            <p className="text-muted-foreground mt-0.5 text-sm">
              {view.vehicle}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-lg border p-5">
        <h2 className="text-muted-foreground text-xs tracking-wide uppercase">
          Journey
        </h2>
        <dl className="mt-2 space-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Pickup</dt>
            <dd>{page.pickupText}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Destination</dt>
            <dd>{page.dropoffText}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Booked for</dt>
            <dd className="tabular">{when}</dd>
          </div>
        </dl>
      </section>

      {branding.phone || branding.supportEmail ? (
        <footer className="text-muted-foreground text-center text-sm">
          Need us?{' '}
          {branding.phone ? (
            <a href={`tel:${branding.phone}`} className="underline">
              {branding.phone}
            </a>
          ) : (
            <a href={`mailto:${branding.supportEmail}`} className="underline">
              {branding.supportEmail}
            </a>
          )}
        </footer>
      ) : null}
    </main>
  );
}
