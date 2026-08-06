import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { resolvePlace } from '@/lib/places/store';

/**
 * `POST /api/places/resolve` — turn a chosen suggestion into an address.
 *
 * Closes the Google session, so the keystrokes that led here are billed
 * together with this one lookup rather than one at a time.
 *
 * Also where the place becomes a saved `Location` (spec 4.8.6.6) and where
 * its postcode is resolved to a zone (4.8.6.7), so the booking form gets
 * everything it needs from one call.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async (request: Request) => {
  await requireCapability('editJobs');

  const body = (await request.json()) as { id?: string; session?: string };
  const id = String(body.id ?? '').trim();

  if (id === '') {
    return NextResponse.json({ message: 'Nothing was chosen.' }, { status: 400 });
  }

  const detail = await resolvePlace(id, {
    ...(body.session ? { sessionToken: body.session } : {}),
  });

  if (!detail) {
    return NextResponse.json(
      { message: 'That address could not be looked up. Type it in and carry on.' },
      { status: 404 },
    );
  }

  return NextResponse.json(detail, { headers: { 'Cache-Control': 'no-store' } });
});
