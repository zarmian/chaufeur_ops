import { NextResponse } from 'next/server';
import { apiError, withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { getDocument } from '@/lib/documents';
import { getSignedUrl } from '@/lib/storage';

/**
 * Hand out a short-lived link to one document.
 *
 * The file is never public and never proxied through this server. The caller
 * is authenticated and authorised first, then redirected to a URL scoped to
 * this one object, this one operation, and fifteen minutes. A link copied out
 * of the address bar stops working almost immediately, which is the point
 * when the object is somebody's driving licence.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(
  async (
    _request: Request,
    context: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    await requireCapability('viewJobs');

    const { id } = await context.params;
    const document = await getDocument(id);
    if (!document) return apiError('NOT_FOUND', 'No such document');

    const url = await getSignedUrl(document.fileKey);

    // 302 rather than JSON: the browser follows it straight to the file, so
    // the signed URL never has to be handled by client code.
    return NextResponse.redirect(url, { status: 302 });
  },
);
