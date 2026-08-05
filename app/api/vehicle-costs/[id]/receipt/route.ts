import { NextResponse } from 'next/server';
import { apiError, withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { getVehicleCost } from '@/lib/fleet';
import { getSignedUrl } from '@/lib/storage';

/**
 * Hand out a short-lived link to one cost's receipt.
 *
 * The same shape as `app/api/documents/[id]/url/route.ts`, and for the same
 * reason: the object is never public and never proxied through this server.
 * The caller is authorised first, then redirected to a URL scoped to this one
 * object, this one operation and fifteen minutes.
 *
 * Guarded by `viewInvoices` rather than `viewJobs` — a garage invoice carries
 * what the company pays its suppliers, which is finance's business and not
 * every dispatcher's.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(
  async (
    _request: Request,
    context: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    await requireCapability('viewInvoices');

    const { id } = await context.params;
    const cost = await getVehicleCost(id);
    if (!cost) return apiError('NOT_FOUND', 'No such cost');
    if (!cost.receiptFileKey) {
      return apiError('NOT_FOUND', 'No receipt was filed against that cost');
    }

    const url = await getSignedUrl(cost.receiptFileKey);

    // 302 rather than JSON: the browser follows it straight to the file, so
    // the signed URL never has to be handled by client code.
    return NextResponse.redirect(url, { status: 302 });
  },
);
