import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { absoluteLogoSrc } from '@/lib/invoice-pdf';
import { payoutStatementHtml } from '@/lib/payout-pdf';

/**
 * `GET /api/payouts/:id/document` — the statement as a printable page.
 *
 * The same markup the PDF is rendered from, served on its own so it can be
 * checked before sending and printed from the browser on a deployment
 * without headless Chromium.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    await requireCapability('viewInvoices');
    const { id } = await context.params;

    const html = await payoutStatementHtml(id, {
      logoSrc: await absoluteLogoSrc(request.url),
    });

    if (!html) return new Response('No such payout', { status: 404 });

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  },
);
