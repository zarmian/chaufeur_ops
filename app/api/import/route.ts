import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { runImport } from '@/lib/import';
import { isImportEntity } from '@/lib/import-schema';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { clientIpFrom } from '@/lib/rate-limit';

/**
 * `POST /api/import?entity=drivers` — load a spreadsheet.
 *
 * A plain multipart form post to a route handler, for the reason documented
 * in `app/api/jobs/[id]/status/route.ts`.
 *
 * The browser has already checked the file, but everything is validated again
 * here. The preview is a courtesy; this is the control.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ten megabytes of CSV is roughly 100,000 rows — far past any real fleet. */
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  const url = new URL(request.url);
  const entity = url.searchParams.get('entity') ?? '';
  const query = new URLSearchParams();

  if (!isImportEntity(entity)) {
    return apiError('VALIDATION_FAILED', 'Unknown import type');
  }

  try {
    const user = await requireCapability('manageSettings');
    const audit = { userId: user.id, ip: clientIpFrom(await headers()) };

    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof File) || file.size === 0) {
      query.set('importError', 'Choose a CSV file to import');
    } else if (file.size > MAX_BYTES) {
      query.set(
        'importError',
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB — split it and import in parts.`,
      );
    } else {
      const summary = await runImport(
        entity,
        await file.text(),
        file.name,
        audit,
      );

      // The counts ride back on the URL rather than in a store: the result of
      // an import is small, and a refreshable link to it is more useful than
      // a flash message that vanishes.
      query.set('created', String(summary.created));
      query.set('updated', String(summary.updated));
      query.set('skipped', String(summary.skipped));
      query.set('problems', String(summary.errors.length));
      query.set('file', file.name.slice(0, 120));
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return apiError('UNAUTHENTICATED', 'Please sign in again');
    }
    if (error instanceof ForbiddenError) {
      return apiError('FORBIDDEN', error.message);
    }
    query.set(
      'importError',
      error instanceof Error
        ? error.message.slice(0, 300)
        : 'That file could not be imported',
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `/settings/import/${entity}?${query.toString()}` },
  });
}
