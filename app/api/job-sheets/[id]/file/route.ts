import { NextResponse } from 'next/server';
import { apiError, withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { getSignedUrl } from '@/lib/storage';

/**
 * Hand out a short-lived link to one job sheet.
 *
 * The same arrangement as a compliance document: the caller is authenticated
 * first, then redirected to a URL scoped to this one object, this one
 * operation and fifteen minutes. The file is never public and never proxied
 * through this server, so a link copied out of the address bar stops working
 * almost immediately.
 *
 * `viewJobs` rather than `viewDriverDocuments`. A job sheet carries a
 * passenger's name and often their mobile — which is no more than the job
 * record beside it already shows — and none of the identity documents that
 * make a driver's file more sensitive than the work it covers.
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
    const sheet = await prisma.jobSheet.findUnique({
      where: { id },
      select: { fileKey: true },
    });
    if (!sheet) return apiError('NOT_FOUND', 'No such job sheet');

    const url = await getSignedUrl(sheet.fileKey);

    return NextResponse.redirect(url, { status: 302 });
  },
);
