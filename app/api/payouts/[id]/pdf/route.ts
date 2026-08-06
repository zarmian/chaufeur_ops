import { withErrorHandling } from '@/lib/api';
import { requireCapability } from '@/lib/authz';
import { absoluteLogoSrc } from '@/lib/invoice-pdf';
import { payoutStatementHtml } from '@/lib/payout-pdf';
import { tryRenderPdf } from '@/lib/pdf';

/**
 * `GET /api/payouts/:id/pdf` — the driver statement, spec 4.5.5.
 *
 * Rendered on demand from the stored payout rather than from a file saved
 * when it was drafted, so a statement can never disagree with the payout it
 * describes.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    await requireCapability('viewInvoices');
    const { id } = await context.params;

    const html = await payoutStatementHtml(id, {
      logoSrc: await absoluteLogoSrc(request.url),
    });

    if (!html) return new Response('No such payout', { status: 404 });

    const rendered = await tryRenderPdf(html);
    if (!rendered.ok) {
      // 503 rather than 500: nothing is wrong with the payout, and the
      // printable version at `/document` works regardless.
      return new Response(rendered.message, {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response(new Uint8Array(rendered.pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="statement-${id}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  },
);
