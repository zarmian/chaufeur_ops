import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/authz';
import { PdfTextError } from '@/lib/job-sheets/pdf';
import { storeSheet } from '@/lib/job-sheets/store';
import { ForbiddenError, UnauthenticatedError } from '@/lib/permissions';
import { StorageNotConfiguredError, StorageValidationError } from '@/lib/storage';

/**
 * `POST /api/job-sheets/upload` — read an agency's PDF and go to the form.
 *
 * Through the server rather than browser-to-Blob like a compliance document,
 * because the point is not to keep the file: it is to read it. The bytes have
 * to reach `pdfToText` either way, and routing them via storage first would
 * mean an upload, a download and a second round trip before anybody sees a
 * filled-in form.
 *
 * That puts a job sheet under a function's request body limit, which a scanned
 * certificate would exceed. A job sheet does not: it is a one-page text PDF,
 * typically under 200 KB, and anything heavy enough to be a problem is a scan
 * with no text in it — refused for that reason with a message that says so.
 *
 * Nothing here decides what the sheet says. It authenticates, hands the bytes
 * to `lib/job-sheets`, and chooses which page the operator lands on.
 *
 * CSRF is handled upstream: this is not a public prefix, so `middleware.ts`
 * has already refused any unsafe method whose Origin does not match the host.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Larger than any real job sheet, smaller than a function's body limit.
 *
 * Checked here as well as by the storage layer so that an oversized file is
 * refused with something an operator can act on, rather than by the platform
 * with a bare 413 and no page.
 */
const MAX_SHEET_BYTES = 4 * 1024 * 1024;

/** Back to the upload page, saying what went wrong. */
function refuse(request: Request, message: string): NextResponse {
  const back = new URL('/jobs/sheet', request.url);
  back.searchParams.set('error', message);

  return NextResponse.redirect(back, { status: 303 });
}

export async function POST(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    const user = await requireCapability('editJobs');
    userId = user.id;
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
    }
    if (error instanceof ForbiddenError) {
      return refuse(request, error.message);
    }
    throw error;
  }

  const form = await request.formData();
  const file = form.get('sheet');

  if (!(file instanceof File) || file.size === 0) {
    return refuse(request, 'Choose a PDF job sheet to upload.');
  }
  if (file.size > MAX_SHEET_BYTES) {
    return refuse(
      request,
      'That file is too large to be a job sheet. A job sheet is one page of text; ' +
        'a file this size is usually a scan, which has no text to read.',
    );
  }

  let stored;
  try {
    stored = await storeSheet({
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name,
      mimeType: file.type || 'application/pdf',
      uploadedById: userId,
    });
  } catch (error) {
    // The reader's own refusals are written for the operator — a scan, an
    // encrypted file, something that is not a PDF at all.
    if (error instanceof PdfTextError) return refuse(request, error.message);

    /*
     * An install with no Blob store. Said rather than thrown, because the
     * sheet was read perfectly well and the only thing missing is somewhere to
     * keep the file — which is a deployment setting, not a bad upload, and an
     * error boundary with a stack trace tells the operator none of that.
     */
    if (error instanceof StorageNotConfiguredError) {
      return refuse(
        request,
        'The sheet was read, but there is nowhere to keep the file: this ' +
          'install has no document storage configured. A job sheet is kept ' +
          'against the job it books, so the upload has been stopped.',
      );
    }
    if (error instanceof StorageValidationError) return refuse(request, error.message);

    throw error;
  }

  /*
   * Where to go next, in order of what the operator most needs to know.
   *
   * A sheet already seen comes first, because booking the same journey twice
   * sends two cars and no amount of correct reading afterwards undoes that.
   * An unknown sender comes next: the job could be booked without one, but it
   * would have no account on it and so could never be invoiced, which is the
   * whole reason an agency's sheet is worth reading.
   */
  if (stored.duplicateOf) {
    return NextResponse.redirect(
      new URL(`/jobs/sheet/${stored.id}?seen=${stored.duplicateOf.id}`, request.url),
      { status: 303 },
    );
  }

  if (!stored.sender) {
    return NextResponse.redirect(
      new URL(`/jobs/sheet/${stored.id}`, request.url),
      { status: 303 },
    );
  }

  return NextResponse.redirect(
    new URL(`/jobs/new?sheet=${stored.id}`, request.url),
    { status: 303 },
  );
}
