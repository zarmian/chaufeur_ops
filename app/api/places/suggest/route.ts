import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { suggestPlaces } from '@/lib/places/store';
import { worthAsking } from '@/lib/places/types';

/**
 * `GET /api/places/suggest` — address suggestions.
 *
 * Proxied rather than called from the browser, because a Places key in the
 * browser is a key anybody can spend and the bill arrives regardless of who
 * spent it. Spec 4.8.6.9.
 *
 * A query too short to mean anything is refused here as well as in the
 * browser: the debounce is a courtesy, and this is the control.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (request: Request) => {
  await requireCapability('editJobs');

  const params = new URL(request.url).searchParams;
  const query = (params.get('q') ?? '').trim();

  if (!worthAsking(query)) {
    return NextResponse.json({ suggestions: [], provider: 'none', warning: null });
  }

  const result = await suggestPlaces(query, {
    ...(params.get('session') ? { sessionToken: params.get('session')! } : {}),
  });

  return NextResponse.json(result, {
    // Never cached at the edge: the saved-locations half is per-install data
    // and changes as soon as somebody books.
    headers: { 'Cache-Control': 'no-store' },
  });
});
