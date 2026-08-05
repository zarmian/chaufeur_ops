import { NextResponse } from 'next/server';
import { apiError, withErrorHandling } from '@/lib/api';
import { getBranding } from '@/lib/branding-store';
import { getSignedUrl } from '@/lib/storage';

/**
 * Serve a branding asset — the logos and the favicon.
 *
 * Unauthenticated on purpose, and the only place in the application that is.
 * The logo appears on the login page, which by definition nobody has a
 * session for, and the favicon is fetched by the browser before any cookie is
 * in play. A company logo is not a secret; a driving licence is, which is why
 * the document route next door checks a capability and this one does not.
 *
 * Still served through a signed URL rather than made public, so the Blob
 * store keeps one access model rather than two.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIELDS = ['logoLightUrl', 'logoDarkUrl', 'faviconUrl'] as const;
type AssetField = (typeof FIELDS)[number];

function isAssetField(value: string): value is AssetField {
  return (FIELDS as readonly string[]).includes(value);
}

export const GET = withErrorHandling(async (request: Request): Promise<Response> => {
  const field = new URL(request.url).searchParams.get('field') ?? '';
  if (!isAssetField(field)) {
    return apiError('VALIDATION_FAILED', 'Unknown branding asset');
  }

  const branding = await getBranding();
  const key = branding[field];
  if (!key) return apiError('NOT_FOUND', 'That asset has not been uploaded');

  // An hour rather than fifteen minutes: this is fetched on every page load
  // by every user, and it is a logo.
  const url = await getSignedUrl(key, 60 * 60);
  return NextResponse.redirect(url, { status: 302 });
});
