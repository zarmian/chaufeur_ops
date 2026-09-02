import { BrandMark } from '@/components/brand-mark';
import { getBranding } from '@/lib/branding-store';

/**
 * What a passenger sees when the link no longer works.
 *
 * Scoped to `/track` because the application's own not-found page offers
 * "Back to dashboard", and the person holding a dead tracking link has no
 * dashboard, no account and no idea what one is. Being invited into an admin
 * application is a worse answer than the 404 itself.
 *
 * One message for every reason. The link may never have existed, may have
 * been reissued after being forwarded to the wrong person, or may simply be a
 * day past its journey — and saying which would tell somebody working through
 * guesses that they had found a real one.
 *
 * Branded, and offering the office, because the useful next step for a real
 * passenger is a phone number rather than an explanation.
 */
export default async function TrackingNotFound() {
  const branding = await getBranding();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 p-6 text-center">
      <BrandMark branding={branding} imageClassName="h-8" />

      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          This link is no longer available
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Tracking links stop working a few hours after the journey. If you are
          expecting a car, the office can help.
        </p>
      </div>

      {branding.phone ? (
        <a href={`tel:${branding.phone}`} className="text-sm underline">
          {branding.phone}
        </a>
      ) : branding.supportEmail ? (
        <a
          href={`mailto:${branding.supportEmail}`}
          className="text-sm underline"
        >
          {branding.supportEmail}
        </a>
      ) : null}
    </main>
  );
}
